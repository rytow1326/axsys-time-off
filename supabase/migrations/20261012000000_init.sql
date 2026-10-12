-- =====================================================================
-- Axsys Dental Solutions — Time Off system
-- Initial schema: profiles, absence types, time-off entries,
-- notifications, audit log, email log, security (RLS), email triggers.
-- =====================================================================

create extension if not exists pg_net with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------
create type public.user_role      as enum ('employee', 'manager');
create type public.request_status as enum ('pending', 'approved', 'denied', 'cancelled');

-- ---------------------------------------------------------------------
-- Private settings (not exposed through the API)
--   notify_url    : https://<project-ref>.supabase.co/functions/v1/notify
--   notify_secret : long random string, same value as the NOTIFY_SECRET
--                   secret on the notify edge function
-- ---------------------------------------------------------------------
create table private.settings (
  key   text primary key,
  value text not null
);

-- ---------------------------------------------------------------------
-- Profiles (one per login)
-- ---------------------------------------------------------------------
create table public.profiles (
  id               uuid primary key references auth.users (id) on delete cascade,
  full_name        text not null,
  email            text not null,
  role             public.user_role not null default 'employee',
  annual_allowance numeric(5,1) not null default 10 check (annual_allowance >= 0),
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Absence types (editable list)
--   counts_toward_allowance : deducted from the yearly allowance
--   employee_requestable    : shows up in the employee app
-- ---------------------------------------------------------------------
create table public.absence_types (
  code                    text primary key,
  label                   text not null,
  counts_toward_allowance boolean not null default false,
  employee_requestable    boolean not null default true,
  color                   text not null default '#64748b',
  sort_order              int not null default 100
);

insert into public.absence_types (code, label, counts_toward_allowance, employee_requestable, color, sort_order) values
  ('pto',      'Vacation / PTO', true,  true,  '#1d5fbf', 1),
  ('sick',     'Sick Day',       false, false, '#c2410c', 2),
  ('personal', 'Personal Day',   true,  true,  '#7c3aed', 3),
  ('other',    'Other',          false, true,  '#64748b', 4);

-- ---------------------------------------------------------------------
-- Day math: weekdays only, half-day support
-- ---------------------------------------------------------------------
create or replace function public.business_days(
  p_start date, p_end date, p_start_half boolean default false, p_end_half boolean default false)
returns numeric
language sql immutable
set search_path = ''
as $$
  select case
    when p_start is null or p_end is null or p_end < p_start then 0::numeric
    when p_start = p_end then
      case when extract(isodow from p_start) >= 6 then 0::numeric
           when coalesce(p_start_half, false) or coalesce(p_end_half, false) then 0.5
           else 1::numeric end
    else
      (select count(*) from generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') d
        where extract(isodow from d) < 6)::numeric
      - case when coalesce(p_start_half, false) and extract(isodow from p_start) < 6 then 0.5 else 0 end
      - case when coalesce(p_end_half, false)   and extract(isodow from p_end)   < 6 then 0.5 else 0 end
  end
$$;

-- Days of an entry that fall inside a given calendar year
create or replace function public.days_in_year(
  p_start date, p_end date, p_start_half boolean, p_end_half boolean, p_year int)
returns numeric
language sql immutable
set search_path = ''
as $$
  select case
    when greatest(p_start, make_date(p_year, 1, 1)) > least(p_end, make_date(p_year, 12, 31)) then 0::numeric
    else public.business_days(
      greatest(p_start, make_date(p_year, 1, 1)),
      least(p_end,      make_date(p_year, 12, 31)),
      p_start_half and p_start >= make_date(p_year, 1, 1),
      p_end_half   and p_end   <= make_date(p_year, 12, 31))
  end
$$;

-- ---------------------------------------------------------------------
-- Time-off entries (employee requests AND manager-entered absences)
-- ---------------------------------------------------------------------
create table public.time_off (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references public.profiles (id) on delete cascade,
  absence_type  text not null references public.absence_types (code),
  start_date    date not null,
  end_date      date not null,
  start_half    boolean not null default false,  -- first day is a half day (or the single day)
  end_half      boolean not null default false,  -- last day is a half day
  days          numeric(5,1) generated always as
                  (public.business_days(start_date, end_date, start_half, end_half)) stored,
  notes         text check (char_length(notes) <= 2000),
  status        public.request_status not null default 'pending',
  source        text not null default 'employee' check (source in ('employee', 'manager')),
  review_note   text check (char_length(review_note) <= 2000),
  reviewed_by   uuid references public.profiles (id),
  reviewed_at   timestamptz,
  created_by    uuid references public.profiles (id),
  created_at    timestamptz not null default now(),
  updated_by    uuid references public.profiles (id),
  updated_at    timestamptz not null default now(),
  constraint time_off_dates_valid check (end_date >= start_date),
  constraint time_off_has_weekday check (public.business_days(start_date, end_date, start_half, end_half) > 0)
);

create index time_off_employee_idx on public.time_off (employee_id, start_date);
create index time_off_status_idx   on public.time_off (status);
create index time_off_dates_idx    on public.time_off (start_date, end_date);

-- ---------------------------------------------------------------------
-- In-app notifications (employee app shows these + a Windows toast)
-- ---------------------------------------------------------------------
create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  time_off_id uuid references public.time_off (id) on delete cascade,
  title       text not null,
  body        text not null,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

-- ---------------------------------------------------------------------
-- Audit log: every insert/update/delete on time_off and profiles
-- ---------------------------------------------------------------------
create table public.audit_log (
  id          bigint generated always as identity primary key,
  table_name  text not null,
  record_id   uuid,
  action      text not null,          -- INSERT / UPDATE / DELETE
  actor_id    uuid,                   -- null = system / SQL editor
  actor_name  text,
  at          timestamptz not null default now(),
  old_data    jsonb,
  new_data    jsonb
);
create index audit_log_record_idx on public.audit_log (record_id);
create index audit_log_at_idx     on public.audit_log (at desc);

-- ---------------------------------------------------------------------
-- Email delivery log (written by the notify edge function)
-- ---------------------------------------------------------------------
create table public.email_log (
  id           bigint generated always as identity primary key,
  event        text not null,
  time_off_id  uuid,
  recipient    text not null,
  subject      text,
  status       text not null,          -- sent / failed
  provider_id  text,
  error        text,
  created_at   timestamptz not null default now()
);

-- =====================================================================
-- Helper functions
-- =====================================================================
create or replace function public.is_manager()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'manager' and active
  )
