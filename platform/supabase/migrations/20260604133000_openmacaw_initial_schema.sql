-- OpenMacaw Supabase schema bootstrap.
-- Intended for a new Supabase project; run from the SQL editor or psql as an owner.
-- This recreates the OpenMacaw data model only, not the full historical Harper schema.

begin;

create extension if not exists pgcrypto;
create extension if not exists vector;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.agent (
  assistant_id uuid,
  context text,
  created_at timestamptz default now(),
  created_by_user_id uuid,
  current_version integer,
  description text,
  draft_version integer,
  execution_target_kind text,
  id uuid default gen_random_uuid(),
  is_active boolean default false,
  model_settings jsonb default '{}'::jsonb,
  name text,
  project_id uuid,
  session_id uuid,
  slug text,
  status text,
  tool_policy jsonb default '{}'::jsonb,
  type text,
  updated_at timestamptz default now(),
  vector_store_id uuid,
  workspace_id uuid not null,
  primary key (id)
);
comment on table public.agent is 'OpenMacaw runtime bridge table.';

create table if not exists public.agent_default_assignment (
  agent_id uuid not null,
  created_at timestamptz default now(),
  id uuid default gen_random_uuid(),
  provisioning_source text,
  role text not null,
  updated_at timestamptz default now(),
  user_id uuid not null,
  workspace_id uuid not null,
  primary key (id)
);

create table if not exists public.agent_heartbeat_config (
  agent_id uuid not null,
  created_at timestamptz default now(),
  enabled boolean default false,
  heartbeat_prompt text,
  id uuid default gen_random_uuid(),
  policy_json jsonb default '{}'::jsonb,
  quiet_hours_json jsonb default '{}'::jsonb,
  tasks_json jsonb default '{}'::jsonb,
  updated_at timestamptz default now(),
  updated_by text,
  workspace_id uuid not null,
  primary key (id)
);

create table if not exists public.agent_tool (
  agent_id uuid,
  created_at timestamptz default now(),
  created_by_user_id uuid,
  id uuid default gen_random_uuid(),
  tool_id uuid,
  updated_at timestamptz default now(),
  primary key (id)
);
comment on table public.agent_tool is 'OpenMacaw runtime bridge table.';

create table if not exists public.agent_tool_grant (
  agent_id uuid not null,
  created_at timestamptz default now(),
  created_by_user_id uuid,
  id uuid default gen_random_uuid(),
  mode text not null,
  reason text,
  source text not null,
  source_tool_template_id uuid,
  tool_id uuid not null,
  updated_at timestamptz default now(),
  workspace_id uuid not null,
  primary key (id)
);

create table if not exists public.broker_run (
  agent_id uuid not null,
  attempt integer,
  completed_at timestamptz,
  created_at timestamptz default now(),
  due_at timestamptz,
  error text,
  input jsonb default '{}'::jsonb,
  issue_identifier text,
  issue_state text,
  metadata jsonb default '{}'::jsonb,
  mode text,
  output jsonb default '{}'::jsonb,
  queued_at timestamptz,
  run_id uuid,
  session_thread_id uuid,
  started_at timestamptz,
  status text,
  terminal_reason text,
  tracker_issue_key text,
  tracker_kind text,
  tracker_project_slug text,
  updated_at timestamptz default now(),
  user_id uuid,
  workspace_id uuid,
  workspace_path text,
  primary key (run_id)
);

create table if not exists public.broker_task (
  artifacts_bucket text,
  attempt integer,
  codex_session_key text,
  codex_thread_key text,
  codex_turn_key text,
  created_at timestamptz default now(),
  error text,
  input_ref text,
  input_tokens integer,
  last_event text,
  last_event_at timestamptz,
  lease_expires_at timestamptz,
  output_ref text,
  output_tokens integer,
  queue text,
  run_id uuid not null,
  status text,
  task_id uuid,
  total_tokens integer,
  type text,
  updated_at timestamptz default now(),
  primary key (task_id)
);

create table if not exists public.credential (
  agent_id uuid,
  created_at timestamptz default now(),
  display_name text not null,
  format text not null,
  id uuid default gen_random_uuid(),
  key_value jsonb default '{}'::jsonb,
  provider text not null,
  updated_at timestamptz default now(),
  user_id uuid,
  validated_at timestamptz,
  validation_state text,
  workspace_id uuid,
  primary key (id)
);
comment on table public.credential is 'OpenMacaw runtime bridge table.';

create table if not exists public.credential_alias (
  agent_id uuid,
  alias text not null,
  created_at timestamptz default now(),
  credential_id uuid not null,
  id uuid default gen_random_uuid(),
  user_id uuid,
  workspace_id uuid,
  primary key (id)
);

