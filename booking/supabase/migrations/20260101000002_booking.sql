-- 002 Booking core: audit log, appointments, assignments, holds, status machine, DB-level conflict prevention.

-- ---------------------------------------------------------------------------------------------
-- Request context. The application sets these with set_config(..., true) at the start of every
-- transaction (see src/lib/db/tx.ts). Triggers read them to attribute history and audit rows.
-- ---------------------------------------------------------------------------------------------
create or replace function ctx(key text) returns text language sql stable as
$$ select nullif(current_setting('app.' || key, true), '') $$;

create table audit_logs (
  id bigint generated always as identity primary key,
  organisation_id uuid,
  occurred_at timestamptz not null default now(),
  actor_user_id uuid,
  actor_kind text not null default 'system',   -- user | system | customer | whatsapp | job
  action text not null,                        -- e.g. appointments.update, auth.login, privacy.export
  entity_type text not null,
  entity_id text,
  before_data jsonb,
  after_data jsonb,
  reason text,
  request_id text
);
create index audit_logs_entity_idx on audit_logs(organisation_id, entity_type, entity_id, occurred_at desc);
create index audit_logs_time_idx on audit_logs(organisation_id, occurred_at desc);

create or replace function audit_logs_immutable() returns trigger language plpgsql as $$
begin
  perform bk_raise('BK009', 'audit_logs is append-only');
  return null;
end $$;
create trigger audit_logs_no_update before update or delete on audit_logs
  for each row execute function audit_logs_immutable();

-- Generic row audit. Args: mode ('full' | 'keys'), then columns to exclude.
--   full : stores changed columns (update) or the full row (insert/delete), minus excluded columns
--   keys : stores only the NAMES of changed columns (for tables holding personal data)
create or replace function audit_row() returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_mode text := coalesce(tg_argv[0], 'full');
  v_excl text[] := coalesce(tg_argv[1:array_length(tg_argv, 1)], '{}');
  v_old jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) - v_excl end;
  v_new jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) - v_excl end;
  v_before jsonb; v_after jsonb; v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  if tg_op = 'UPDATE' then
    select jsonb_object_agg(n.key, n.value), jsonb_object_agg(n.key, o.value)
      into v_after, v_before
      from jsonb_each(v_new) n
      join jsonb_each(v_old) o using (key)
     where n.value is distinct from o.value and n.key not in ('updated_at','version','updated_by');
    if v_after is null then return null; end if;      -- nothing meaningful changed
  else
    v_before := v_old; v_after := v_new;
  end if;
  if v_mode = 'keys' then
    v_before := null;
    v_after := (select to_jsonb(coalesce(array_agg(k), '{}')) from jsonb_object_keys(coalesce(v_after, v_before, '{}'::jsonb)) k);
  end if;
  insert into audit_logs(organisation_id, actor_user_id, actor_kind, action, entity_type, entity_id, before_data, after_data, reason, request_id)
  values ((v_row->>'organisation_id')::uuid, ctx('user_id')::uuid, coalesce(ctx('actor'), 'system'),
          tg_table_name || '.' || lower(tg_op), tg_table_name, coalesce(v_row->>'id', v_row->>'user_id'),
          v_before, v_after, ctx('audit_reason'), ctx('request_id'));
  return null;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Status machine (single list; mirrored in src/lib/domain/status.ts and cross-checked by a test).
-- ---------------------------------------------------------------------------------------------
create table appointment_status_transitions (
  from_status text not null,
  to_status text not null,
  primary key (from_status, to_status)
);
insert into appointment_status_transitions values
  ('draft','slot_held'), ('draft','pending_confirmation'), ('draft','confirmed'), ('draft','cancelled_by_business'),
  ('slot_held','pending_confirmation'), ('slot_held','confirmed'), ('slot_held','expired'),
  ('slot_held','cancelled_by_customer'), ('slot_held','cancelled_by_business'),
  ('pending_confirmation','confirmed'), ('pending_confirmation','expired'),
  ('pending_confirmation','cancelled_by_customer'), ('pending_confirmation','cancelled_by_business'),
  ('confirmed','checked_in'), ('confirmed','in_progress'), ('confirmed','completed'), ('confirmed','no_show'),
  ('confirmed','cancelled_by_customer'), ('confirmed','cancelled_by_business'),
  ('confirmed','replacement_pending'), ('confirmed','rescheduled'),
  ('checked_in','in_progress'), ('checked_in','cancelled_by_customer'), ('checked_in','cancelled_by_business'),
  ('in_progress','completed'), ('in_progress','cancelled_by_business'),
  ('replacement_pending','confirmed'), ('replacement_pending','cancelled_by_customer'),
  ('replacement_pending','cancelled_by_business'), ('replacement_pending','rescheduled');

