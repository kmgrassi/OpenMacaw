create table if not exists public.policy (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  scope text not null check (scope in ('workspace', 'agent', 'session')),
  agent_id uuid references public.agent(id) on delete cascade,
  session_thread_id text,
  kind text not null check (
    kind in (
      'max_tool_calls_per_session',
      'cost_budget',
      'ask_on_shell',
      'ask_on_tool',
      'block_tools',
      'risk_score'
    )
  ),
  params jsonb not null default '{}'::jsonb,
  priority integer not null default 0,
  enabled boolean not null default true,
  source text not null default 'manual' check (source in ('manual', 'system', 'template')),
  reason text,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint policy_scope_target_check check (
    (scope = 'workspace' and agent_id is null and session_thread_id is null)
    or (scope = 'agent' and agent_id is not null and session_thread_id is null)
    or (scope = 'session' and session_thread_id is not null)
  )
);

create index if not exists idx_policy_workspace_scope_enabled_priority
  on public.policy (workspace_id, scope, enabled, priority, created_at);

create index if not exists idx_policy_agent_enabled
  on public.policy (workspace_id, agent_id, enabled)
  where scope = 'agent';

create index if not exists idx_policy_session_enabled
  on public.policy (workspace_id, session_thread_id, enabled)
  where scope = 'session';

alter table public.policy enable row level security;

drop policy if exists policy_workspace_member_access on public.policy;
create policy policy_workspace_member_access
  on public.policy
  for all
  to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

comment on table public.policy is
  'Session policy definitions resolved by workspace, agent, and session scope before runtime dispatch.';