create table if not exists public.engine_instance (
  agent_id uuid not null,
  host text not null,
  instance_id text not null,
  last_health_at timestamptz,
  port integer not null,
  role text not null default 'unified',
  started_at timestamptz not null default now(),
  status text not null default 'starting',
  updated_at timestamptz default now(),
  workspace_id uuid not null,
  ws_connection_id text,
  primary key (instance_id)
);

create table if not exists public.event_log (
  created_at timestamptz default now(),
  id uuid default gen_random_uuid(),
  kind text not null,
  payload jsonb default '{}'::jsonb,
  raw_payload jsonb default '{}'::jsonb,
  source text not null,
  work_item_id uuid not null,
  workspace_id uuid not null,
  primary key (id)
);

create table if not exists public.gateway_config (
  config_hash text not null,
  config_json jsonb default '{}'::jsonb,
  id uuid default gen_random_uuid(),
  scope_id uuid not null,
  scope_type text not null,
  updated_at timestamptz default now(),
  updated_by text not null,
  version integer,
  primary key (id)
);
comment on table public.gateway_config is 'OpenMacaw runtime bridge table.';

create table if not exists public.gateway_config_state (
  broker_instance_id uuid,
  last_applied_hash text,
  last_applied_version integer,
  last_apply_at timestamptz,
  last_apply_error text,
  last_apply_status text,
  scope_id uuid not null,
  scope_type text not null,
  sync_error text,
  sync_status text,
  synced_at timestamptz,
  primary key (scope_type, scope_id)
);
comment on table public.gateway_config_state is 'OpenMacaw runtime bridge table.';

create table if not exists public.gateway_config_versions (
  change_summary jsonb default '{}'::jsonb,
  config_hash text not null,
  config_json jsonb not null,
  created_at timestamptz default now(),
  created_by text not null,
  gateway_config_id uuid not null,
  id uuid default gen_random_uuid(),
  version integer not null,
  primary key (id)
);

