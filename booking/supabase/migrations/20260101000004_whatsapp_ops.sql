-- 004 WhatsApp, outbox, auth/session support, privacy workflow, settings.

create table whatsapp_contacts (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  wa_id text not null,                          -- WhatsApp user id (phone digits as sent by Meta)
  customer_id uuid references customers(id),
  profile_name text,
  opted_in_at timestamptz,
  opted_out_at timestamptz,
  last_inbound_at timestamptz,                  -- customer-service-window anchor (24h)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, wa_id)
);
create index whatsapp_contacts_customer_idx on whatsapp_contacts(customer_id);

create table whatsapp_conversations (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  contact_id uuid not null references whatsapp_contacts(id),
  state text not null default 'idle',
  context jsonb not null default '{}',          -- booking draft: service, date, slot id, hold token... never health data
  handoff_status text not null default 'bot' check (handoff_status in ('bot','requested','human','closed')),
  handoff_requested_at timestamptz,
  assigned_manager_id uuid references users(id),
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index whatsapp_conversations_contact_uq on whatsapp_conversations(contact_id);

create table whatsapp_templates (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  purpose text not null,                        -- internal key, e.g. booking_confirmed
  name text not null,                           -- name as registered with Meta
  language text not null default 'en',
  category text not null check (category in ('utility','authentication','marketing')),
  status text not null default 'draft' check (status in ('draft','submitted','approved','rejected','paused','disabled')),
  provider_template_id text,
  body_preview text not null,                   -- for staff review only; the approved text lives at Meta
  param_names text[] not null default '{}',
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, purpose, language)
);

create table whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  conversation_id uuid references whatsapp_conversations(id),
  contact_id uuid references whatsapp_contacts(id),
  direction text not null check (direction in ('inbound','outbound')),
  provider_message_id text,
  msg_type text not null default 'text',
  template_purpose text,
  body text,                                    -- subject to retention job; masked in logs
  status text not null default 'received' check (status in ('received','queued','sent','delivered','read','failed')),
  error text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create unique index whatsapp_messages_provider_uq on whatsapp_messages(organisation_id, provider_message_id) where provider_message_id is not null;
create index whatsapp_messages_conv_idx on whatsapp_messages(conversation_id, occurred_at);

-- Every provider callback is recorded once. The unique event_key makes duplicate delivery a no-op.
create table webhook_events (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid references organisations(id),
  provider text not null default 'whatsapp',
  event_key text not null,
  payload jsonb not null,
  status text not null default 'received' check (status in ('received','processed','failed','dead')),
  attempts int not null default 0,
  last_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, event_key)
);
create index webhook_events_pending_idx on webhook_events(status, received_at) where status in ('received','failed');

-- Transactional outbox: business transaction writes the job; a worker delivers it. Retries with backoff; dead-letter after max_attempts.
create table notification_jobs (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  channel text not null default 'whatsapp' check (channel in ('whatsapp')),
  purpose text not null,                        -- template purpose key
  recipient_kind text not null check (recipient_kind in ('customer','staff')),
  recipient_id uuid not null,                   -- customers.id or staff_profiles.id (phone resolved at send time)
  params jsonb not null default '{}',
  appointment_id uuid references appointments(id),
  dedupe_key text not null,
  status text not null default 'pending' check (status in ('pending','processing','sent','failed','dead','skipped')),
  attempts int not null default 0,
  max_attempts int not null default 6,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  provider_message_id text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, dedupe_key)
);
create index notification_jobs_due_idx on notification_jobs(next_attempt_at) where status in ('pending','failed');
create trigger notification_jobs_updated_at before update on notification_jobs for each row execute function set_updated_at();

create table application_settings (
  organisation_id uuid not null references organisations(id),
  key text not null,
  value jsonb not null,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (organisation_id, key)
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,              -- sha256 of cookie value; the raw token is never stored
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  user_agent text
);
create index sessions_user_idx on sessions(user_id);

create table rate_limits (
  key text primary key,
  window_start timestamptz not null,
  count int not null
);

-- Customer self-service: manage-link tokens and one-time codes.
create table booking_access_tokens (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  customer_id uuid not null references customers(id),
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index booking_access_tokens_customer_idx on booking_access_tokens(customer_id);

create table booking_otps (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  customer_id uuid not null references customers(id),
  code_hash text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

-- PDPA data-subject requests (access, correction, deletion).
create table data_requests (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id),
  customer_id uuid references customers(id),
  kind text not null check (kind in ('access','correction','deletion')),
  status text not null default 'received' check (status in ('received','in_progress','completed','rejected')),
  note text,
  requested_at timestamptz not null default now(),
  due_at timestamptz not null default now() + interval '21 days',
  completed_at timestamptz,
  handled_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- Audit triggers on every table where a change matters. Customers: column names only (PII).
-- ---------------------------------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['appointment_assignments','replacement_requests','availability_exceptions',
      'staff_working_hours','services','staff_services','staff_profiles','user_roles','application_settings',
      'staff_kpi_targets','kpi_definitions','whatsapp_templates','rooms','business_hours','branches','data_requests','waitlist_entries'] loop
    execute format('create trigger %I after insert or update or delete on %I for each row execute function audit_row(''full'')', t || '_audit', t);
  end loop;
end $$;
create trigger appointments_audit after insert or update or delete on appointments
  for each row execute function audit_row('full', 'operational_note');
create trigger users_audit after insert or update or delete on users
  for each row execute function audit_row('full', 'password_hash', 'failed_login_count', 'last_login_at', 'locked_until');
create trigger customers_audit after insert or update or delete on customers
  for each row execute function audit_row('keys');
create trigger customer_consents_audit after insert on customer_consents
  for each row execute function audit_row('full');
