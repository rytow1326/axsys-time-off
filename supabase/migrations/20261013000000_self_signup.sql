-- =====================================================================
-- Self sign-up for @axsysinc.com staff, with manager approval
-- =====================================================================

-- Names + approval flag ------------------------------------------------
alter table public.profiles
  add column if not exists first_name text,
  add column if not exists last_name  text,
  add column if not exists approved   boolean not null default false;

-- Everyone who existed before this change was created by a manager
update public.profiles set approved = true;
update public.profiles
   set first_name = coalesce(first_name, split_part(full_name, ' ', 1)),
       last_name  = coalesce(last_name, nullif(substr(full_name, length(split_part(full_name, ' ', 1)) + 2), ''));

-- Which email domain may create accounts (change here if it ever changes)
insert into private.settings (key, value) values ('allowed_email_domain', 'axsysinc.com')
on conflict (key) do nothing;

-- Block sign-ups from other domains, at the database level ---------------
create or replace function private.check_new_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_domain text;
begin
  select value into v_domain from private.settings where key = 'allowed_email_domain';
  if v_domain is not null and lower(coalesce(new.email, '')) not like '%@' || lower(v_domain) then
    raise exception 'Only @% email addresses can create an account.', v_domain;
  end if;
  return new;
end;
$$;

drop trigger if exists check_new_user on auth.users;
create trigger check_new_user
  before insert on auth.users
  for each row execute function private.check_new_user();

-- New login -> profile (now with first/last name, not yet approved) ------
create or replace function private.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_first text := nullif(trim(new.raw_user_meta_data ->> 'first_name'), '');
  v_last  text := nullif(trim(new.raw_user_meta_data ->> 'last_name'), '');
  v_full  text;
  -- app_metadata can only be set server-side (the admin-users function), never by the person signing up
  v_by_manager boolean := coalesce((new.raw_app_meta_data ->> 'created_by_manager')::boolean, false);
begin
  v_full := coalesce(
    nullif(trim(concat_ws(' ', v_first, v_last)), ''),
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    split_part(new.email, '@', 1));
  insert into public.profiles (id, full_name, first_name, last_name, email, approved)
  values (new.id, v_full, coalesce(v_first, split_part(v_full, ' ', 1)), v_last, new.email, v_by_manager)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Keep full_name in step when a manager edits first/last name -------------
create or replace function private.profiles_guard()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  new.id := old.id;
  new.created_at := old.created_at;
  new.updated_at := now();
  if (new.first_name, new.last_name) is distinct from (old.first_name, old.last_name)
     and coalesce(new.first_name, '') <> '' then
    new.full_name := trim(concat_ws(' ', new.first_name, new.last_name));
  end if;
  if old.role = 'manager' and (new.role <> 'manager' or not new.active)
     and not exists (select 1 from public.profiles
                     where role = 'manager' and active and id <> old.id) then
    raise exception 'At least one active manager is required.';
  end if;
  return new;
end;
$$;

-- Unapproved accounts can't submit time off ------------------------------
create or replace function private.require_approved()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and not public.is_manager() and not exists (
    select 1 from public.profiles where id = auth.uid() and approved and active
  ) then
    raise exception 'Your account is waiting for approval from your manager.';
  end if;
  return new;
end;
$$;

drop trigger if exists time_off_require_approved on public.time_off;
create trigger time_off_require_approved
  before insert or update on public.time_off
  for each row execute function private.require_approved();

-- Tell the manager when someone signs up ----------------------------------
create or replace function private.profile_signup_event()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
begin
  if new.approved then return new; end if;
  select value into v_url    from private.settings where key = 'notify_url';
  select value into v_secret from private.settings where key = 'notify_secret';
  if v_url is null or v_secret is null then return new; end if;
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', v_secret),
    body    := jsonb_build_object('event', 'user_signed_up', 'profile_id', new.id),
    timeout_milliseconds := 10000);
  return new;
end;
$$;

drop trigger if exists profile_signup_event on public.profiles;
create trigger profile_signup_event
  after insert on public.profiles
  for each row execute function private.profile_signup_event();

-- Audit profile creation too
drop trigger if exists profiles_audit on public.profiles;
create trigger profiles_audit
  after insert or update on public.profiles
  for each row execute function private.write_audit();

-- Employee app updates live when its account is approved
do $$ begin
  alter publication supabase_realtime add table public.profiles;
exception when duplicate_object then null;
end $$;