create table if not exists public.local_runtime_machine (
  advertised_runner_kinds text[] default '{}',
  created_at timestamptz default now(),
  display_name text not null,
  helper_version text,
  id uuid default gen_random_uuid(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  runner_kinds text[] default '{}',
  status text not null default 'offline' check (status in ('online', 'offline', 'degraded')),
  updated_at timestamptz default now(),
  user_id uuid not null,
  workspace_id uuid not null,
  primary key (id)
);
comment on table public.local_runtime_machine is 'OpenMacaw runtime bridge table.';

create table if not exists public.local_runtime_model (
  capabilities jsonb not null default '{}'::jsonb,
  id uuid default gen_random_uuid(),
  last_advertised_at timestamptz not null default now(),
  machine_id uuid not null references public.local_runtime_machine(id) on delete cascade,
  model text not null,
  provider text,
  runner_kind text not null,
  primary key (id),
  unique (machine_id, runner_kind, model)
);
comment on table public.local_runtime_model is 'OpenMacaw runtime bridge table.';

create table if not exists public.local_runtime_event (
  created_at timestamptz not null default now(),
  detail jsonb not null default '{}'::jsonb,
  id uuid default gen_random_uuid(),
  kind text not null,
  machine_id uuid not null references public.local_runtime_machine(id) on delete cascade,
  workspace_id uuid not null,
  primary key (id)
);
comment on table public.local_runtime_event is 'OpenMacaw runtime bridge table.';

create table if not exists public.local_runtime_token (
  created_at timestamptz default now(),
  created_by_user_id uuid,
  expires_at timestamptz,
  id uuid default gen_random_uuid(),
  last_used_at timestamptz,
  machine_id uuid not null,
  revoked_at timestamptz,
  token_hash text not null,
  workspace_id uuid not null,
  primary key (id)
);
comment on table public.local_runtime_token is 'OpenMacaw runtime bridge table.';

create table if not exists public.memory_items (
  agent_id uuid,
  canonical_id uuid,
  content text not null,
  created_at timestamptz default now(),
  embedding text,
  event_time text,
  fts jsonb default '{}'::jsonb,
  id uuid default gen_random_uuid(),
  importance integer,
  is_deleted boolean default false,
  scope jsonb default '{}'::jsonb,
  source_path text,
  source_run_id uuid,
  source_task_id uuid,
  supersedes_id uuid,
  tags jsonb default '{}'::jsonb,
  updated_at timestamptz default now(),
  workspace_id uuid not null,
  primary key (id)
);

create table if not exists public.message (
  agent_id uuid,
  content text,
  created_at timestamptz default now(),
  deleted_at timestamptz,
  generated_by text,
  group_chat_id uuid,
  id uuid default gen_random_uuid(),
  is_deleted boolean default false,
  message_type text,
  metadata jsonb default '{}'::jsonb,
  model text,
  payload jsonb default '{}'::jsonb,
  project_id uuid,
  provider text,
  reply_to_message_id uuid,
  request_id uuid,
  response_id uuid,
  role jsonb default '{}'::jsonb,
  run_id uuid,
  runner_kind text,
  session_id uuid,
  thread_id uuid,
  user_id uuid,
  workspace_id uuid not null,
  primary key (id)
);
comment on table public.message is 'OpenMacaw runtime bridge table.';

create table if not exists public.plan (
  created_at timestamptz default now(),
  default_model text,
  default_runner_kind text,
  description text,
  id uuid default gen_random_uuid(),
  intent text,
  is_ongoing boolean default false,
  message_id uuid,
  metadata jsonb default '{}'::jsonb,
  name text,
  schema_version text,
  status text,
  type text,
  updated_at timestamptz default now(),
  workspace_id uuid,
  primary key (id)
);
comment on table public.plan is 'OpenMacaw runtime bridge table.';

create table if not exists public.planning_profile (
  created_at timestamptz default now(),
  created_by_user_id uuid,
  definition_of_done jsonb default '{}'::jsonb,
  deleted_at timestamptz,
  deleted_by_user_id uuid,
  deleted_reason text,
  description text,
  environment_notes text,
  handoff_policy jsonb default '{}'::jsonb,
  id uuid default gen_random_uuid(),
  instructions text,
  is_active boolean default false,
  metadata jsonb default '{}'::jsonb,
  name text,
  repo_boundaries jsonb default '{}'::jsonb,
  scope_id uuid not null,
  scope_type text not null,
  security_constraints jsonb default '{}'::jsonb,
  updated_at timestamptz default now(),
  updated_by_user_id uuid,
  validation_commands jsonb default '{}'::jsonb,
  version integer,
  workspace_id uuid,
  primary key (id)
);
comment on table public.planning_profile is 'OpenMacaw runtime bridge table.';

create table if not exists public.planning_profile_versions (
  changed_by_user_id uuid,
  created_at timestamptz default now(),
  id uuid default gen_random_uuid(),
  operation text not null,
  planning_profile_id uuid not null,
  profile_snapshot jsonb not null,
  version integer not null,
  primary key (id)
);

create table if not exists public.routing_rule (
  created_at timestamptz default now(),
  credential_alias text,
  credential_id uuid,
  enabled boolean default false,
  execution_location text,
  fallback_mode text,
  hit_count integer,
  id uuid default gen_random_uuid(),
  last_hit_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  machine_id uuid references public.local_runtime_machine(id) on delete set null,
  model text,
  model_tier_floor text not null default 'any' check (model_tier_floor in ('frontier', 'mid', 'local', 'any')),
  name text not null,
  priority integer,
  provider text,
  runner_family text,
  runner_kind text not null,
  transport text,
  updated_at timestamptz default now(),
  updated_by text,
  version integer,
  workspace_id uuid not null,
  primary key (id)
);
comment on table public.routing_rule is 'OpenMacaw runtime bridge table.';

create table if not exists public.routing_rule_fallback (
  routing_rule_id uuid not null references public.routing_rule(id) on delete cascade,
  workspace_id uuid not null,
  position integer not null check (position >= 0),
  provider text not null check (provider in (
    'openai',
    'anthropic',
    'openai_compatible',
    'openai_codex',
    'xai',
    'google',
    'mistral',
    'groq',
    'openrouter',
    'together',
    'perplexity',
    'azure',
    'codex',
    'openclaw',
    'computer_use',
    'local'
  )),
  model text not null,
  credential_id uuid references public.credential(id) on delete restrict,
  credential_alias text check (
    credential_alias is null
    or (credential_alias ~ '^[a-z0-9-]+$' and length(credential_alias) <= 64)
  ),
  primary key (routing_rule_id, position),
  constraint routing_rule_fallback_single_credential
    check (num_nonnulls(credential_id, credential_alias) <= 1)
);
comment on table public.routing_rule_fallback is
  'Ordered fallback chain links for intelligent provider cutovers.';

create table if not exists public.routing_rule_match (
  created_at timestamptz default now(),
  id uuid default gen_random_uuid(),
  key text,
  kind text not null,
  rule_id uuid not null,
  value text not null,
  workspace_id uuid not null,
  primary key (id)
);
comment on table public.routing_rule_match is 'OpenMacaw runtime bridge table.';

create table if not exists public.scheduled_task (
  agent_id uuid,
  cancelled_reason text,
  created_at timestamptz default now(),
  created_by_user_id uuid,
  cron_schedule text,
  delivery jsonb default '{}'::jsonb,
  enabled boolean default false,
  id uuid default gen_random_uuid(),
  instructions text,
  is_active boolean default false,
  is_completed boolean default false,
  is_follow_up boolean default false,
  job_id numeric,
  last_error text,
  last_run_at timestamptz,
  last_run_status text,
  metadata jsonb default '{}'::jsonb,
  next_interval jsonb default '{}'::jsonb,
  next_run_at timestamptz,
  schedule jsonb default '{}'::jsonb,
  source_work_item_id uuid,
  start_time text,
  timezone text,
  title text,
  updated_at timestamptz default now(),
  workspace_id uuid,
  primary key (id)
);
comment on table public.scheduled_task is 'OpenMacaw runtime bridge table.';

create table if not exists public.scheduled_task_run (
  agent_id uuid not null,
  attempt_count integer,
  created_at timestamptz default now(),
  error text,
  finished_at timestamptz,
  id uuid default gen_random_uuid(),
  message_id uuid,
  metadata jsonb default '{}'::jsonb,
  run_id uuid,
  scheduled_for text not null,
  scheduled_task_id uuid not null,
  source_work_item_id uuid,
  started_at timestamptz,
  status text not null,
  workspace_id uuid,
  primary key (id)
);
comment on table public.scheduled_task_run is 'OpenMacaw runtime bridge table.';

create table if not exists public.session_thread (
  aborted_last_run boolean,
  agent_id uuid not null,
  auth_profile_override text,
  auth_profile_override_compaction_count integer,
  auth_profile_override_source text,
  bootstrap_attempt integer,
  bootstrap_source text,
  channel text,
  channel_thread_id uuid,
  client_instance_id uuid,
  compaction_count integer,
  created_at timestamptz default now(),
  delivery_context jsonb default '{}'::jsonb,
  id uuid default gen_random_uuid(),
  input_tokens integer,
  label text,
  last_compacted_at timestamptz,
  last_message_at timestamptz,
  last_reset_at timestamptz,
  metadata jsonb default '{}'::jsonb,
  model text,
  model_provider text,
  origin jsonb default '{}'::jsonb,
  output_tokens integer,
  reasoning_level text,
  reset_reason text,
  response_usage jsonb default '{}'::jsonb,
  send_policy text,
  session_key text,
  skills_snapshot jsonb default '{}'::jsonb,
  status text,
  system_sent boolean,
  thinking_level text,
  title text,
  total_tokens integer,
  updated_at timestamptz default now(),
  user_id uuid,
  verbose_level text,
  workspace_id uuid not null,
  primary key (id)
);

create table if not exists public.task (
  created_at timestamptz default now(),
  description text,
  id uuid default gen_random_uuid(),
  is_recurring boolean default false,
  name text,
  plan_id uuid,
  pr_url text,
  status text,
  updated_at timestamptz default now(),
  workspace_id uuid,
  primary key (id)
);

create table if not exists public.tool (
  created_at timestamptz default now(),
  created_by_user_id uuid,
  description text,
  enabled boolean default false,
  execution_kind text,
  examples jsonb default '{}'::jsonb,
  function_name text,
  id uuid default gen_random_uuid(),
  name text,
  parameters jsonb default '{}'::jsonb,
  runner_kind text,
  slug text,
  type text,
  updated_at timestamptz default now(),
  workspace_id uuid,
  primary key (id)
);
comment on table public.tool is 'OpenMacaw runtime bridge table.';

create table if not exists public.tool_call (
  created_at timestamptz default now(),
  id uuid default gen_random_uuid(),
  input text,
  message_id uuid,
  output text,
  tool_id uuid,
  primary key (id)
);
comment on table public.tool_call is 'OpenMacaw runtime bridge table.';

create table if not exists public.tool_policy_template (
  created_at timestamptz default now(),
  description text,
  enabled boolean default false,
  id uuid default gen_random_uuid(),
  name text not null,
  slug text not null,
  system_managed boolean,
  updated_at timestamptz default now(),
  workspace_id uuid,
  primary key (id)
);

create table if not exists public.tool_policy_template_tool (
  created_at timestamptz default now(),
  id uuid default gen_random_uuid(),
  template_id uuid not null,
  tool_id uuid not null,
  tool_policy_template_id uuid not null,
  workspace_id uuid,
  primary key (id)
);

create table if not exists public."user" (
  address_id uuid,
  agent_id uuid,
  app_id uuid,
  auth_id uuid,
  avatar_url text,
  created_at timestamptz default now(),
  device_verification_code text,
  dob text,
  email text,
  expo_push_token text,
  first_name text,
  full_name text,
  id uuid default gen_random_uuid(),
  is_registered boolean default false,
  last_mobile_app_login text,
  last_name text,
  mobile_app_verified_at timestamptz,
  phone text,
  project_id uuid,
  source text,
  timezone text,
  type text,
  primary key (id)
);

create table if not exists public.work_items (
  completion_gates text[] default '{}',
  created_at timestamptz default now(),
  depends_on text[] default '{}',
  description text,
  id uuid default gen_random_uuid(),
  identifier text,
  instructions text,
  labels text[] default '{}',
  last_polled_at timestamptz,
  manager_runner_id uuid,
  metadata jsonb default '{}'::jsonb,
  next_poll_at timestamptz,
  not_before_at timestamptz,
  plan_id uuid,
  poll_cadence_seconds integer,
  priority text,
  repository text,
  runner_kind text,
  scheduled_by_user_id uuid,
  scheduled_reason text,
  source text,
  state text,
  task_id uuid,
  title text,
  updated_at timestamptz default now(),
  url text,
  workspace_id uuid,
  primary key (id)
);
comment on table public.work_items is 'OpenMacaw runtime bridge table.';

create table if not exists public.workspace_members (
  created_at timestamptz default now(),
  role text,
  user_id uuid not null,
  workspace_id uuid not null,
  primary key (workspace_id, user_id)
);

create table if not exists public.workspace_resource (
  alias text,
  archived_at timestamptz,
  archived_by_user_id uuid,
  archived_reason text,
  created_at timestamptz default now(),
  created_by_user_id uuid,
  description text,
  id uuid default gen_random_uuid(),
  kind text not null,
  locator jsonb default '{}'::jsonb,
  metadata jsonb default '{}'::jsonb,
  name text not null,
  status text,
  updated_at timestamptz default now(),
  updated_by_user_id uuid,
  workspace_id uuid not null,
  primary key (id)
);

create table if not exists public.workspace_resource_grant (
  access_mode text not null,
  constraints jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  created_by_user_id uuid,
  id uuid default gen_random_uuid(),
  is_active boolean default false,
  metadata jsonb default '{}'::jsonb,
  resource_id uuid not null,
  subject_id uuid not null,
  subject_type text not null,
  updated_at timestamptz default now(),
  updated_by_user_id uuid,
  workspace_id uuid not null,
  primary key (id)
);

create table if not exists public.workspace_resource_location (
  archived_at timestamptz,
  archived_by_user_id uuid,
  archived_reason text,
  created_at timestamptz default now(),
  created_by_user_id uuid,
  id uuid default gen_random_uuid(),
  last_checked_at timestamptz,
  local_runtime_machine_id uuid,
  location_kind text not null,
  locator jsonb default '{}'::jsonb,
  metadata jsonb default '{}'::jsonb,
  resource_id uuid not null,
  status text,
  updated_at timestamptz default now(),
  updated_by_user_id uuid,
  workspace_id uuid not null,
  primary key (id)
);

create table if not exists public.workspace_settings (
  learning_enabled boolean default false,
  updated_at timestamptz default now(),
  updated_by_user_id uuid,
  workspace_id uuid not null,
  primary key (workspace_id)
);
comment on table public.workspace_settings is 'OpenMacaw runtime bridge table.';

create table if not exists public.workspaces (
  created_at timestamptz default now(),
  id uuid default gen_random_uuid(),
  name text not null,
  owner_user_id uuid not null,
  primary key (id)
);

create table if not exists public.work_item_comments (
  author text,
  body text not null,
  created_at timestamptz not null default now(),
  id uuid default gen_random_uuid(),
  metadata jsonb not null default '{}'::jsonb,
  source text not null default 'tracker',
  updated_at timestamptz not null default now(),
  work_item_id uuid not null references public.work_items(id) on delete cascade,
  primary key (id)
);

comment on table public.work_item_comments is
  'Comments attached to a work item, used by the orchestrator database tracker for progress notes.';

create table if not exists public.escalation (
  created_at timestamptz not null default now(),
  id uuid default gen_random_uuid(),
  payload jsonb not null default '{}'::jsonb,
  reason_kind text check (reason_kind is null or reason_kind in (
    'ambiguous_intent',
    'missing_context',
    'policy_uncertain',
    'policy_ask',
    'destructive_action_unverified',
    'out_of_scope',
    'stuck_after_retries',
    'other'
  )),
  responded_at timestamptz,
  responded_by uuid references public."user"(id) on delete set null,
  response_kind text check (response_kind is null or response_kind in (
    'decision',
    'reply',
    'patch',
    'approve',
    'abandon',
    'auto_abandoned'
  )),
  response_payload jsonb,
  triggered_at timestamptz not null default now(),
  triggered_by text not null check (triggered_by in ('manager', 'author', 'reviewer', 'system')),
  trigger_kind text not null check (trigger_kind in ('structural', 'self_flagged', 'resource', 'gate_failure')),
  updated_at timestamptz not null default now(),
  work_item_id uuid references public.work_items(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  primary key (id)
);

comment on table public.escalation is
  'First-class human-in-the-loop interactions. Written by escalate_to_human tool calls; read by the dashboard escalation queue.';
comment on column public.escalation.payload is
  'Per escalate_to_human tool schema: { question, context_summary, candidate_options, preferred_option_id, urgency }.';

create or replace function public.tg_validate_escalation_workspace()
returns trigger
language plpgsql
as $$
declare
  v_wi_workspace_id uuid;
begin
  if new.work_item_id is null then
    return new;
  end if;

  select workspace_id into v_wi_workspace_id
    from public.work_items
    where id = new.work_item_id;

  if v_wi_workspace_id is null then
    raise exception 'escalation: parent work_item % not found', new.work_item_id
      using errcode = '23503';
  end if;

  if v_wi_workspace_id <> new.workspace_id then
    raise exception 'escalation: workspace_id % does not match work_item workspace_id %',
      new.workspace_id, v_wi_workspace_id
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_escalation_workspace on public.escalation;
create trigger trg_validate_escalation_workspace
before insert or update on public.escalation
for each row execute function public.tg_validate_escalation_workspace();

-- Compatibility columns expected by platform resource-dispatch code.
alter table public.workspace_resource add column if not exists resource_type text;
alter table public.workspace_resource add column if not exists provider text;
alter table public.workspace_resource add column if not exists provider_url text;
alter table public.workspace_resource add column if not exists display_name text;
alter table public.workspace_resource add column if not exists deleted_at timestamptz;
alter table public.workspace_resource add column if not exists metadata_json jsonb default '{}'::jsonb;
alter table public.workspace_resource alter column kind set default 'repository';
alter table public.workspace_resource alter column name set default '';
alter table public.workspace_resource alter column description set default '';

create table if not exists public.workspace_resource_credential (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  resource_id uuid not null,
  credential_id uuid not null,
  credential_purpose text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  revoked_at timestamptz
);

create table if not exists public.agent_resource_grant (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  agent_id uuid not null,
  resource_id uuid not null,
  access_mode text not null default 'read' check (access_mode in ('read', 'write')), 
  allowed_refs_json jsonb default '{}'::jsonb,
  network_policy_json jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  expires_at timestamptz,
  revoked_at timestamptz
);

create table if not exists public.agent_tool_call_event (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  agent_id uuid not null,
  run_id uuid not null,
  task_id uuid,
  tool_call_id uuid,
  correlation_id text,
  sequence integer not null default 0,
  event_type text not null,
  message_kind text not null,
  tool_slug text not null,
  status text not null,
  approval_state text,
  command_actions jsonb default '[]'::jsonb,
  arguments jsonb default '{}'::jsonb,
  result jsonb default '{}'::jsonb,
  output_summary text,
  patch_summary text,
  file_changes jsonb default '[]'::jsonb,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms integer,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'workspace_resource_credential_resource_id_fkey') then
    alter table public.workspace_resource_credential
      add constraint workspace_resource_credential_resource_id_fkey
      foreign key (resource_id) references public.workspace_resource(id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'workspace_resource_credential_credential_id_fkey') then
    alter table public.workspace_resource_credential
      add constraint workspace_resource_credential_credential_id_fkey
      foreign key (credential_id) references public.credential(id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'agent_resource_grant_agent_id_fkey') then
    alter table public.agent_resource_grant
      add constraint agent_resource_grant_agent_id_fkey
      foreign key (agent_id) references public.agent(id) on delete cascade;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'agent_resource_grant_resource_id_fkey') then
    alter table public.agent_resource_grant
      add constraint agent_resource_grant_resource_id_fkey
      foreign key (resource_id) references public.workspace_resource(id) on delete cascade;
  end if;
end $$;

-- Core uniqueness and lookup indexes used by OpenMacaw services.
create unique index if not exists user_auth_id_key on public."user" (auth_id) where auth_id is not null;
create index if not exists workspace_members_user_id_idx on public.workspace_members (user_id);
create index if not exists agent_workspace_id_idx on public.agent (workspace_id);
create unique index if not exists agent_default_assignment_role_key on public.agent_default_assignment (workspace_id, user_id, role);
create unique index if not exists agent_tool_grant_unique on public.agent_tool_grant (agent_id, workspace_id, tool_id);
create index if not exists broker_run_agent_created_idx on public.broker_run (agent_id, created_at desc);
create index if not exists broker_task_run_idx on public.broker_task (run_id);
create index if not exists credential_workspace_idx on public.credential (workspace_id);
create index if not exists engine_instance_agent_status_idx on public.engine_instance (agent_id, status);
create unique index if not exists gateway_config_scope_key on public.gateway_config (scope_type, scope_id);
create index if not exists local_runtime_machine_workspace_idx on public.local_runtime_machine (workspace_id);
create index if not exists local_runtime_model_machine_idx on public.local_runtime_model (machine_id);
create index if not exists local_runtime_event_machine_created_idx on public.local_runtime_event (machine_id, created_at desc);
create index if not exists local_runtime_token_machine_idx on public.local_runtime_token (machine_id);
create index if not exists routing_rule_machine_idx on public.routing_rule (machine_id);
create index if not exists memory_items_workspace_idx on public.memory_items (workspace_id);
create index if not exists message_thread_created_idx on public.message (thread_id, created_at);
create index if not exists plan_workspace_idx on public.plan (workspace_id);
create unique index if not exists planning_profile_active_scope_key on public.planning_profile (scope_type, scope_id) where deleted_at is null and is_active = true;
create index if not exists routing_rule_workspace_priority_idx on public.routing_rule (workspace_id, priority);
create index if not exists routing_rule_fallback_rule_idx on public.routing_rule_fallback (routing_rule_id);
create index if not exists routing_rule_fallback_workspace_rule_idx on public.routing_rule_fallback (workspace_id, routing_rule_id, position);
create index if not exists routing_rule_match_rule_idx on public.routing_rule_match (rule_id);
create index if not exists scheduled_task_due_idx on public.scheduled_task (enabled, next_run_at);
create index if not exists scheduled_task_run_task_idx on public.scheduled_task_run (scheduled_task_id, created_at desc);
create index if not exists session_thread_workspace_agent_idx on public.session_thread (workspace_id, agent_id);
create unique index if not exists tool_slug_workspace_key on public.tool (coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);
create index if not exists work_items_workspace_state_idx on public.work_items (workspace_id, state);
create index if not exists work_item_comments_work_item_idx on public.work_item_comments (work_item_id);
create index if not exists work_item_comments_created_at_idx on public.work_item_comments (created_at);
create index if not exists escalation_outstanding_idx on public.escalation (workspace_id, triggered_at desc) where responded_at is null;
create index if not exists escalation_work_item_triggered_idx on public.escalation (work_item_id, triggered_at desc);
create index if not exists escalation_stale_sweep_idx on public.escalation (triggered_at) where responded_at is null;
create index if not exists agent_resource_grant_agent_idx on public.agent_resource_grant (workspace_id, agent_id);
create index if not exists agent_tool_call_event_run_idx on public.agent_tool_call_event (run_id, sequence, created_at);

-- Keep updated_at fresh for tables that expose it.
do $$
declare
  rel_name text;
begin
  foreach rel_name in array array[
    'agent',
    'agent_default_assignment',
    'agent_heartbeat_config',
    'agent_resource_grant',
    'agent_tool',
    'agent_tool_call_event',
    'agent_tool_grant',
    'broker_run',
    'broker_task',
    'credential',
    'credential_alias',
    'engine_instance',
    'escalation',
    'event_log',
    'gateway_config',
    'gateway_config_state',
    'gateway_config_versions',
    'local_runtime_machine',
    'local_runtime_token',
    'memory_items',
    'message',
    'plan',
    'planning_profile',
    'planning_profile_versions',
    'routing_rule',
    'routing_rule_fallback',
    'routing_rule_match',
    'scheduled_task',
    'scheduled_task_run',
    'session_thread',
    'task',
    'tool',
    'tool_call',
    'tool_policy_template',
    'tool_policy_template_tool',
    'user',
    'work_items',
    'work_item_comments',
    'workspace_members',
    'workspace_resource',
    'workspace_resource_credential',
    'workspace_resource_grant',
    'workspace_resource_location',
    'workspace_settings',
    'workspaces'
  ] loop
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = rel_name and column_name = 'updated_at') then
      execute format('drop trigger if exists set_updated_at on public.%I', rel_name);
      execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()', rel_name);
    end if;
  end loop;
