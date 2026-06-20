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

alter table public.agent
  drop constraint if exists agent_type_check;

alter table public.agent
  add constraint agent_type_check
  check (
    type is null
    or type in ('coding', 'planning', 'manager', 'learning', 'router', 'custom')
  );

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

create table if not exists public.provider_failure (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id uuid references public.agent(id) on delete set null,
  work_item_id uuid references public.work_items(id) on delete set null,
  run_id text,
  runner_kind text not null check (
    runner_kind in (
      'codex',
      'claude_code',
      'openclaw',
      'local_model_coding',
      'llm_tool_runner',
      'planner',
      'manager',
      'openclaw_ws',
      'openclaw_http_sse',
      'computer_use',
      'local_relay'
    )
  ),
  provider text not null check (
    provider in (
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
    )
  ),
  model text not null,
  error_code text not null check (
    error_code in (
      'provider_auth_failed',
      'provider_content_refused',
      'provider_invalid_request',
      'provider_overloaded',
      'provider_rate_limited',
      'provider_stream_interrupted',
      'provider_timeout',
      'provider_unknown'
    )
  ),
  status_code integer check (status_code is null or (status_code >= 100 and status_code <= 599)),
  attempt integer not null default 1 check (attempt >= 1)
);
comment on table public.provider_failure is
  'Typed provider failure events for router-agent routing decisions.';

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
  status text default 'offline' not null check (status in ('online', 'offline', 'degraded')),
  updated_at timestamptz default now(),
  user_id uuid not null,
  workspace_id uuid not null,
  primary key (id)
);
comment on table public.local_runtime_machine is 'OpenMacaw runtime bridge table.';

create table if not exists public.local_runtime_model (
  capabilities jsonb default '{}'::jsonb not null,
  id uuid default gen_random_uuid(),
  last_advertised_at timestamptz default now() not null,
  machine_id uuid not null,
  model text not null,
  provider text,
  runner_kind text not null,
  primary key (id)
);
comment on table public.local_runtime_model is 'OpenMacaw runtime bridge table.';

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
  last_error text,
  last_error_at timestamptz,
  last_hit_at timestamptz,
  machine_id uuid,
  model text,
  name text not null,
  next_fallback_rule_id uuid,
  priority integer,
  provider text,
  runner_family text,
  runner_kind text not null check (
    runner_kind in (
      'codex',
      'claude_code',
      'openclaw',
      'local_model_coding',
      'llm_tool_runner',
      'planner',
      'manager',
      'openclaw_ws',
      'openclaw_http_sse',
      'computer_use',
      'local_relay'
    )
  ),
  transport text,
  updated_at timestamptz default now(),
  updated_by text,
  version integer,
  workspace_id uuid not null,
  primary key (id)
);
comment on table public.routing_rule is 'OpenMacaw runtime bridge table.';

create table if not exists public.local_runtime_event (
  created_at timestamptz default now() not null,
  detail jsonb default '{}'::jsonb not null,
  id uuid default gen_random_uuid(),
  kind text not null,
  machine_id uuid not null,
  workspace_id uuid not null,
  primary key (id)
);
comment on table public.local_runtime_event is 'OpenMacaw runtime bridge table.';

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
  max_concurrent_agents integer default 10 not null,
  tracker_credential_id uuid,
  tracker_kind text default 'database' not null,
  updated_at timestamptz default now(),
  updated_by_user_id uuid,
  workspace_id uuid not null,
  primary key (workspace_id),
  constraint workspace_settings_max_concurrent_agents_check
    check (max_concurrent_agents between 1 and 50),
  constraint workspace_settings_tracker_kind_check
    check (tracker_kind in ('linear', 'memory', 'database', 'github', 'api'))
);
comment on table public.workspace_settings is 'OpenMacaw runtime bridge table.';
comment on column public.workspace_settings.learning_enabled is
  'Whether workspace learning/reflection is enabled. Defaults off for controlled rollout; enable explicitly per workspace.';