$$;

-- Yearly summary. Security invoker: employees only ever see their own row,
-- managers see everyone (row-level security on profiles/time_off applies).
create or replace function public.year_summary(p_year int default extract(year from current_date)::int)
returns table (
  employee_id      uuid,
  full_name        text,
  email            text,
  active           boolean,
  annual_allowance numeric,
  pto_days         numeric,
  sick_days        numeric,
  personal_days    numeric,
  other_days       numeric,
  total_days       numeric,
  allowance_used   numeric,
  remaining        numeric,
  pending_days     numeric
)
language sql stable security invoker
set search_path = ''
as $$
  with d as (
    select t.employee_id, t.absence_type, t.status, at.counts_toward_allowance,
           public.days_in_year(t.start_date, t.end_date, t.start_half, t.end_half, p_year) as days
    from public.time_off t
    join public.absence_types at on at.code = t.absence_type
    where t.status in ('approved', 'pending')
      and t.start_date <= make_date(p_year, 12, 31)
      and t.end_date   >= make_date(p_year, 1, 1)
  )
  select p.id, p.full_name, p.email, p.active, p.annual_allowance,
    coalesce(sum(d.days) filter (where d.status = 'approved' and d.absence_type = 'pto'), 0),
    coalesce(sum(d.days) filter (where d.status = 'approved' and d.absence_type = 'sick'), 0),
    coalesce(sum(d.days) filter (where d.status = 'approved' and d.absence_type = 'personal'), 0),
    coalesce(sum(d.days) filter (where d.status = 'approved' and d.absence_type not in ('pto','sick','personal')), 0),
    coalesce(sum(d.days) filter (where d.status = 'approved'), 0),
    coalesce(sum(d.days) filter (where d.status = 'approved' and d.counts_toward_allowance), 0),
    p.annual_allowance - coalesce(sum(d.days) filter (where d.status = 'approved' and d.counts_toward_allowance), 0),
    coalesce(sum(d.days) filter (where d.status = 'pending'), 0)
  from public.profiles p
  left join d on d.employee_id = p.id
  group by p.id
  order by p.full_name
$$;

-- =====================================================================
-- New auth user -> profile row
-- =====================================================================
create or replace function private.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1)),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- =====================================================================
-- Business rules for time_off (runs before every insert/update)
-- =====================================================================
create or replace function private.time_off_guard()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_mgr boolean := public.is_manager();
  v_requestable boolean;
