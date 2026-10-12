-- Behaviour tests for the time-off schema. Run with tests/run-db-tests.sh
\set ON_ERROR_STOP on
\set QUIET on

create or replace function public.t_assert(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'FAIL: %', msg; end if;
  raise notice 'ok  - %', msg;
end $$;
grant execute on function public.t_assert(boolean, text) to authenticated;

-- expect_error: runs SQL as the current role and asserts it raises
create or replace function public.t_expect_error(sql text, msg text) returns void language plpgsql as $$
begin
  execute sql;
  raise exception 'FAIL: expected an error: %', msg;
exception when others then
  if sqlerrm like 'FAIL:%' then raise; end if;
  raise notice 'ok  - % (blocked: %)', msg, sqlerrm;
end $$;
grant execute on function public.t_expect_error(text, text) to authenticated;

insert into private.settings values
  ('notify_url', 'https://example.supabase.co/functions/v1/notify'),
  ('notify_secret', 'test-secret');

-- Users -------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', 'ryant@axsysinc.com', '{"full_name":"Ryan T"}'),
  ('00000000-0000-0000-0000-00000000000b', 'alice@axsysinc.com', '{"full_name":"Alice Employee"}'),
  ('00000000-0000-0000-0000-00000000000c', 'bob@axsysinc.com',   '{}');
update public.profiles set approved = true;  -- these test users were 'approved' by a manager
update public.profiles set role = 'manager' where email = 'ryant@axsysinc.com';
update public.profiles set annual_allowance = 15 where email = 'alice@axsysinc.com';

select t_assert((select count(*) from public.profiles) = 3, 'profile rows created automatically for new logins');
select t_assert((select full_name from public.profiles where email = 'bob@axsysinc.com') = 'bob', 'name falls back to email prefix');

-- Day math ------------------------------------------------------------
select t_assert(business_days('2026-10-12', '2026-10-16') = 5,   'Mon–Fri = 5 days');
select t_assert(business_days('2026-10-16', '2026-10-19') = 2,   'Fri–Mon skips the weekend = 2 days');
select t_assert(business_days('2026-10-14', '2026-10-14', true, false) = 0.5, 'single half day = 0.5');
select t_assert(business_days('2026-10-12', '2026-10-14', true, true) = 2,   'Mon(half)–Wed(half) = 2');
select t_assert(business_days('2026-10-17', '2026-10-18') = 0,   'weekend only = 0');
select t_assert(days_in_year('2026-12-30', '2027-01-04', false, false, 2026) = 2, 'year-crossing: 2 days in 2026');
select t_assert(days_in_year('2026-12-30', '2027-01-04', false, true, 2027) = 1.5, 'year-crossing: 1.5 days in 2027 (half last day)');

-- Alice (employee) ----------------------------------------------------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';

insert into public.time_off (employee_id, absence_type, start_date, end_date, notes, status)
values ('00000000-0000-0000-0000-00000000000b', 'pto', '2026-11-02', '2026-11-06', 'Family trip', 'approved');
select t_assert((select status from public.time_off where notes = 'Family trip') = 'pending',
                'employee cannot self-approve on submit (forced to pending)');
select t_assert((select days from public.time_off where notes = 'Family trip') = 5, 'days computed automatically');

select t_expect_error($$insert into public.time_off (employee_id, absence_type, start_date, end_date)
  values ('00000000-0000-0000-0000-00000000000c', 'pto', '2026-12-01', '2026-12-01')$$,
  'employee cannot submit for someone else');
select t_expect_error($$insert into public.time_off (employee_id, absence_type, start_date, end_date)
  values ('00000000-0000-0000-0000-00000000000b', 'sick', '2026-12-01', '2026-12-01')$$,
  'employee cannot enter sick days (manager only)');
select t_expect_error($$insert into public.time_off (employee_id, absence_type, start_date, end_date)
  values ('00000000-0000-0000-0000-00000000000b', 'pto', '2026-11-05', '2026-11-09')$$,
  'overlapping request rejected');
select t_expect_error($$insert into public.time_off (employee_id, absence_type, start_date, end_date)
  values ('00000000-0000-0000-0000-00000000000b', 'pto', '2026-10-17', '2026-10-18')$$,
  'weekend-only request rejected');
select t_expect_error($$update public.time_off set status = 'approved' where notes = 'Family trip'$$,
  'employee cannot approve own request');

update public.time_off set end_date = '2026-11-05' where notes = 'Family trip';
select t_assert((select days from public.time_off where notes = 'Family trip') = 4, 'employee can edit a pending request');

insert into public.time_off (employee_id, absence_type, start_date, end_date, start_half, notes)
values ('00000000-0000-0000-0000-00000000000b', 'personal', '2026-12-04', '2026-12-04', true, 'Dentist');
update public.time_off set status = 'cancelled' where notes = 'Dentist';

select t_assert((select count(*) from public.profiles) = 1, 'employee sees only their own profile');
select t_assert((select count(*) from public.audit_log) = 0, 'employee cannot read audit log');
select t_assert((select count(*) from public.email_log) = 0, 'employee cannot read email log');
update public.profiles set role = 'manager', annual_allowance = 99 where id = '00000000-0000-0000-0000-00000000000b';
reset role;
select t_assert((select role from public.profiles where email = 'alice@axsysinc.com') = 'employee'
                and (select annual_allowance from public.profiles where email = 'alice@axsysinc.com') = 15,
                'employee cannot promote self or change allowance');

-- Bob (employee) cannot see Alice -------------------------------------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
select t_assert((select count(*) from public.time_off) = 0, 'other employees cannot see Alice''s requests');
update public.time_off set notes = 'hacked';
select t_assert((select count(*) from public.notifications) = 0, 'Bob has no notifications');

-- Ryan (manager) ------------------------------------------------------
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select t_assert((select count(*) from public.time_off) = 2, 'manager sees all requests');
select t_assert((select count(*) from public.time_off where notes = 'hacked') = 0, 'Bob''s blind update changed nothing');

update public.time_off set status = 'approved', review_note = 'Enjoy!' where notes = 'Family trip';
select t_assert((select reviewed_by from public.time_off where notes = 'Family trip') = '00000000-0000-0000-0000-00000000000a',
                'approval records who approved');

insert into public.time_off (employee_id, absence_type, start_date, end_date, end_half, notes, status, source)
values ('00000000-0000-0000-0000-00000000000c', 'sick', '2026-10-07', '2026-10-08', true, 'Flu', 'approved', 'manager');
select t_assert((select days from public.time_off where notes = 'Flu') = 1.5, 'manager-entered sick days with half day');

insert into public.time_off (employee_id, absence_type, start_date, end_date, status, source)
values ('00000000-0000-0000-0000-00000000000b', 'pto', '2026-12-21', '2026-12-22', 'pending', 'employee');

select t_assert((select count(*) from public.year_summary(2026)) = 3, 'manager summary covers all employees');
select t_assert((select sick_days from public.year_summary(2026) where full_name = 'bob') = 1.5, 'sick days totalled');
select t_assert((select remaining from public.year_summary(2026) where full_name = 'bob') = 10, 'sick days do not reduce allowance');

-- Alice sees her result -------------------------------------------------
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
select t_assert((select count(*) from public.year_summary(2026)) = 1, 'employee summary is only their own row');
select t_assert((select pto_days from public.year_summary(2026)) = 4, 'approved PTO counted');
select t_assert((select pending_days from public.year_summary(2026)) = 2, 'pending shown separately');
select t_assert((select total_days from public.year_summary(2026)) = 4, 'pending does not count as taken');
select t_assert((select remaining from public.year_summary(2026)) = 11, 'remaining = 15 allowance - 4 used');
select t_assert((select count(*) from public.notifications) = 1, 'employee notified of approval');
update public.time_off set end_date = '2026-11-06' where notes = 'Family trip';
select t_assert((select end_date from public.time_off where notes = 'Family trip') = '2026-11-05',
                'employee cannot change an approved request');
delete from public.time_off where notes = 'Family trip';
select t_assert((select count(*) from public.time_off where notes = 'Family trip') = 1, 'employee cannot delete');

-- Manager corrections + audit -------------------------------------------
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
update public.time_off set end_date = '2026-10-09', end_half = false where notes = 'Flu';
select t_assert((select days from public.time_off where notes = 'Flu') = 3, 'manager can correct an entry');
delete from public.time_off where notes = 'Flu';
select t_assert((select count(*) from public.time_off where notes = 'Flu') = 0, 'manager can delete an entry');
select t_assert((select count(*) from public.audit_log where actor_name = 'Ryan T' and action = 'DELETE') = 1,
                'audit log records who deleted');
select t_assert((select count(*) from public.audit_log where actor_name = 'Alice Employee') >= 3,
                'audit log records employee edits');
select t_expect_error($$update public.profiles set role = 'employee' where email = 'ryant@axsysinc.com'$$,
  'last manager cannot demote themselves');
reset role;

-- Emails queued -----------------------------------------------------------
select t_assert((select count(*) from net.calls where body->>'event' = 'request_submitted') = 3, 'email queued for each new request');
select t_assert((select count(*) from net.calls where body->>'event' = 'request_modified') = 1, 'email queued when a pending request is edited');
select t_assert((select count(*) from net.calls where body->>'event' = 'request_cancelled') = 1, 'email queued when a request is cancelled');
select t_assert((select count(*) from net.calls where body->>'event' = 'request_reviewed') = 1, 'email queued to employee on approval');
select t_assert((select count(*) from net.calls where headers->>'x-notify-secret' = 'test-secret') = (select count(*) from net.calls),
                'every email call carries the shared secret');
select t_assert((select count(*) from net.calls where body ? 'previous' and body->'previous'->>'end_date' = '2026-11-06') = 1,
                'modified email includes the previous dates');

\o
\echo ALL TESTS PASSED
