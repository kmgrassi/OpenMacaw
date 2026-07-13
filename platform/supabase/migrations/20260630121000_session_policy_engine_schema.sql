begin;

create table if not exists public.policy (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  scope text not null,
  agent_id uuid references public.agent(id) on delete cascade,
  session_thread_id uuid references public.session_thread(id) on delete cascade,
  kind text not null,
  params jsonb not null default '{}'::jsonb,
  priority integer not null default 0,
  enabled boolean not null default true,
  source text not null default 'manual',
  reason text,
  created_by_user_id uuid references public."user"(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint policy_scope_check check (scope in ('workspace', 'agent', 'session')),
  constraint policy_source_check check (source in ('manual', 'system', 'template')),
  constraint policy_params_object_check check (jsonb_typeof(params) = 'object'),
  constraint policy_scope_target_check check (
    (
      scope = 'workspace'
      and agent_id is null
      and session_thread_id is null
    )
    or (
      scope = 'agent'
      and agent_id is not null
      and session_thread_id is null
    )
    or (
      scope = 'session'
      and agent_id is null
      and session_thread_id is not null
    )
  )
);

comment on table public.policy is
  'Configured session policy engine rules at workspace, agent, or session scope.';
comment on column public.policy.kind is
  'Code-owned policy kind. Valid kinds are enforced by platform/runtime registries, not a database enum.';
comment on column public.policy.params is
  'Kind-specific policy parameters validated by the corresponding contract schema.';

create table if not exists public.policy_session_state (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_thread_id uuid not null references public.session_thread(id) on delete cascade,
  key text not null,
  value_numeric numeric,
  value_json jsonb,
  updated_at timestamptz not null default now(),
  primary key (session_thread_id, key),
  constraint policy_session_state_key_nonempty check (char_length(key) > 0),
  constraint policy_session_state_has_value check (
    value_numeric is not null
    or value_json is not null
  )
);

comment on table public.policy_session_state is
  'Durable snapshot of mutable per-session policy engine accumulators.';
comment on column public.policy_session_state.key is
  'Policy accumulator key such as tool_call_count, accrued_cost_usd, or risk_points.';

create or replace function public.tg_validate_policy_workspace()
returns trigger language plpgsql as $$
declare
  v_agent_workspace_id uuid;
  v_session_workspace_id uuid;
begin
  if new.scope = 'agent' then
    select workspace_id into v_agent_workspace_id
    from public.agent
    where id = new.agent_id;

    if v_agent_workspace_id is null then
      raise exception 'policy: parent agent % not found', new.agent_id
        using errcode = 'foreign_key_violation';
    end if;

    if v_agent_workspace_id <> new.workspace_id then
      raise exception 'policy: workspace_id % does not match agent workspace_id %',
        new.workspace_id, v_agent_workspace_id
        using errcode = 'check_violation';
    end if;
  end if;

  if new.scope = 'session' then
    select workspace_id into v_session_workspace_id
    from public.session_thread
    where id = new.session_thread_id;

    if v_session_workspace_id is null then
      raise exception 'policy: parent session_thread % not found', new.session_thread_id
        using errcode = 'foreign_key_violation';
    end if;

    if v_session_workspace_id <> new.workspace_id then
      raise exception 'policy: workspace_id % does not match session_thread workspace_id %',
        new.workspace_id, v_session_workspace_id
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.tg_validate_policy_session_state_workspace()
returns trigger language plpgsql as $$
declare
  v_session_workspace_id uuid;
begin
  select workspace_id into v_session_workspace_id
  from public.session_thread
  where id = new.session_thread_id;

  if v_session_workspace_id is null then
    raise exception 'policy_session_state: parent session_thread % not found', new.session_thread_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_session_workspace_id <> new.workspace_id then
    raise exception 'policy_session_state: workspace_id % does not match session_thread workspace_id %',
      new.workspace_id, v_session_workspace_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_policy_workspace on public.policy;
create trigger trg_validate_policy_workspace
before insert or update on public.policy
for each row execute function public.tg_validate_policy_workspace();

drop trigger if exists trg_validate_policy_session_state_workspace on public.policy_session_state;
create trigger trg_validate_policy_session_state_workspace
before insert or update on public.policy_session_state
for each row execute function public.tg_validate_policy_session_state_workspace();

create index if not exists policy_workspace_scope_priority_idx
  on public.policy (workspace_id, scope, priority, created_at);
create index if not exists policy_agent_enabled_idx
  on public.policy (workspace_id, agent_id, priority, created_at)
  where scope = 'agent' and enabled = true;
create index if not exists policy_session_enabled_idx
  on public.policy (workspace_id, session_thread_id, priority, created_at)
  where scope = 'session' and enabled = true;
create index if not exists policy_session_state_workspace_idx
  on public.policy_session_state (workspace_id, session_thread_id);

alter table public.policy enable row level security;
drop policy if exists openmacaw_workspace_member_access on public.policy;
create policy openmacaw_workspace_member_access on public.policy
for all
to authenticated
using (public.is_workspace_member(workspace_id))
with check (public.is_workspace_member(workspace_id));

alter table public.policy_session_state enable row level security;
drop policy if exists openmacaw_workspace_member_access on public.policy_session_state;
create policy openmacaw_workspace_member_access on public.policy_session_state
for all
to authenticated
using (public.is_workspace_member(workspace_id))
with check (public.is_workspace_member(workspace_id));

drop trigger if exists set_updated_at on public.policy;
create trigger set_updated_at before update on public.policy
for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.policy_session_state;
create trigger set_updated_at before update on public.policy_session_state
for each row execute function public.set_updated_at();

commit;
