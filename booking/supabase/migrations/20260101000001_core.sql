-- 001 Core: tenancy, identity, staff, customers, catalogue, working time.
-- Conventions: uuid PKs, timestamptz in UTC, organisation_id on every tenant table,
-- created_at/updated_at + created_by/updated_by, text+CHECK instead of PG enums (portable, easy to extend).

create extension if not exists btree_gist;

create or replace function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Helper that raises our own error codes (mapped to AppError in src/lib/db/errors.ts).
create or replace function bk_raise(code text, msg text) returns void language plpgsql as $$
begin
  raise exception using errcode = code, message = msg;
end $$;

create table organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  timezone text not null default 'Asia/Kuala_Lumpur',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table branches (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  name text not null,
  address text,
  timezone text not null default 'Asia/Kuala_Lumpur',
  active boolean not null default true,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index branches_org_idx on branches(organisation_id);

create table roles (
  code text primary key,
  description text not null
);
insert into roles(code, description) values
  ('customer',      'Public customer. Not a login account: access is via signed manage-link or WhatsApp OTP.'),
  ('masseuse',      'Staff member: own schedule, direct bookings, replacements, own KPIs.'),
  ('manager',       'Master schedule, assignments, approvals, configuration, reports, user management.'),
  ('administrator', 'Technical/config access: integrations, templates, audit review. No customer PII by default.');

create table users (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  email text not null,
  display_name text not null,
  password_hash text,                       -- scrypt$N$r$p$salt$hash ; null = invited, cannot log in yet
  status text not null default 'active' check (status in ('invited','active','disabled')),
  failed_login_count int not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  must_change_password boolean not null default false,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index users_email_uq on users (lower(email));
create index users_org_idx on users(organisation_id);

create table user_roles (
  user_id uuid not null references users(id) on delete cascade,
  role_code text not null references roles(code) check (role_code <> 'customer'),
  branch_id uuid references branches(id),
  organisation_id uuid not null references organisations(id),
  created_by uuid,
  created_at timestamptz not null default now(),
  primary key (user_id, role_code)
);

create table staff_profiles (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  branch_id uuid not null references branches(id),
  user_id uuid not null unique references users(id),
  display_name text not null,
  phone_e164 text,
  active boolean not null default true,
  can_take_direct_bookings boolean not null default true,
  kpi_reminders_enabled boolean not null default true,
  max_consecutive_minutes int check (max_consecutive_minutes is null or max_consecutive_minutes > 0),
  fairness_weight numeric(4,2) not null default 1 check (fairness_weight > 0),
  archived_at timestamptz,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index staff_profiles_org_idx on staff_profiles(organisation_id, branch_id) where archived_at is null;

create table customers (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  display_name text not null,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email text,
  preferred_staff_id uuid references staff_profiles(id),
  source text not null default 'web' check (source in ('web','whatsapp','phone','walk_in','staff_direct','manager')),
  -- Operational note only (e.g. "prefers quiet room"). Never put health information here.
  operational_note text check (operational_note is null or length(operational_note) <= 500),
  anonymised_at timestamptz,
  archived_at timestamptz,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index customers_phone_uq on customers(organisation_id, phone_e164) where anonymised_at is null;
create index customers_org_idx on customers(organisation_id);

create table customer_consents (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  customer_id uuid not null references customers(id),
  purpose text not null check (purpose in ('service_booking','whatsapp_messaging','marketing')),
  granted boolean not null,
  notice_version text not null,
  channel text not null check (channel in ('web','whatsapp','phone','walk_in','staff_direct','manager','system')),
  recorded_by uuid,
  recorded_at timestamptz not null default now()
);
create index customer_consents_idx on customer_consents(customer_id, purpose, recorded_at desc);

create table services (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  branch_id uuid references branches(id),   -- null = offered at every branch
  name text not null,
  description text,
  kind text not null default 'service' check (kind in ('service','trial','consultation')),
  duration_minutes int not null check (duration_minutes between 5 and 600),
  buffer_before_minutes int not null default 0 check (buffer_before_minutes between 0 and 120),
  buffer_after_minutes int not null default 0 check (buffer_after_minutes between 0 and 120),
  price_myr numeric(10,2) check (price_myr is null or price_myr >= 0),
  show_price boolean not null default false,
  online_bookable boolean not null default true,
  counts_toward_kpi boolean not null default true,
  requires_room boolean not null default false,
  active boolean not null default true,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index services_org_idx on services(organisation_id) where active;

create table staff_services (
  staff_id uuid not null references staff_profiles(id) on delete cascade,
  service_id uuid not null references services(id) on delete cascade,
  organisation_id uuid not null references organisations(id),
  primary key (staff_id, service_id)
);

create table rooms (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  branch_id uuid not null references branches(id),
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Generic bookable resources (equipment etc.). Enforced like rooms in phase two; table exists so the core engine need not change.
create table resources (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  branch_id uuid not null references branches(id),
  name text not null,
  kind text not null default 'equipment',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- weekday is ISO: 1 = Monday ... 7 = Sunday. Several rows per day are allowed (e.g. split shifts).
create table business_hours (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  branch_id uuid not null references branches(id),
  weekday smallint not null check (weekday between 1 and 7),
  open_time time not null,
  close_time time not null,
  check (close_time > open_time)
);
create index business_hours_idx on business_hours(branch_id, weekday);

-- Staff working hours need manager approval when changed by the staff member: rows carry a change batch.
create table staff_working_hours (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  staff_id uuid not null references staff_profiles(id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),
  start_time time not null,
  end_time time not null,
  status text not null default 'approved' check (status in ('approved','pending','rejected','superseded')),
  batch_id uuid not null default gen_random_uuid(),
  requested_by uuid, decided_by uuid, decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_time > start_time)
);
create index staff_working_hours_idx on staff_working_hours(staff_id, weekday) where status = 'approved';

-- Breaks, leave, blocked time, training/internal and branch closures. staff_id null = branch-wide.
create table availability_exceptions (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  branch_id uuid not null references branches(id),
  staff_id uuid references staff_profiles(id) on delete cascade,
  kind text not null check (kind in ('break','leave','blocked','training','internal','closure')),
  period tstzrange not null check (not isempty(period) and lower_inc(period) and not upper_inc(period)),
  -- Keep reasons generic ("annual leave"); do not record medical detail.
  reason text check (reason is null or length(reason) <= 200),
  status text not null default 'approved' check (status in ('pending','approved','rejected','cancelled')),
  requested_by uuid, decided_by uuid, decided_at timestamptz,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (staff_id is not null or kind in ('closure','blocked'))
);
create index availability_exceptions_staff_idx on availability_exceptions using gist (staff_id, period) where status = 'approved';
create index availability_exceptions_branch_idx on availability_exceptions using gist (branch_id, period) where status = 'approved' and staff_id is null;

do $$ declare t text; begin
  foreach t in array array['organisations','branches','users','staff_profiles','customers','services','rooms','resources','staff_working_hours','availability_exceptions'] loop
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', t || '_updated_at', t);
  end loop;
end $$;
