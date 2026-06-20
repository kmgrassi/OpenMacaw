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
  constraint skill_name_format_check check (
    name ~ '^[a-z0-9-]{1,64}$'
    and name not in ('claude', 'anthropic')
  ),
  constraint skill_description_length_check check (char_length(description) <= 1024),
  constraint skill_body_not_empty_check check (length(trim(body)) > 0),
  constraint skill_status_check check (status in ('draft', 'approved', 'archived')),
  constraint skill_agent_name_unique unique (agent_id, name)
);

create index if not exists skill_workspace_agent_status_idx
  on public.skill (workspace_id, agent_id, status, updated_at desc);

create index if not exists skill_copied_from_skill_idx
  on public.skill (copied_from_skill_id)
  where copied_from_skill_id is not null;

drop trigger if exists set_updated_at on public.skill;
create trigger set_updated_at
  before update on public.skill
  for each row execute function public.set_updated_at();

alter table public.skill enable row level security;

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