end $$;

-- Supabase auth -> OpenMacaw app-user bridge.
create or replace function public.current_app_user_id()
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select u.id from public."user" u where u.auth_id = auth.uid() limit 1),
    (select u.id from public."user" u where u.id = auth.uid() and u.auth_id is null limit 1)
  );
$$;

create or replace function public.is_workspace_member(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = public.current_app_user_id()
  );
$$;

create or replace function public.is_workspace_admin(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members wm where wm.workspace_id = p_workspace_id and wm.user_id = public.current_app_user_id() and wm.role in ('owner', 'admin')); 
$$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public."user" (auth_id, email, full_name, avatar_url, source, type, created_at)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'avatar_url', 'supabase', 'user', now())
  on conflict (auth_id) where auth_id is not null do update set
    email = excluded.email,
    full_name = coalesce(excluded.full_name, public."user".full_name),
    avatar_url = coalesce(excluded.avatar_url, public."user".avatar_url);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- Minimal RLS for user-scoped Supabase clients. Service-role calls bypass RLS.
alter table public."user" enable row level security;
drop policy if exists user_self_access on public."user";
create policy user_self_access on public."user" for all to authenticated
using (id = public.current_app_user_id() or auth_id = auth.uid())
with check (id = public.current_app_user_id() or auth_id = auth.uid());

