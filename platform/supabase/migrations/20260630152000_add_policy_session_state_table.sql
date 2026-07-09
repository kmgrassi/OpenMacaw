create table if not exists public.policy_session_state (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_thread_id text not null,
  key text not null,
  value_numeric double precision,
  value_json jsonb,
  updated_at timestamptz not null default now(),
  unique (session_thread_id, key)
);

create index if not exists idx_policy_session_state_workspace_updated_at
  on public.policy_session_state (workspace_id, updated_at desc);

alter table public.policy_session_state enable row level security;

drop policy if exists policy_session_state_workspace_member_access on public.policy_session_state;
create policy policy_session_state_workspace_member_access
  on public.policy_session_state
  for all
  to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

comment on table public.policy_session_state is
  'Durable per-session policy counters and accumulators keyed by runtime session identity.';