begin
  -- Direct SQL / service role (no logged-in user): trust it, just stamp times.
  if v_uid is null then
    if tg_op = 'UPDATE' then new.updated_at := now(); end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.created_by := v_uid;
    new.created_at := now();
    new.updated_by := null;
    new.updated_at := now();

    if not v_mgr then
      if new.employee_id is distinct from v_uid then
        raise exception 'You can only submit time off for yourself.';
      end if;
      select employee_requestable into v_requestable from public.absence_types where code = new.absence_type;
      if not coalesce(v_requestable, false) then
        raise exception 'That absence type can only be entered by a manager.';
      end if;
      new.status := 'pending';
      new.source := 'employee';
      new.review_note := null;
      new.reviewed_by := null;
      new.reviewed_at := null;
    else
      if new.status in ('approved', 'denied') then
        new.reviewed_by := v_uid;
        new.reviewed_at := now();
      end if;
    end if;

  else -- UPDATE
    new.id := old.id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.updated_by := v_uid;
    new.updated_at := now();

    if not v_mgr then
      if old.employee_id is distinct from v_uid then
        raise exception 'You can only change your own requests.';
      end if;
      if old.status <> 'pending' then
        raise exception 'Only pending requests can be changed. Contact your manager.';
      end if;
      if new.status not in ('pending', 'cancelled') then
        raise exception 'Only a manager can approve or deny requests.';
      end if;
      if new.employee_id is distinct from old.employee_id or new.source is distinct from old.source
         or new.reviewed_by is distinct from old.reviewed_by or new.reviewed_at is distinct from old.reviewed_at
         or new.review_note is distinct from old.review_note then
        raise exception 'Not allowed to change those fields.';
      end if;
      select employee_requestable into v_requestable from public.absence_types where code = new.absence_type;
      if not coalesce(v_requestable, false) then
        raise exception 'That absence type can only be entered by a manager.';
      end if;
    else
      if new.status is distinct from old.status and new.status in ('approved', 'denied') then
        new.reviewed_by := v_uid;
        new.reviewed_at := now();
      end if;
    end if;
  end if;

  if new.end_date < new.start_date then
    raise exception 'The end date is before the start date.';
  end if;
  if public.business_days(new.start_date, new.end_date, new.start_half, new.end_half) = 0 then
    raise exception 'The selected dates fall on a weekend — there are no workdays to take off.';
  end if;

  -- No overlapping active entries for the same person
  if new.status in ('pending', 'approved') and exists (
    select 1 from public.time_off t
    where t.employee_id = new.employee_id
      and t.id <> new.id
      and t.status in ('pending', 'approved')
      and t.start_date <= new.end_date
      and t.end_date   >= new.start_date
  ) then
    raise exception 'These dates overlap another pending or approved entry for this employee.';
  end if;

  return new;
end;
$$;

create trigger time_off_guard
  before insert or update on public.time_off
  for each row execute function private.time_off_guard();

-- Employees may not change role/allowance etc. (only managers can update
-- profiles through RLS); keep updated_at fresh and protect the last manager.
create or replace function private.profiles_guard()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  new.id := old.id;
  new.created_at := old.created_at;
  new.updated_at := now();
  if old.role = 'manager' and (new.role <> 'manager' or not new.active)
     and not exists (select 1 from public.profiles
                     where role = 'manager' and active and id <> old.id) then
    raise exception 'At least one active manager is required.';
  end if;
  return new;
end;
$$;

create trigger profiles_guard
  before update on public.profiles
  for each row execute function private.profiles_guard();

-- =====================================================================
-- Audit trail
-- =====================================================================
create or replace function private.write_audit()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_name text;
begin
  if v_uid is not null then
    select full_name into v_name from public.profiles where id = v_uid;
  end if;
  insert into public.audit_log (table_name, record_id, action, actor_id, actor_name, old_data, new_data)
  values (
    tg_table_name,
    coalesce((case when tg_op = 'DELETE' then old.id else new.id end), null),
    tg_op,
    v_uid,
    coalesce(v_name, 'System'),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$$;

create trigger time_off_audit
  after insert or update or delete on public.time_off
  for each row execute function private.write_audit();

create trigger profiles_audit
  after update on public.profiles
  for each row execute function private.write_audit();

-- =====================================================================
-- Notifications + email (fires after the change is saved)
-- =====================================================================
create or replace function private.send_notify(p_event text, p_time_off_id uuid, p_extra jsonb default '{}'::jsonb)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
begin
  select value into v_url    from private.settings where key = 'notify_url';
  select value into v_secret from private.settings where key = 'notify_secret';
  if v_url is null or v_secret is null then
    raise warning 'Email not configured: add notify_url and notify_secret to private.settings';
    return;
  end if;
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', v_secret),
    body    := jsonb_build_object('event', p_event, 'time_off_id', p_time_off_id) || p_extra,
    timeout_milliseconds := 10000
  );