comment on column public.workspace_settings.tracker_kind is
  'Workspace-scoped tracker adapter: linear, memory, database, github, or api.';
comment on column public.workspace_settings.tracker_credential_id is
  'Optional workspace credential reference used by tracker adapters that require external credentials.';
comment on column public.workspace_settings.max_concurrent_agents is
  'Workspace-level cap for concurrently running agents.';

create table if not exists public.workspaces (
  created_at timestamptz default now(),
  id uuid default gen_random_uuid(),
  name text not null,
  owner_user_id uuid not null,
  primary key (id)
);

create table if not exists public.skill (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id uuid not null references public.agent(id) on delete cascade,
  name text not null,
  description text not null default '',
  body text not null,
  status text not null default 'draft',
  copied_from_skill_id uuid references public.skill(id) on delete set null,
  created_by_agent_id uuid references public.agent(id) on delete set null,
  created_by_user_id uuid references public."user"(id) on delete set null,
  source_run_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint skill_name_format check (
    char_length(name) between 1 and 64
    and name ~ '^[a-z0-9-]+$'
    and name not in ('claude', 'anthropic')
  ),
  constraint skill_description_length check (char_length(description) between 1 and 1024),
  constraint skill_body_nonempty check (char_length(body) > 0),
  constraint skill_status_check check (status in ('draft', 'approved', 'archived'))
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

create table if not exists public.agent_eval_suite (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  slug text not null,
  name text not null,
  description text,
  suite_type text not null default 'manual',
  enabled boolean not null default false,
  system_managed boolean not null default false,
  tags text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  created_by_user_id uuid references public."user"(id) on delete set null,
  updated_by_user_id uuid references public."user"(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.agent_eval_suite is
  'Agent evaluation suite catalog. Suites may be global when workspace_id is null, or workspace-local when workspace_id is set.';

create table if not exists public.agent_eval_case (
  id uuid primary key default gen_random_uuid(),
  suite_id uuid not null references public.agent_eval_suite(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  slug text not null,
  name text not null,
  prompt text not null,
  target_agent_id uuid references public.agent(id) on delete set null,
  target_agent_slug text,
  target_agent_role text,
  target_workspace_id uuid references public.workspaces(id) on delete set null,
  target_workspace_name text,
  difficulty text not null default 'smoke' check (difficulty in ('smoke', 'easy', 'medium', 'hard', 'stress')),
  side_effect_level text not null default 'read_only' check (side_effect_level in ('read_only', 'safe_write', 'external_side_effect', 'destructive')),
  enabled_by_default boolean not null default false,
  timeout_ms integer not null default 90000 check (timeout_ms > 0),
  tags text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  created_by_user_id uuid references public."user"(id) on delete set null,
  updated_by_user_id uuid references public."user"(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.agent_eval_case is
  'Prompt-level agent evaluation cases. Cases keep assertion rows separate so tool-call checks can grow into broader agent behavior checks.';

create table if not exists public.agent_eval_case_assertion (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.agent_eval_case(id) on delete cascade,
  assertion_type text not null,
  subject_kind text not null default 'trace' check (subject_kind in ('trace', 'tool_call', 'tool_result', 'final_output', 'message', 'environment_state', 'run_metadata')),
  tool_name text,
  tool_slug text,
  tool_call_occurrence text not null default 'any',
  json_path text,
  comparator_mode text not null default 'exact' check (comparator_mode in ('exact', 'normalized_string', 'regex', 'numeric_tolerance', 'datetime_tolerance', 'unordered_array', 'subset', 'json_schema', 'semantic_text', 'semantic_json')),
  expected_text text,
  expected_number numeric,
  expected_boolean boolean,
  expected_json jsonb,
  regex text,
  tolerance jsonb,
  min_calls integer check (min_calls is null or min_calls >= 0),
  max_calls integer check (max_calls is null or max_calls >= 0),
  sequence_index integer check (sequence_index is null or sequence_index >= 0),
  weight numeric not null default 1 check (weight >= 0),
  hard_fail boolean not null default false,
  required boolean not null default true,
  ordinal integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.agent_eval_case_assertion is
  'Expected outcomes for an agent evaluation case. assertion_type starts with deterministic tool-call checks and can expand without a migration.';

create table if not exists public.agent_eval_run (
  id uuid primary key default gen_random_uuid(),
  suite_id uuid references public.agent_eval_suite(id) on delete set null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id uuid references public.agent(id) on delete set null,
  initiated_by_user_id uuid references public."user"(id) on delete set null,
  status text not null default 'queued' check (status in ('queued', 'running', 'passed', 'failed', 'canceled', 'error')),
  trigger_source text not null default 'manual',
  selected_case_ids uuid[] not null default '{}',
  selected_tags text[] not null default '{}',
  side_effect_limit text not null default 'read_only' check (side_effect_limit in ('read_only', 'safe_write', 'external_side_effect', 'destructive')),
  provider text,
  model text,
  agent_version text,
  trace_id text,
  pass_threshold numeric default 1 check (pass_threshold is null or (pass_threshold >= 0 and pass_threshold <= 1)),
  score numeric check (score is null or (score >= 0 and score <= 1)),
  total_cases integer not null default 0 check (total_cases >= 0),
  passed_cases integer not null default 0 check (passed_cases >= 0),
  failed_cases integer not null default 0 check (failed_cases >= 0),
  skipped_cases integer not null default 0 check (skipped_cases >= 0),
  error_cases integer not null default 0 check (error_cases >= 0),
  summary_text text,
  artifacts_path text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.agent_eval_run is
  'Workspace-scoped execution record for a manually triggered agent evaluation battery.';

create table if not exists public.agent_eval_run_case (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_eval_run(id) on delete cascade,
  case_id uuid references public.agent_eval_case(id) on delete set null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id uuid references public.agent(id) on delete set null,
  status text not null default 'queued' check (status in ('queued', 'running', 'passed', 'failed', 'skipped', 'error')),
  prompt text,
  score numeric check (score is null or (score >= 0 and score <= 1)),
  passed_assertions integer not null default 0 check (passed_assertions >= 0),
  failed_assertions integer not null default 0 check (failed_assertions >= 0),
  skipped_assertions integer not null default 0 check (skipped_assertions >= 0),
  observed_tool_call_count integer not null default 0 check (observed_tool_call_count >= 0),
  first_tool_call_id text,
  final_output_text text,
  error_code text,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.agent_eval_run_case is
  'Per-case result for an agent evaluation run, including normalized assertion results and observed tool-call summary.';

create table if not exists public.agent_eval_assertion_result (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_eval_run(id) on delete cascade,
  run_case_id uuid not null references public.agent_eval_run_case(id) on delete cascade,
  assertion_id uuid references public.agent_eval_case_assertion(id) on delete set null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  assertion_type text not null,
  status text not null default 'queued' check (status in ('queued', 'passed', 'failed', 'skipped', 'error')),
  score numeric check (score is null or (score >= 0 and score <= 1)),
  weight numeric not null default 1 check (weight >= 0),
  hard_fail boolean not null default false,
  explanation text,
  expected_text text,
  expected_number numeric,
  expected_boolean boolean,
  expected_json jsonb,
  actual_text text,
  actual_number numeric,
  actual_boolean boolean,
  actual_json jsonb,
  diff_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.agent_eval_assertion_result is
  'Per-assertion judge result for a run case. Scalar expectations and actuals are stored in columns; JSON remains only for structured values and diffs.';

create table if not exists public.agent_eval_observation (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_eval_run(id) on delete cascade,
  run_case_id uuid references public.agent_eval_run_case(id) on delete cascade,
  assertion_id uuid references public.agent_eval_case_assertion(id) on delete set null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id uuid references public.agent(id) on delete set null,
  observation_type text not null,
  evidence_kind text not null,
  evidence_table text,
  evidence_id uuid,
  call_id text,
  tool_name text,
  tool_slug text,
  sequence integer check (sequence is null or sequence >= 0),
  observed_text text,
  observed_number numeric,
  observed_boolean boolean,
  observed_json jsonb,
  arguments jsonb,
  result jsonb,
  provider_payload jsonb,
  passed boolean,
  message_id uuid references public.message(id) on delete set null,
  tool_call_id uuid references public.tool_call(id) on delete set null,
  agent_tool_call_event_id uuid references public.agent_tool_call_event(id) on delete set null,
  work_item_id uuid references public.work_items(id) on delete set null,
  plan_id uuid references public.plan(id) on delete set null,
  escalation_id uuid references public.escalation(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.agent_eval_observation is
  'Typed evidence observed while evaluating a case. Rows can point at product evidence such as messages, tool calls, work items, plans, escalations, and runtime events.';

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
create index if not exists local_runtime_event_machine_created_idx on public.local_runtime_event (machine_id, created_at desc);
create index if not exists local_runtime_event_workspace_created_idx on public.local_runtime_event (workspace_id, created_at desc);
create index if not exists local_runtime_machine_workspace_idx on public.local_runtime_machine (workspace_id);
create index if not exists local_runtime_model_machine_idx on public.local_runtime_model (machine_id);
create unique index if not exists local_runtime_model_machine_runner_model_key on public.local_runtime_model (machine_id, runner_kind, model);
create index if not exists local_runtime_token_machine_idx on public.local_runtime_token (machine_id);
create index if not exists memory_items_workspace_idx on public.memory_items (workspace_id);
create unique index if not exists skill_agent_name_key on public.skill (agent_id, name);
create index if not exists skill_workspace_status_updated_idx on public.skill (workspace_id, status, updated_at desc);
create index if not exists skill_workspace_agent_idx on public.skill (workspace_id, agent_id);
create index if not exists skill_source_run_idx on public.skill (source_run_id) where source_run_id is not null;
create index if not exists message_thread_created_idx on public.message (thread_id, created_at);
create index if not exists plan_workspace_idx on public.plan (workspace_id);
create unique index if not exists planning_profile_active_scope_key on public.planning_profile (scope_type, scope_id) where deleted_at is null and is_active = true;
create index if not exists provider_failure_workspace_created_idx on public.provider_failure (workspace_id, created_at desc);
create index if not exists provider_failure_workspace_summary_idx on public.provider_failure (workspace_id, provider, model, error_code, created_at desc);
create index if not exists routing_rule_machine_idx on public.routing_rule (machine_id);
create index if not exists routing_rule_workspace_priority_idx on public.routing_rule (workspace_id, priority);
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
create unique index if not exists agent_eval_suite_scope_slug_key on public.agent_eval_suite (coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);
create index if not exists agent_eval_suite_workspace_idx on public.agent_eval_suite (workspace_id);
create unique index if not exists agent_eval_case_suite_slug_key on public.agent_eval_case (suite_id, slug);
create index if not exists agent_eval_case_workspace_idx on public.agent_eval_case (workspace_id);
create index if not exists agent_eval_case_target_agent_idx on public.agent_eval_case (target_agent_id) where target_agent_id is not null;
create index if not exists agent_eval_case_tags_idx on public.agent_eval_case using gin (tags);
create index if not exists agent_eval_case_assertion_case_idx on public.agent_eval_case_assertion (case_id, ordinal);
create index if not exists agent_eval_case_assertion_tool_idx on public.agent_eval_case_assertion (tool_name, assertion_type) where tool_name is not null;
create index if not exists agent_eval_run_workspace_created_idx on public.agent_eval_run (workspace_id, created_at desc);
create index if not exists agent_eval_run_suite_idx on public.agent_eval_run (suite_id, created_at desc);
create index if not exists agent_eval_run_trace_idx on public.agent_eval_run (trace_id) where trace_id is not null;
create index if not exists agent_eval_run_case_run_idx on public.agent_eval_run_case (run_id, status);
create index if not exists agent_eval_run_case_case_idx on public.agent_eval_run_case (case_id, created_at desc);
create index if not exists agent_eval_assertion_result_run_case_idx on public.agent_eval_assertion_result (run_case_id, status);
create index if not exists agent_eval_assertion_result_assertion_idx on public.agent_eval_assertion_result (assertion_id, created_at desc);
create index if not exists agent_eval_observation_run_case_idx on public.agent_eval_observation (run_case_id, created_at);
create index if not exists agent_eval_observation_type_idx on public.agent_eval_observation (workspace_id, observation_type, created_at desc);
create index if not exists agent_eval_observation_call_idx on public.agent_eval_observation (call_id) where call_id is not null;
create index if not exists agent_eval_observation_tool_event_idx on public.agent_eval_observation (agent_tool_call_event_id) where agent_tool_call_event_id is not null;

-- Keep updated_at fresh for tables that expose it.
do $$
declare
  rel_name text;
begin
  foreach rel_name in array array[
    'agent',
    'agent_default_assignment',
    'agent_eval_assertion_result',
    'agent_eval_case',
    'agent_eval_case_assertion',
    'agent_eval_run',
    'agent_eval_run_case',
    'agent_eval_suite',
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
    'local_runtime_model',
    'local_runtime_token',
    'memory_items',
    'message',
    'plan',
    'planning_profile',
    'planning_profile_versions',
    'provider_failure',
    'routing_rule',
    'routing_rule_match',
    'scheduled_task',
    'scheduled_task_run',
    'session_thread',
    'skill',
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

alter table public.local_runtime_model enable row level security;
drop policy if exists local_runtime_model_workspace_member_access on public.local_runtime_model;
create policy local_runtime_model_workspace_member_access
on public.local_runtime_model
for all to authenticated
using (
  exists (
    select 1
    from public.local_runtime_machine machine
    where machine.id = local_runtime_model.machine_id
      and public.is_workspace_member(machine.workspace_id)
  )
)
with check (
  exists (
    select 1
    from public.local_runtime_machine machine
    where machine.id = local_runtime_model.machine_id
      and public.is_workspace_member(machine.workspace_id)
  )
);

alter table public.local_runtime_event enable row level security;
drop policy if exists local_runtime_event_workspace_member_access on public.local_runtime_event;
create policy local_runtime_event_workspace_member_access
on public.local_runtime_event
for all to authenticated
using (
  exists (
    select 1
    from public.local_runtime_machine machine
    where machine.id = local_runtime_event.machine_id
      and machine.workspace_id = local_runtime_event.workspace_id
      and public.is_workspace_member(machine.workspace_id)
  )
)
with check (
  exists (
    select 1
    from public.local_runtime_machine machine
    where machine.id = local_runtime_event.machine_id
      and machine.workspace_id = local_runtime_event.workspace_id
      and public.is_workspace_member(machine.workspace_id)
  )
);

alter table public.agent_eval_suite enable row level security;
drop policy if exists agent_eval_suite_member_access on public.agent_eval_suite;
drop policy if exists agent_eval_suite_member_select on public.agent_eval_suite;
create policy agent_eval_suite_member_select on public.agent_eval_suite
for select to authenticated
using (workspace_id is null or public.is_workspace_member(workspace_id));

drop policy if exists agent_eval_suite_member_insert on public.agent_eval_suite;
create policy agent_eval_suite_member_insert on public.agent_eval_suite
for insert to authenticated
with check (workspace_id is not null and public.is_workspace_member(workspace_id) and system_managed = false);

drop policy if exists agent_eval_suite_member_update on public.agent_eval_suite;
create policy agent_eval_suite_member_update on public.agent_eval_suite
for update to authenticated
using (workspace_id is not null and public.is_workspace_member(workspace_id) and system_managed = false)
with check (workspace_id is not null and public.is_workspace_member(workspace_id) and system_managed = false);

drop policy if exists agent_eval_suite_member_delete on public.agent_eval_suite;
create policy agent_eval_suite_member_delete on public.agent_eval_suite
for delete to authenticated
using (workspace_id is not null and public.is_workspace_member(workspace_id) and system_managed = false);

alter table public.agent_eval_case enable row level security;
drop policy if exists agent_eval_case_member_access on public.agent_eval_case;
drop policy if exists agent_eval_case_member_select on public.agent_eval_case;
create policy agent_eval_case_member_select on public.agent_eval_case
for select to authenticated
using (
  (workspace_id is null or public.is_workspace_member(workspace_id))
  and exists (
    select 1 from public.agent_eval_suite s
    where s.id = agent_eval_case.suite_id
      and (s.workspace_id is null or public.is_workspace_member(s.workspace_id))
  )
);

drop policy if exists agent_eval_case_member_insert on public.agent_eval_case;
create policy agent_eval_case_member_insert on public.agent_eval_case
for insert to authenticated
with check (
  workspace_id is not null
  and public.is_workspace_member(workspace_id)
  and exists (
    select 1 from public.agent_eval_suite s
    where s.id = agent_eval_case.suite_id
      and s.workspace_id = agent_eval_case.workspace_id
      and public.is_workspace_member(s.workspace_id)
  )
);

drop policy if exists agent_eval_case_member_update on public.agent_eval_case;
create policy agent_eval_case_member_update on public.agent_eval_case
for update to authenticated
using (
  workspace_id is not null
  and public.is_workspace_member(workspace_id)
  and exists (
    select 1 from public.agent_eval_suite s
    where s.id = agent_eval_case.suite_id
      and s.workspace_id = agent_eval_case.workspace_id
      and public.is_workspace_member(s.workspace_id)
  )
)
with check (
  workspace_id is not null
  and public.is_workspace_member(workspace_id)
  and exists (
    select 1 from public.agent_eval_suite s
    where s.id = agent_eval_case.suite_id
      and s.workspace_id = agent_eval_case.workspace_id
      and public.is_workspace_member(s.workspace_id)
  )
);

drop policy if exists agent_eval_case_member_delete on public.agent_eval_case;
create policy agent_eval_case_member_delete on public.agent_eval_case
for delete to authenticated
using (
  workspace_id is not null
  and public.is_workspace_member(workspace_id)
  and exists (
    select 1 from public.agent_eval_suite s
    where s.id = agent_eval_case.suite_id
      and s.workspace_id = agent_eval_case.workspace_id
      and public.is_workspace_member(s.workspace_id)
  )
);

alter table public.agent_eval_case_assertion enable row level security;
drop policy if exists agent_eval_case_assertion_member_access on public.agent_eval_case_assertion;
drop policy if exists agent_eval_case_assertion_member_select on public.agent_eval_case_assertion;
create policy agent_eval_case_assertion_member_select on public.agent_eval_case_assertion
for select to authenticated
using (
  exists (
    select 1
    from public.agent_eval_case c
    join public.agent_eval_suite s on s.id = c.suite_id
    where c.id = agent_eval_case_assertion.case_id
      and (c.workspace_id is null or public.is_workspace_member(c.workspace_id))
      and (s.workspace_id is null or public.is_workspace_member(s.workspace_id))
  )
);

drop policy if exists agent_eval_case_assertion_member_insert on public.agent_eval_case_assertion;
create policy agent_eval_case_assertion_member_insert on public.agent_eval_case_assertion
for insert to authenticated
with check (
  exists (
    select 1
    from public.agent_eval_case c
    join public.agent_eval_suite s on s.id = c.suite_id
    where c.id = agent_eval_case_assertion.case_id
      and c.workspace_id is not null
      and s.workspace_id = c.workspace_id
      and public.is_workspace_member(c.workspace_id)
  )
);

drop policy if exists agent_eval_case_assertion_member_update on public.agent_eval_case_assertion;
create policy agent_eval_case_assertion_member_update on public.agent_eval_case_assertion
for update to authenticated
using (
  exists (
    select 1
    from public.agent_eval_case c
    join public.agent_eval_suite s on s.id = c.suite_id
    where c.id = agent_eval_case_assertion.case_id
      and c.workspace_id is not null
      and s.workspace_id = c.workspace_id
      and public.is_workspace_member(c.workspace_id)
  )
)
with check (
  exists (
    select 1
    from public.agent_eval_case c
    join public.agent_eval_suite s on s.id = c.suite_id
    where c.id = agent_eval_case_assertion.case_id
      and c.workspace_id is not null
      and s.workspace_id = c.workspace_id
      and public.is_workspace_member(c.workspace_id)
  )
);

drop policy if exists agent_eval_case_assertion_member_delete on public.agent_eval_case_assertion;
create policy agent_eval_case_assertion_member_delete on public.agent_eval_case_assertion
for delete to authenticated
using (
  exists (
    select 1
    from public.agent_eval_case c
    join public.agent_eval_suite s on s.id = c.suite_id
    where c.id = agent_eval_case_assertion.case_id
      and c.workspace_id is not null
      and s.workspace_id = c.workspace_id
      and public.is_workspace_member(c.workspace_id)
  )
);

alter table public.agent_eval_run enable row level security;
drop policy if exists agent_eval_run_member_access on public.agent_eval_run;
create policy agent_eval_run_member_access on public.agent_eval_run
for all to authenticated
using (public.is_workspace_member(workspace_id))
with check (public.is_workspace_member(workspace_id));

alter table public.agent_eval_run_case enable row level security;
drop policy if exists agent_eval_run_case_member_access on public.agent_eval_run_case;
create policy agent_eval_run_case_member_access on public.agent_eval_run_case
for all to authenticated
using (public.is_workspace_member(workspace_id))
with check (
  public.is_workspace_member(workspace_id)
  and exists (
    select 1 from public.agent_eval_run r
    where r.id = agent_eval_run_case.run_id
      and r.workspace_id = agent_eval_run_case.workspace_id
  )
);

alter table public.agent_eval_assertion_result enable row level security;
drop policy if exists agent_eval_assertion_result_member_access on public.agent_eval_assertion_result;
create policy agent_eval_assertion_result_member_access on public.agent_eval_assertion_result
for all to authenticated
using (public.is_workspace_member(workspace_id))
with check (
  public.is_workspace_member(workspace_id)
  and exists (
    select 1 from public.agent_eval_run_case rc
    where rc.id = agent_eval_assertion_result.run_case_id
      and rc.run_id = agent_eval_assertion_result.run_id
      and rc.workspace_id = agent_eval_assertion_result.workspace_id
  )
);

alter table public.agent_eval_observation enable row level security;
drop policy if exists agent_eval_observation_member_access on public.agent_eval_observation;
create policy agent_eval_observation_member_access on public.agent_eval_observation
for all to authenticated
using (public.is_workspace_member(workspace_id))
with check (
  public.is_workspace_member(workspace_id)
  and exists (
    select 1 from public.agent_eval_run r
    where r.id = agent_eval_observation.run_id
      and r.workspace_id = agent_eval_observation.workspace_id
  )
);

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
    'local_runtime_model',
    'local_runtime_token',
    'memory_items',
    'message',
    'plan',
    'planning_profile',
    'planning_profile_versions',
    'provider_failure',
    'routing_rule',
    'routing_rule_match',
    'scheduled_task',
    'scheduled_task_run',
    'session_thread',
    'skill',
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

alter table public.skill
  alter column description set default '';

drop index if exists public.skill_source_run_idx;
alter table public.skill
  alter column source_run_id type text using source_run_id::text;
create index if not exists skill_source_run_idx
  on public.skill (source_run_id)
  where source_run_id is not null;

create index if not exists skill_workspace_agent_status_idx
  on public.skill (workspace_id, agent_id, status, updated_at desc);

create index if not exists skill_copied_from_skill_idx
  on public.skill (copied_from_skill_id)
  where copied_from_skill_id is not null;

alter table public.skill enable row level security;

drop policy if exists openmacaw_workspace_member_access on public.skill;
drop policy if exists skill_workspace_member_access on public.skill;
create policy skill_workspace_member_access
  on public.skill
  for all
  to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (
    public.is_workspace_member(workspace_id)
    and exists (
      select 1
      from public.agent
      where agent.id = skill.agent_id
        and agent.workspace_id = skill.workspace_id
    )
  );

with skill_tools(slug, name, description, parameters) as (
  values
    (
      'skill.create',
      'Create draft skill',
      'Create a draft Agent Skill for a target agent in the current workspace. Draft skills require human approval before runtime materialization.',
      $${
        "type": "object",
        "required": ["agentId", "name", "description", "body"],
        "properties": {
          "agentId": { "type": "string", "format": "uuid" },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64,
            "pattern": "^[a-z0-9-]+$",
            "description": "Agent Skills directory name; cannot be claude or anthropic."
          },
          "description": {
            "type": "string",
            "minLength": 1,
            "maxLength": 1024,
            "description": "What the skill does and when to use it."
          },
          "body": {
            "type": "string",
            "minLength": 1,
            "description": "The SKILL.md instruction body."
          }
        }
      }$$::jsonb
    )
)
update public.tool
set
  name = skill_tools.name,
  description = skill_tools.description,
  parameters = skill_tools.parameters,
  function_name = skill_tools.slug,
  execution_kind = 'database',
  runner_kind = 'planner',
  enabled = true,
  updated_at = now()
from skill_tools
where public.tool.workspace_id is null
  and public.tool.slug = skill_tools.slug;

with skill_tools(slug, name, description, parameters) as (
  values
    (
      'skill.create',
      'Create draft skill',
      'Create a draft Agent Skill for a target agent in the current workspace. Draft skills require human approval before runtime materialization.',
      $${
        "type": "object",
        "required": ["agentId", "name", "description", "body"],
        "properties": {
          "agentId": { "type": "string", "format": "uuid" },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 64,
            "pattern": "^[a-z0-9-]+$",
            "description": "Agent Skills directory name; cannot be claude or anthropic."
          },
          "description": {
            "type": "string",
            "minLength": 1,
            "maxLength": 1024,
            "description": "What the skill does and when to use it."
          },
          "body": {
            "type": "string",
            "minLength": 1,
            "description": "The SKILL.md instruction body."
          }
        }
      }$$::jsonb
    )
)
insert into public.tool (
  slug,
  name,
  description,
  parameters,
  function_name,
  execution_kind,
  runner_kind,
  enabled,
  workspace_id,
  updated_at
)
select
  slug,
  name,
  description,
  parameters,
  slug,
  'database',
  'planner',
  true,
  null,
  now()
from skill_tools
where not exists (
  select 1
  from public.tool existing
  where existing.workspace_id is null
    and existing.slug = skill_tools.slug
);

with skill_tool as (
  select id as tool_id
  from public.tool
  where workspace_id is null
    and slug = 'skill.create'
),
templates as (
  select id as template_id
  from public.tool_policy_template
  where workspace_id is null
    and slug in ('planner', 'manager', 'coding', 'local_model_coding', 'router')
)
insert into public.tool_policy_template_tool (
  template_id,
  tool_policy_template_id,
  tool_id,
  workspace_id
)
select
  templates.template_id,
  templates.template_id,
  skill_tool.tool_id,
  null
from templates
cross join skill_tool
where not exists (
  select 1
  from public.tool_policy_template_tool existing
  where existing.template_id = templates.template_id
    and existing.tool_id = skill_tool.tool_id
);

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
