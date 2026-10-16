-- 005 Row-level security.
--
-- Two database roles, selected per transaction with SET LOCAL ROLE (see src/lib/db/tx.ts):
--   booking_staff  : RLS-enforced context for a logged-in staff member (user id / staff id / roles from set_config).
--   booking_system : trusted server code (public booking flow, WhatsApp webhook, jobs). Tenant-scoped only.
-- Customers never connect to the database. Their access is mediated by server code that verifies a signed
-- manage-link / OTP and then queries ONLY that customer's rows.
--
-- Least privilege: administrator has no policies on customers/appointments/messages. Admin-facing views
-- expose webhook and notification status WITHOUT payloads.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'booking_system') then create role booking_system nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'booking_staff') then create role booking_staff nologin; end if;
  execute format('grant booking_system, booking_staff to %I', current_user);
end $$;

create or replace function app_org() returns uuid language sql stable as $$ select ctx('org_id')::uuid $$;
create or replace function app_user() returns uuid language sql stable as $$ select ctx('user_id')::uuid $$;
create or replace function app_staff() returns uuid language sql stable as $$ select ctx('staff_id')::uuid $$;
create or replace function app_has_role(r text) returns boolean language sql stable as
$$ select coalesce(r = any (string_to_array(ctx('roles'), ',')), false) $$;

grant usage on schema public to booking_system, booking_staff;
grant select, insert, update, delete on all tables in schema public to booking_system;
grant select, insert, update on all tables in schema public to booking_staff;
revoke update, delete on audit_logs from booking_system, booking_staff;
revoke insert on audit_logs from booking_staff;
revoke insert, update, delete on roles, appointment_status_transitions from booking_system, booking_staff;
revoke all on users from booking_staff;
grant select (id, organisation_id, email, display_name, phone_e164, status, must_change_password, last_login_at, created_at, updated_at, created_by, updated_by)
  on users to booking_staff;
grant update (display_name, status, must_change_password, updated_by) on users to booking_staff;
grant execute on all functions in schema public to booking_system, booking_staff;

-- Enable RLS everywhere (a test asserts no public table is left without it).
do $$ declare r record; begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table %I enable row level security', r.tablename);
  end loop;
end $$;

-- 1) booking_system: tenant isolation on every table that has organisation_id.
do $$ declare r record; begin
  for r in select c.table_name from information_schema.columns c
            join pg_tables t on t.tablename = c.table_name and t.schemaname = 'public'
           where c.table_schema = 'public' and c.column_name = 'organisation_id'
             and c.table_name not in ('organisations','audit_logs') loop
    execute format('create policy sys_tenant on %I for all to booking_system using (organisation_id = app_org()) with check (organisation_id = app_org())', r.table_name);
  end loop;
end $$;
create policy sys_read on organisations for select to booking_system, booking_staff using (true);
create policy sys_audit_read on audit_logs for select to booking_system using (organisation_id = app_org());
create policy sys_audit_insert on audit_logs for insert to booking_system with check (organisation_id = app_org());
-- Tables with no organisation column: access limited to the owning user's rows by id in server code.
create policy sys_sessions on sessions for all to booking_system using (true) with check (true);
create policy sys_rate on rate_limits for all to booking_system using (true) with check (true);
create policy ref_roles on roles for select to booking_system, booking_staff using (true);
create policy ref_transitions on appointment_status_transitions for select to booking_system, booking_staff using (true);

-- 2) booking_staff: role-based policies.
-- Reference/config tables: any staff role reads its organisation; managers write.
do $$ declare t text; begin
  foreach t in array array['branches','rooms','resources','services','staff_services','business_hours','staff_profiles','kpi_definitions','application_settings'] loop
    execute format('create policy staff_read on %I for select to booking_staff using (organisation_id = app_org())', t);
    execute format('create policy mgr_write on %I for all to booking_staff using (organisation_id = app_org() and app_has_role(''manager'')) with check (organisation_id = app_org() and app_has_role(''manager''))', t);
  end loop;
end $$;
create policy admin_settings_write on application_settings for all to booking_staff
  using (organisation_id = app_org() and app_has_role('administrator'))
  with check (organisation_id = app_org() and app_has_role('administrator'));

-- Users and role assignments
create policy users_read on users for select to booking_staff
  using (organisation_id = app_org() and (id = app_user() or app_has_role('manager') or app_has_role('administrator')));
create policy users_write on users for update to booking_staff
  using (organisation_id = app_org() and (app_has_role('manager') or app_has_role('administrator')))
  with check (organisation_id = app_org());