create table appointments (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  branch_id uuid not null references branches(id),
  customer_id uuid references customers(id),
  service_id uuid not null references services(id),
  kind text not null check (kind in ('service','trial','consultation')),
  source text not null check (source in ('web','whatsapp','phone','walk_in','staff_direct','manager')),
  status text not null default 'draft' check (status in (
    'draft','slot_held','pending_confirmation','confirmed','checked_in','in_progress','completed','no_show',
    'cancelled_by_customer','cancelled_by_business','replacement_pending','rescheduled','expired')),
  start_at timestamptz not null,
  end_at timestamptz not null,
  -- Snapshots: later edits to a service never rewrite history or KPI hours.
  buffer_before_minutes int not null default 0 check (buffer_before_minutes >= 0),
  buffer_after_minutes int not null default 0 check (buffer_after_minutes >= 0),
  counts_toward_kpi boolean not null default true,
  price_myr numeric(10,2),
  -- Set by trigger: [start - buffer_before, end + buffer_after). This is what conflict checks compare.
  occupied tstzrange not null,
  room_id uuid references rooms(id),
  staff_selection text not null default 'specific' check (staff_selection in ('specific','any')),
  preferred_staff_id uuid references staff_profiles(id),
  hold_expires_at timestamptz,
  -- Operational note only (never health information). Separate from anything sensitive.
  operational_note text check (operational_note is null or length(operational_note) <= 500),
  idempotency_key text,
  version int not null default 1,
  checked_in_at timestamptz, started_at timestamptz, completed_at timestamptz,
  actual_minutes int check (actual_minutes is null or actual_minutes between 1 and 720),
  cancelled_at timestamptz, cancel_reason text,
  rescheduled_from_id uuid references appointments(id),
  rescheduled_to_id uuid references appointments(id),
  created_by uuid, updated_by uuid,
  created_by_kind text not null default 'staff' check (created_by_kind in ('staff','customer','whatsapp','system')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at),
  check (status <> 'slot_held' or hold_expires_at is not null),
  check (status <> 'completed' or completed_at is not null),
  check (customer_id is not null or status in ('draft','slot_held','expired','cancelled_by_business'))
);
create unique index appointments_idem_uq on appointments(organisation_id, idempotency_key) where idempotency_key is not null;
create index appointments_time_idx on appointments(organisation_id, branch_id, start_at);
create index appointments_customer_idx on appointments(customer_id, start_at desc);
create index appointments_hold_idx on appointments(hold_expires_at) where status = 'slot_held';
create index appointments_status_idx on appointments(organisation_id, status, start_at);

-- Room double-booking: DB-enforced for every blocking status.
alter table appointments add constraint appointments_room_no_overlap
  exclude using gist (room_id with =, occupied with &&)
  where (room_id is not null and status in
    ('slot_held','pending_confirmation','confirmed','checked_in','in_progress','completed','replacement_pending'));

create table appointment_assignments (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  appointment_id uuid not null references appointments(id),
  staff_id uuid not null references staff_profiles(id),
  status text not null default 'active' check (status in ('active','superseded','released')),
  origin text not null default 'booking' check (origin in ('booking','manager_reassign','replacement')),
  occupied tstzrange not null,
  replacement_request_id uuid,                 -- FK added in migration 003
  -- Soft rules waived by a manager, always with a reason. Hard rules (double-booking, qualification, leave) cannot be waived.
  override_rules text[] not null default '{}' check (override_rules <@ array['working_hours','business_hours','break','min_notice','max_advance']),
  override_reason text,
  acknowledged_at timestamptz,                 -- staff has seen the newly assigned booking
  assigned_at timestamptz not null default now(),
  released_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(override_rules) = 0 or length(btrim(coalesce(override_reason, ''))) >= 5)
);
-- THE double-booking guarantee: one staff member cannot have two active assignments whose occupied ranges overlap.
alter table appointment_assignments add constraint assignments_staff_no_overlap
  exclude using gist (staff_id with =, occupied with &&) where (status = 'active');