alter table public.workspaces enable row level security;
drop policy if exists workspace_member_access on public.workspaces;
create policy workspace_member_access on public.workspaces for all to authenticated
using (owner_user_id = public.current_app_user_id() or public.is_workspace_member(id))
with check (owner_user_id = public.current_app_user_id() or public.is_workspace_member(id));

alter table public.workspace_members enable row level security;
drop policy if exists workspace_members_visible_to_members on public.workspace_members;
create policy workspace_members_visible_to_members on public.workspace_members for all to authenticated
using (user_id = public.current_app_user_id() or public.is_workspace_member(workspace_id))
with check (user_id = public.current_app_user_id() or public.is_workspace_admin(workspace_id));

alter table public.work_item_comments enable row level security;
drop policy if exists work_item_comments_select_if_workspace_member on public.work_item_comments;
create policy work_item_comments_select_if_workspace_member
on public.work_item_comments
for select
to authenticated
using (
  exists (
    select 1
    from public.work_items wi
    where wi.id = work_item_comments.work_item_id
      and wi.workspace_id is not null
      and public.is_workspace_member(wi.workspace_id)
  )
);

drop policy if exists work_item_comments_insert_if_workspace_member on public.work_item_comments;
create policy work_item_comments_insert_if_workspace_member
on public.work_item_comments
for insert
to authenticated
with check (
  exists (
    select 1
    from public.work_items wi
    where wi.id = work_item_comments.work_item_id
      and wi.workspace_id is not null
      and public.is_workspace_member(wi.workspace_id)
  )
);

