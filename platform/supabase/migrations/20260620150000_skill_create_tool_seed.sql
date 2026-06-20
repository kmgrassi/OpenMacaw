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