create unique index assignments_one_active_per_appointment on appointment_assignments(appointment_id) where status = 'active';
create index assignments_staff_idx on appointment_assignments(staff_id, status);
create index assignments_appt_idx on appointment_assignments(appointment_id);

create table appointment_status_history (
  id bigint generated always as identity primary key,
  organisation_id uuid not null,
  appointment_id uuid not null references appointments(id),
  from_status text,
  to_status text not null,
  changed_by uuid,
  actor_kind text not null default 'system',
  reason text,
  changed_at timestamptz not null default now()
);
create index appointment_status_history_idx on appointment_status_history(appointment_id, changed_at);

create table slot_holds (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  appointment_id uuid not null unique references appointments(id),
  token_hash text not null unique,             -- sha256 of the secret returned to the browser
  status text not null default 'active' check (status in ('active','converted','expired','released')),
  expires_at timestamptz not null,
  idempotency_key text,
  created_at timestamptz not null default now()
);
create unique index slot_holds_idem_uq on slot_holds(organisation_id, idempotency_key) where idempotency_key is not null;

create table waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  branch_id uuid not null references branches(id),
  customer_id uuid not null references customers(id),
  service_id uuid not null references services(id),
  preferred_staff_id uuid references staff_profiles(id),
  window_start timestamptz not null,
  window_end timestamptz not null,
  status text not null default 'waiting' check (status in ('waiting','offered','booked','cancelled','expired')),
  notified_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (window_end > window_start)
);
create index waitlist_idx on waitlist_entries(organisation_id, status, window_start);

create table idempotency_keys (
  organisation_id uuid not null references organisations(id),
  scope text not null,
  key text not null,
  request_hash text not null,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (organisation_id, scope, key)
);

-- ---------------------------------------------------------------------------------------------
-- Appointment triggers
-- ---------------------------------------------------------------------------------------------
create or replace function appointments_before_write() returns trigger language plpgsql as $$
begin
  new.occupied := tstzrange(
    new.start_at - make_interval(mins => new.buffer_before_minutes),
    new.end_at + make_interval(mins => new.buffer_after_minutes), '[)');
  if tg_op = 'UPDATE' then
    if (new.start_at, new.end_at, new.service_id, new.organisation_id, new.branch_id, new.buffer_before_minutes,
        new.buffer_after_minutes, new.room_id) is distinct from
       (old.start_at, old.end_at, old.service_id, old.organisation_id, old.branch_id, old.buffer_before_minutes,
        old.buffer_after_minutes, old.room_id) then
      perform bk_raise('BK006', 'Appointment time, service and room are immutable; reschedule creates a new appointment');
    end if;
    if old.customer_id is not null and new.customer_id is distinct from old.customer_id then
      perform bk_raise('BK006', 'Appointment customer cannot be changed once set');
    end if;
    if new.status is distinct from old.status then
      if not exists (select 1 from appointment_status_transitions t where t.from_status = old.status and t.to_status = new.status) then
        perform bk_raise('BK005', format('Invalid status transition %s -> %s', old.status, new.status));
      end if;
    end if;
    new.version := old.version + 1;
  end if;
  return new;
end $$;
create trigger appointments_before before insert or update on appointments
  for each row execute function appointments_before_write();
create trigger appointments_updated_at before update on appointments
  for each row execute function set_updated_at();

-- History + release assignments when an appointment stops blocking time.
create or replace function appointments_after_write() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into appointment_status_history(organisation_id, appointment_id, from_status, to_status, changed_by, actor_kind, reason)
    values (new.organisation_id, new.id, case when tg_op = 'INSERT' then null else old.status end, new.status,
            ctx('user_id')::uuid, coalesce(ctx('actor'), 'system'), ctx('status_reason'));
  end if;
  if tg_op = 'UPDATE' and new.status is distinct from old.status
     and new.status not in ('slot_held','pending_confirmation','confirmed','checked_in','in_progress','completed','replacement_pending') then
    update appointment_assignments set status = 'released', released_at = now(), updated_at = now()
     where appointment_id = new.id and status = 'active';
  end if;
  return null;
end $$;
create trigger appointments_after after insert or update on appointments
  for each row execute function appointments_after_write();

