create table if not exists public.skill (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_id uuid not null references public.agent(id) on delete cascade,
  name text not null,
  description text not null,
  body text not null,
  status text not null default 'draft',
  copied_from_skill_id uuid references public.skill(id) on delete set null,
  created_by_agent_id uuid references public.agent(id) on delete set null,
  created_by_user_id uuid references public."user"(id) on delete set null,
  source_run_id uuid,
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

create unique index if not exists skill_agent_name_key on public.skill (agent_id, name);
create index if not exists skill_workspace_status_updated_idx on public.skill (workspace_id, status, updated_at desc);
create index if not exists skill_workspace_agent_idx on public.skill (workspace_id, agent_id);
create index if not exists skill_source_run_idx on public.skill (source_run_id) where source_run_id is not null;

alter table public.skill enable row level security;
drop policy if exists openmacaw_workspace_member_access on public.skill;
create policy openmacaw_workspace_member_access on public.skill for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop trigger if exists set_updated_at on public.skill;
create trigger set_updated_at before update on public.skill
  for each row execute function public.set_updated_at();