create policy user_roles_read on user_roles for select to booking_staff
  using (organisation_id = app_org() and (user_id = app_user() or app_has_role('manager') or app_has_role('administrator')));
create policy user_roles_write on user_roles for all to booking_staff
  using (organisation_id = app_org() and (app_has_role('manager') or app_has_role('administrator')))
  with check (organisation_id = app_org() and (app_has_role('manager') or app_has_role('administrator')));

-- Customers: managers see all; a masseuse sees only customers she has (or had) an appointment with. Administrators: none.
create policy customers_read on customers for select to booking_staff
  using (organisation_id = app_org() and (
    app_has_role('manager') or (app_has_role('masseuse') and exists (
      select 1 from appointments a join appointment_assignments g on g.appointment_id = a.id
       where a.customer_id = customers.id and g.staff_id = app_staff()))));
create policy customers_insert on customers for insert to booking_staff
  with check (organisation_id = app_org() and (app_has_role('manager') or app_has_role('masseuse')));
create policy customers_update on customers for update to booking_staff
  using (organisation_id = app_org() and app_has_role('manager')) with check (organisation_id = app_org());
create policy consents_read on customer_consents for select to booking_staff
  using (organisation_id = app_org() and app_has_role('manager'));
create policy consents_insert on customer_consents for insert to booking_staff
  with check (organisation_id = app_org() and (app_has_role('manager') or app_has_role('masseuse')));

-- Appointments and assignments
create policy appt_read on appointments for select to booking_staff
  using (organisation_id = app_org() and (app_has_role('manager') or exists (
    select 1 from appointment_assignments g where g.appointment_id = appointments.id and g.staff_id = app_staff())));
create policy appt_insert on appointments for insert to booking_staff
  with check (organisation_id = app_org() and (app_has_role('manager') or (app_has_role('masseuse') and created_by = app_user())));
create policy appt_update on appointments for update to booking_staff
  using (organisation_id = app_org() and (app_has_role('manager') or exists (
    select 1 from appointment_assignments g where g.appointment_id = appointments.id and g.staff_id = app_staff() and g.status = 'active')))
  with check (organisation_id = app_org());
create policy assign_read on appointment_assignments for select to booking_staff
  using (organisation_id = app_org() and (app_has_role('manager') or staff_id = app_staff()));
create policy assign_insert on appointment_assignments for insert to booking_staff
  with check (organisation_id = app_org() and (app_has_role('manager') or staff_id = app_staff()));
create policy assign_update on appointment_assignments for update to booking_staff
  using (organisation_id = app_org() and (app_has_role('manager') or staff_id = app_staff()))
  with check (organisation_id = app_org());
create policy history_read on appointment_status_history for select to booking_staff
  using (organisation_id = app_org() and (app_has_role('manager') or exists (
    select 1 from appointment_assignments g where g.appointment_id = appointment_status_history.appointment_id and g.staff_id = app_staff())));

-- Time off and hours
create policy exc_read on availability_exceptions for select to booking_staff
  using (organisation_id = app_org() and (app_has_role('manager') or staff_id = app_staff() or staff_id is null));
create policy exc_mgr on availability_exceptions for all to booking_staff
  using (organisation_id = app_org() and app_has_role('manager')) with check (organisation_id = app_org() and app_has_role('manager'));
create policy exc_self_insert on availability_exceptions for insert to booking_staff
  with check (organisation_id = app_org() and staff_id = app_staff() and status = 'pending' and requested_by = app_user());
create policy exc_self_cancel on availability_exceptions for update to booking_staff
  using (organisation_id = app_org() and staff_id = app_staff() and status = 'pending')
  with check (organisation_id = app_org() and staff_id = app_staff() and status in ('pending','cancelled'));
create policy swh_read on staff_working_hours for select to booking_staff
  using (organisation_id = app_org() and (app_has_role('manager') or staff_id = app_staff()));
create policy swh_mgr on staff_working_hours for all to booking_staff
  using (organisation_id = app_org() and app_has_role('manager')) with check (organisation_id = app_org() and app_has_role('manager'));
create policy swh_self_insert on staff_working_hours for insert to booking_staff
  with check (organisation_id = app_org() and staff_id = app_staff() and status = 'pending' and requested_by = app_user());

-- Replacement workflow
create policy repl_read on replacement_requests for select to booking_staff
  using (organisation_id = app_org() and (app_has_role('manager') or requested_by_staff_id = app_staff() or nominee_staff_id = app_staff()));