drop policy if exists work_item_comments_update_if_workspace_member on public.work_item_comments;
create policy work_item_comments_update_if_workspace_member
on public.work_item_comments
for update
to authenticated
using (
  exists (
    select 1
    from public.work_items wi
    where wi.id = work_item_comments.work_item_id
      and wi.workspace_id is not null
      and public.is_workspace_member(wi.workspace_id)
  )
)
with check (
  exists (
    select 1
    from public.work_items wi
    where wi.id = work_item_comments.work_item_id
      and wi.workspace_id is not null
      and public.is_workspace_member(wi.workspace_id)
  )
);

drop policy if exists work_item_comments_delete_if_workspace_member on public.work_item_comments;
create policy work_item_comments_delete_if_workspace_member
on public.work_item_comments
for delete
to authenticated
using (
  exists (
    select 1
    from public.work_items wi
    where wi.id = work_item_comments.work_item_id
      and wi.workspace_id is not null
      and public.is_workspace_member(wi.workspace_id)
  )
);

do $$
declare
  rel_name text;
begin
  foreach rel_name in array array[
    'agent',
    'agent_default_assignment',
    'agent_heartbeat_config',
    'agent_resource_grant',
    'agent_tool',
    'agent_tool_call_event',
    'agent_tool_grant',
    'broker_run',
    'broker_task',
    'credential',
    'credential_alias',
    'engine_instance',
    'escalation',
    'event_log',
    'gateway_config',
    'gateway_config_state',
    'gateway_config_versions',
    'local_runtime_machine',
    'local_runtime_token',
    'memory_items',
    'message',
    'plan',
    'planning_profile',
    'planning_profile_versions',
    'routing_rule',
    'routing_rule_fallback',
    'routing_rule_match',
    'scheduled_task',
    'scheduled_task_run',
    'session_thread',
    'task',
    'tool',
    'tool_call',
    'tool_policy_template',
    'tool_policy_template_tool',
    'work_items',
    'workspace_resource',
    'workspace_resource_credential',
    'workspace_resource_grant',
    'workspace_resource_location',
    'workspace_settings'
  ] loop
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = rel_name and column_name = 'workspace_id') then
      execute format('alter table public.%I enable row level security', rel_name);
      execute format('drop policy if exists openmacaw_workspace_member_access on public.%I', rel_name);
      execute format('create policy openmacaw_workspace_member_access on public.%I for all to authenticated using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id))', rel_name);
    end if;
  end loop;
end $$;

-- Optional RPC stub. Replace with a vector-ranked implementation after embedding storage is finalized.
create or replace function public.memory_hybrid_search(
  query_text text default null,
  query_embedding vector default null,
  workspace_id uuid default null,
  agent_id uuid default null,
  match_count integer default 10
)
returns setof public.memory_items
language sql stable as $$
  select * from public.memory_items m
  where (memory_hybrid_search.workspace_id is null or m.workspace_id = memory_hybrid_search.workspace_id)
    and (memory_hybrid_search.agent_id is null or m.agent_id = memory_hybrid_search.agent_id)
    and coalesce(m.is_deleted, false) = false
  order by m.updated_at desc nulls last, m.created_at desc nulls last
  limit greatest(match_count, 0);
$$;

commit;