end;
$$;

create or replace function private.time_off_events()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_label text;
  v_range text;
begin
  if tg_op = 'INSERT' then
    if new.status = 'pending' then
      perform private.send_notify('request_submitted', new.id);
    end if;
    return new;
  end if;

  -- UPDATE
  select label into v_label from public.absence_types where code = new.absence_type;
  v_range := case when new.start_date = new.end_date then to_char(new.start_date, 'Mon DD, YYYY')
                  else to_char(new.start_date, 'Mon DD') || ' – ' || to_char(new.end_date, 'Mon DD, YYYY') end;

  if old.status = 'pending' and new.status in ('approved', 'denied') then
    insert into public.notifications (user_id, time_off_id, title, body)
    values (new.employee_id, new.id,
            'Time off ' || new.status::text,
            v_label || ', ' || v_range || ' (' || new.days || ' day' || case when new.days = 1 then '' else 's' end || ') was '
              || new.status::text || '.' || coalesce(' Note: ' || nullif(new.review_note, ''), ''));
    perform private.send_notify('request_reviewed', new.id);

  elsif old.status = 'pending' and new.status = 'cancelled' then
    perform private.send_notify('request_cancelled', new.id);

  elsif old.status = 'pending' and new.status = 'pending'
        and (new.start_date, new.end_date, new.start_half, new.end_half, new.absence_type, coalesce(new.notes, ''))
            is distinct from
            (old.start_date, old.end_date, old.start_half, old.end_half, old.absence_type, coalesce(old.notes, '')) then
    perform private.send_notify('request_modified', new.id, jsonb_build_object(
      'previous', jsonb_build_object('start_date', old.start_date, 'end_date', old.end_date,
                                     'days', old.days, 'absence_type', old.absence_type, 'notes', old.notes)));
  end if;
  return new;
end;
$$;

create trigger time_off_events
  after insert or update on public.time_off
  for each row execute function private.time_off_events();

-- =====================================================================
-- Row-level security
-- =====================================================================
alter table public.profiles      enable row level security;
alter table public.absence_types enable row level security;
alter table public.time_off      enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_log     enable row level security;
alter table public.email_log     enable row level security;

-- profiles
create policy "profiles: read own or manager" on public.profiles
  for select to authenticated using (id = (select auth.uid()) or (select public.is_manager()));
create policy "profiles: managers update" on public.profiles
  for update to authenticated using ((select public.is_manager())) with check ((select public.is_manager()));

-- absence types
create policy "types: everyone reads" on public.absence_types
  for select to authenticated using (true);
create policy "types: managers manage" on public.absence_types
  for all to authenticated using ((select public.is_manager())) with check ((select public.is_manager()));

-- time_off
create policy "time_off: read own or manager" on public.time_off
  for select to authenticated using (employee_id = (select auth.uid()) or (select public.is_manager()));
create policy "time_off: insert own or manager" on public.time_off
  for insert to authenticated with check (employee_id = (select auth.uid()) or (select public.is_manager()));
create policy "time_off: update own pending or manager" on public.time_off
  for update to authenticated
  using ((employee_id = (select auth.uid()) and status = 'pending') or (select public.is_manager()))
  with check (employee_id = (select auth.uid()) or (select public.is_manager()));
create policy "time_off: managers delete" on public.time_off
  for delete to authenticated using ((select public.is_manager()));

-- notifications
create policy "notifications: read own" on public.notifications
  for select to authenticated using (user_id = (select auth.uid()));
create policy "notifications: mark own read" on public.notifications
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- logs: managers read only (writes happen in security-definer triggers / service role)
create policy "audit: managers read" on public.audit_log
  for select to authenticated using ((select public.is_manager()));
create policy "email_log: managers read" on public.email_log
  for select to authenticated using ((select public.is_manager()));

-- Tighten table privileges (RLS is the main gate; this is belt and braces)
revoke all on public.profiles, public.absence_types, public.time_off,
              public.notifications, public.audit_log, public.email_log from anon;
revoke insert, delete on public.profiles from authenticated;
revoke insert, update, delete on public.audit_log, public.email_log from authenticated;
revoke insert, delete on public.notifications from authenticated;
revoke execute on function public.year_summary(int) from anon;

-- =====================================================================
-- Realtime: both apps update live
-- =====================================================================
alter publication supabase_realtime add table public.time_off, public.notifications;
