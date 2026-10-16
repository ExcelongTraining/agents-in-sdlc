-- 003 Replacement workflow and KPI configuration/results.

create table replacement_requests (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  appointment_id uuid not null references appointments(id),
  original_assignment_id uuid not null references appointment_assignments(id),
  requested_by_staff_id uuid not null references staff_profiles(id),
  nominee_staff_id uuid references staff_profiles(id),
  reason text not null check (length(btrim(reason)) >= 3 and length(reason) <= 300),
  status text not null check (status in (
    'awaiting_nominee','awaiting_nomination','awaiting_manager_approval',
    'completed','declined','rejected','cancelled','expired','failed')),
  requires_manager_approval boolean not null default true,
  nominee_accepted_at timestamptz,
  decided_by uuid,                              -- manager user id
  decided_at timestamptz,
  decision_note text,
  resulting_assignment_id uuid references appointment_assignments(id),
  failure_reason text,
  expires_at timestamptz,
  version int not null default 1,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (nominee_staff_id is null or nominee_staff_id <> requested_by_staff_id)
);
-- At most one open request per appointment.
create unique index replacement_open_uq on replacement_requests(appointment_id)
  where status in ('awaiting_nominee','awaiting_nomination','awaiting_manager_approval');
create index replacement_nominee_idx on replacement_requests(nominee_staff_id, status);
create trigger replacement_requests_updated_at before update on replacement_requests
  for each row execute function set_updated_at();

alter table appointment_assignments
  add constraint assignments_replacement_fk foreign key (replacement_request_id) references replacement_requests(id);

create table replacement_responses (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  request_id uuid not null references replacement_requests(id),
  responder_user_id uuid not null references users(id),
  responder_staff_id uuid references staff_profiles(id),
  responder_role text not null check (responder_role in ('requester','nominee','manager')),
  decision text not null check (decision in ('nominate','accept','decline','approve','reject','cancel')),
  comment text check (comment is null or length(comment) <= 300),
  created_at timestamptz not null default now()
);
create index replacement_responses_idx on replacement_responses(request_id, created_at);

create table kpi_definitions (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  code text not null,
  name text not null,
  description text,
  metric text not null check (metric in (
    'completed_service_hours','scheduled_service_hours','consultation_hours','replacement_hours',
    'cancelled_hours','no_show_hours','utilisation_pct','completed_appointments',
    'first_time_clients','returning_clients')),
  period text not null check (period in ('day','week','month')),
  hours_basis text not null default 'scheduled' check (hours_basis in ('scheduled','actual')),
  active boolean not null default true,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, code)
);

-- staff_id null = default target for every active staff member; a staff-specific row overrides it.
create table staff_kpi_targets (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  kpi_definition_id uuid not null references kpi_definitions(id),
  staff_id uuid references staff_profiles(id),
  target_value numeric(10,2) not null check (target_value > 0),
  valid_from date not null,
  valid_to date,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from)
);
create index staff_kpi_targets_idx on staff_kpi_targets(kpi_definition_id, staff_id, valid_from);

-- Period snapshots (written by the close-period job). Live dashboards compute on demand from completed appointments.
create table kpi_results (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  staff_id uuid not null references staff_profiles(id),
  kpi_definition_id uuid not null references kpi_definitions(id),
  period_start date not null,
  period_end date not null,
  actual_value numeric(12,2) not null,
  target_value numeric(10,2),
  progress_pct numeric(7,2),
  inputs jsonb not null default '{}',           -- the numbers behind the formula, for explainability
  computed_at timestamptz not null default now(),
  unique (staff_id, kpi_definition_id, period_start)
);
