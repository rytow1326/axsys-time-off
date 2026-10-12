-- Self sign-up + approval tests (run after db_tests.sql)
\set ON_ERROR_STOP on
reset role;
delete from net.calls;

-- Domain rule ---------------------------------------------------------------
select t_expect_error($$insert into auth.users (email, raw_user_meta_data) values ('hacker@gmail.com', '{"first_name":"Eve","last_name":"X"}')$$,
  'sign-up from a non-axsysinc.com email is rejected');
select t_expect_error($$insert into auth.users (email, raw_user_meta_data) values ('eve@axsysinc.com.evil.com', '{}')$$,
  'look-alike domain is rejected');
select t_assert((select count(*) from public.profiles where email like '%gmail%') = 0, 'no profile created for rejected sign-up');

-- Self sign-up --------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000d1', 'Dana.Lee@AxsysInc.com', '{"first_name":" Dana ","last_name":"Lee"}');
select t_assert((select first_name || '|' || last_name || '|' || full_name from public.profiles where id = '00000000-0000-0000-0000-0000000000d1') = 'Dana|Lee|Dana Lee',
  'first and last name stored (and trimmed); full name built from them');
select t_assert((select approved from public.profiles where id = '00000000-0000-0000-0000-0000000000d1') = false, 'self sign-up starts as waiting for approval');
select t_assert((select count(*) from net.calls where body->>'event' = 'user_signed_up' and body->>'profile_id' = '00000000-0000-0000-0000-0000000000d1') = 1,
  'manager is notified about the new sign-up');

-- Trying to self-approve via sign-up metadata does nothing
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000d2', 'sneaky@axsysinc.com', '{"first_name":"Sam","last_name":"Sneak","approved":true,"created_by_manager":true,"role":"manager"}');
select t_assert((select approved::text || role::text from public.profiles where id = '00000000-0000-0000-0000-0000000000d2') = 'falseemployee',
  'user-supplied metadata cannot self-approve or become manager');

-- Manager-created account (server-only app_metadata) ------------------------
delete from net.calls;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000000d3', 'mgr.made@axsysinc.com', '{"first_name":"Pat","last_name":"Made"}', '{"created_by_manager":true}');
select t_assert((select approved from public.profiles where id = '00000000-0000-0000-0000-0000000000d3'), 'manager-created account is approved immediately');
select t_assert((select count(*) from net.calls where body->>'event' = 'user_signed_up') = 0, 'no sign-up email for manager-created accounts');

-- Pending account can't request time off ------------------------------------
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000d1';
select t_assert((select count(*) from public.profiles) = 1, 'pending employee can see their own profile (for the waiting screen)');
select t_expect_error($$insert into public.time_off (employee_id, absence_type, start_date, end_date)
  values ('00000000-0000-0000-0000-0000000000d1', 'pto', '2026-11-16', '2026-11-16')$$,
  'pending account cannot submit time off');
update public.profiles set approved = true, annual_allowance = 50 where id = '00000000-0000-0000-0000-0000000000d1';
reset role;
select t_assert((select not approved and annual_allowance = 10 from public.profiles where id = '00000000-0000-0000-0000-0000000000d1'),
  'pending employee cannot approve themselves or change their days');
set role authenticated;

-- Manager approves and sets days ---------------------------------------------
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select t_assert((select count(*) from public.profiles where not approved) = 2, 'manager sees accounts waiting for approval');
update public.profiles set approved = true, annual_allowance = 12.5 where id = '00000000-0000-0000-0000-0000000000d1';
update public.profiles set annual_allowance = 18 where email = 'bob@axsysinc.com';
select t_assert((select annual_allowance from public.profiles where email = 'bob@axsysinc.com') = 18, 'manager can set any employee''s yearly days');
update public.profiles set first_name = 'Danielle' where id = '00000000-0000-0000-0000-0000000000d1';
select t_assert((select full_name from public.profiles where id = '00000000-0000-0000-0000-0000000000d1') = 'Danielle Lee', 'renaming updates the full name');

-- Now the employee can submit, and sees the allowance -------------------------
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000d1';
insert into public.time_off (employee_id, absence_type, start_date, end_date) values ('00000000-0000-0000-0000-0000000000d1', 'pto', '2026-11-16', '2026-11-17');
select t_assert((select status from public.time_off where employee_id = '00000000-0000-0000-0000-0000000000d1') = 'pending', 'approved employee can submit requests');
select t_assert((select annual_allowance from public.year_summary(2026)) = 12.5, 'employee sees the days the manager set');
reset role;

-- Audit trail covers approvals
select t_assert((select count(*) from public.audit_log where table_name = 'profiles' and record_id = '00000000-0000-0000-0000-0000000000d1'
                 and new_data->>'approved' = 'true' and actor_name = 'Ryan T') >= 1, 'approval is recorded in the activity log');

\o
\echo ALL SIGN-UP TESTS PASSED