create policy repl_insert on replacement_requests for insert to booking_staff
  with check (organisation_id = app_org() and (app_has_role('manager') or requested_by_staff_id = app_staff()));
create policy repl_update on replacement_requests for update to booking_staff
  using (organisation_id = app_org() and (app_has_role('manager') or requested_by_staff_id = app_staff() or nominee_staff_id = app_staff()))
  with check (organisation_id = app_org());
create policy repl_resp_read on replacement_responses for select to booking_staff
  using (organisation_id = app_org() and exists (select 1 from replacement_requests r where r.id = request_id
        and (app_has_role('manager') or r.requested_by_staff_id = app_staff() or r.nominee_staff_id = app_staff())));
create policy repl_resp_insert on replacement_responses for insert to booking_staff
  with check (organisation_id = app_org() and responder_user_id = app_user());

-- KPIs
create policy kpi_t_read on staff_kpi_targets for select to booking_staff
  using (organisation_id = app_org() and (app_has_role('manager') or staff_id = app_staff() or staff_id is null));
create policy kpi_t_write on staff_kpi_targets for all to booking_staff
  using (organisation_id = app_org() and app_has_role('manager')) with check (organisation_id = app_org() and app_has_role('manager'));
create policy kpi_r_read on kpi_results for select to booking_staff
  using (organisation_id = app_org() and (app_has_role('manager') or staff_id = app_staff()));

-- Manager-only operational data
do $$ declare t text; begin
  foreach t in array array['waitlist_entries','data_requests','whatsapp_contacts','whatsapp_conversations','whatsapp_messages','webhook_events','notification_jobs'] loop
    execute format('create policy mgr_all on %I for all to booking_staff using (organisation_id = app_org() and app_has_role(''manager'')) with check (organisation_id = app_org() and app_has_role(''manager''))', t);
  end loop;
end $$;
create policy templates_read on whatsapp_templates for select to booking_staff
  using (organisation_id = app_org() and (app_has_role('manager') or app_has_role('administrator')));
create policy templates_write on whatsapp_templates for all to booking_staff
  using (organisation_id = app_org() and (app_has_role('manager') or app_has_role('administrator')))
  with check (organisation_id = app_org() and (app_has_role('manager') or app_has_role('administrator')));
create policy audit_read on audit_logs for select to booking_staff
  using (organisation_id = app_org() and (app_has_role('manager') or app_has_role('administrator')));

-- Admin-facing operational views: no message bodies, phone numbers or payloads.
create view v_webhook_events_admin as
  select id, organisation_id, provider, status, attempts, last_error, received_at, processed_at
    from webhook_events
   where organisation_id = app_org() and (app_has_role('administrator') or app_has_role('manager'));
create view v_notification_jobs_admin as
  select id, organisation_id, purpose, recipient_kind, status, attempts, max_attempts, next_attempt_at, last_error, sent_at, created_at
    from notification_jobs
   where organisation_id = app_org() and (app_has_role('administrator') or app_has_role('manager'));
grant select on v_webhook_events_admin, v_notification_jobs_admin to booking_staff;

-- ---------------------------------------------------------------------------------------------
-- Narrow SECURITY DEFINER lookups used before an organisation context exists (login / session resolution).
-- ---------------------------------------------------------------------------------------------
create or replace function auth_find_user(p_email text)
returns table (id uuid, organisation_id uuid, display_name text, password_hash text, status text,
               failed_login_count int, locked_until timestamptz, must_change_password boolean)
language sql stable security definer set search_path = public as $$
  select u.id, u.organisation_id, u.display_name, u.password_hash, u.status, u.failed_login_count, u.locked_until, u.must_change_password
    from users u where lower(u.email) = lower(p_email)
$$;

create or replace function auth_resolve_session(p_token_hash text)
returns table (session_id uuid, user_id uuid, organisation_id uuid, display_name text, email text,
               staff_id uuid, branch_id uuid, roles text[], must_change_password boolean, expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select s.id, u.id, u.organisation_id, u.display_name, u.email, sp.id, sp.branch_id,
         coalesce((select array_agg(ur.role_code order by ur.role_code) from user_roles ur where ur.user_id = u.id), '{}'),
         u.must_change_password, s.expires_at
    from sessions s join users u on u.id = s.user_id
    left join staff_profiles sp on sp.user_id = u.id and sp.archived_at is null
   where s.token_hash = p_token_hash and s.expires_at > now() and u.status = 'active'
$$;
grant execute on function auth_find_user(text), auth_resolve_session(text) to booking_system;
revoke execute on function auth_find_user(text), auth_resolve_session(text) from booking_staff, public;