-- ---------------------------------------------------------------------------------------------
-- Assignment validation: serialised per staff member with an advisory lock so that availability
-- exceptions (leave, breaks) and bookings cannot interleave. Overlap with other BOOKINGS is
-- additionally enforced by the exclusion constraint above (works at any isolation level).
-- ---------------------------------------------------------------------------------------------
create or replace function assignments_validate() returns trigger language plpgsql security definer set search_path = public as $$
declare
  a appointments%rowtype;
  v_tz text;
  v_ls timestamp; v_le timestamp; v_wd int;
  v_blocking text[];
begin
  if new.status <> 'active' then return new; end if;

  select * into a from appointments where id = new.appointment_id;
  if a.id is null then perform bk_raise('BK006', 'Assignment requires an appointment'); end if;
  new.occupied := a.occupied;
  new.organisation_id := a.organisation_id;

  if cardinality(new.override_rules) > 0 and length(btrim(coalesce(new.override_reason, ''))) < 5 then
    perform bk_raise('BK008', 'An override requires a reason of at least 5 characters');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('staff:' || new.staff_id::text, 0));

  -- Qualification (hard rule) + staff must be active, same organisation
  if not exists (
      select 1 from staff_services ss join staff_profiles sp on sp.id = ss.staff_id
       where ss.staff_id = new.staff_id and ss.service_id = a.service_id
         and sp.active and sp.archived_at is null and sp.organisation_id = a.organisation_id) then
    perform bk_raise('BK001', 'Staff member is not qualified (or not active) for this service');
  end if;

  select timezone into v_tz from branches where id = a.branch_id;
  v_ls := a.start_at at time zone v_tz;
  v_le := a.end_at at time zone v_tz;
  v_wd := extract(isodow from v_ls)::int;

  if not ('working_hours' = any (new.override_rules)) then
    if v_ls::date <> v_le::date or not exists (
        select 1 from staff_working_hours w
         where w.staff_id = new.staff_id and w.status = 'approved' and w.weekday = v_wd
           and w.start_time <= v_ls::time and w.end_time >= v_le::time) then
      perform bk_raise('BK002', 'Outside the staff member''s approved working hours');
    end if;
  end if;

  if not ('business_hours' = any (new.override_rules)) then
    if v_ls::date <> v_le::date or not exists (
        select 1 from business_hours h
         where h.branch_id = a.branch_id and h.weekday = v_wd
           and h.open_time <= v_ls::time and h.close_time >= v_le::time) then
      perform bk_raise('BK004', 'Outside branch business hours');
    end if;
  end if;

  -- Approved leave / breaks / blocked time / closures overlapping the occupied range
  select array_agg(distinct e.kind) into v_blocking
    from availability_exceptions e
   where e.status = 'approved' and e.period && a.occupied
     and (e.staff_id = new.staff_id or (e.staff_id is null and e.branch_id = a.branch_id));
  if v_blocking is not null then
    if exists (select 1 from unnest(v_blocking) k where k <> 'break') or not ('break' = any (new.override_rules)) then
      perform bk_raise('BK003', 'Staff member is unavailable (' || array_to_string(v_blocking, ', ') || ')');
    end if;
  end if;
  return new;
end $$;
create trigger assignments_validate_trg before insert or update of status, staff_id on appointment_assignments
  for each row execute function assignments_validate();
create trigger assignments_updated_at before update on appointment_assignments
  for each row execute function set_updated_at();

-- A new approved exception may not be placed over an existing active booking: resolve the booking first.
create or replace function exceptions_validate() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status <> 'approved' then return new; end if;
  if new.staff_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('staff:' || new.staff_id::text, 0));
    if exists (select 1 from appointment_assignments g where g.staff_id = new.staff_id and g.status = 'active' and g.occupied && new.period) then
      perform bk_raise('BK007', 'Existing bookings overlap this period; reassign or cancel them first');
    end if;
  else
    if exists (select 1 from appointment_assignments g join appointments a on a.id = g.appointment_id
                where a.branch_id = new.branch_id and g.status = 'active' and g.occupied && new.period) then
      perform bk_raise('BK007', 'Existing bookings overlap this period; reassign or cancel them first');
    end if;
  end if;
  return new;
end $$;
create trigger exceptions_validate_trg before insert or update of status, period, staff_id on availability_exceptions
  for each row execute function exceptions_validate();
