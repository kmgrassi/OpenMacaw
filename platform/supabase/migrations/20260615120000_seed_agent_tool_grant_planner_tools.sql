with grant_tools(slug, name, description, parameters) as (
  values
    (
      'agent_tool_grant.create',
      'Create agent tool grant',
      'Autonomously grant an existing catalog tool to an agent in the current workspace. Writes source=system and requires an operability reason.',
      $${
        "type": "object",
        "required": ["agentId", "reason"],
        "properties": {
          "agentId": { "type": "string", "format": "uuid" },
          "toolId": { "type": "string", "format": "uuid" },
          "toolSlug": { "type": "string" },
          "reason": { "type": "string", "minLength": 1 }
        },
        "oneOf": [
          { "required": ["toolId"] },
          { "required": ["toolSlug"] }
        ]
      }$$::jsonb
    ),
    (
      'agent_tool_grant.update',
      'Update agent tool grant',
      'Autonomously update an existing agent tool grant in the current workspace. Writes source=system and requires an operability reason.',
      $${
        "type": "object",
        "required": ["agentId", "mode", "reason"],
        "properties": {
          "agentId": { "type": "string", "format": "uuid" },
          "toolId": { "type": "string", "format": "uuid" },
          "toolSlug": { "type": "string" },
          "mode": { "type": "string", "enum": ["include", "exclude"] },
          "reason": { "type": "string", "minLength": 1 }
        },
        "oneOf": [
          { "required": ["toolId"] },
          { "required": ["toolSlug"] }
        ]
      }$$::jsonb
    )
)
update public.tool
set
  name = grant_tools.name,
  description = grant_tools.description,
  parameters = grant_tools.parameters,
  function_name = grant_tools.slug,
  execution_kind = 'database',
  runner_kind = 'planner',
  enabled = true,
  updated_at = now()
from grant_tools
where public.tool.workspace_id is null
  and public.tool.slug = grant_tools.slug;

with grant_tools(slug, name, description, parameters) as (
  values
    (
      'agent_tool_grant.create',
      'Create agent tool grant',
      'Autonomously grant an existing catalog tool to an agent in the current workspace. Writes source=system and requires an operability reason.',
      $${
        "type": "object",
        "required": ["agentId", "reason"],
        "properties": {
          "agentId": { "type": "string", "format": "uuid" },
          "toolId": { "type": "string", "format": "uuid" },
          "toolSlug": { "type": "string" },
          "reason": { "type": "string", "minLength": 1 }
        },
        "oneOf": [
          { "required": ["toolId"] },
          { "required": ["toolSlug"] }
        ]
      }$$::jsonb
    ),
    (
      'agent_tool_grant.update',
      'Update agent tool grant',
      'Autonomously update an existing agent tool grant in the current workspace. Writes source=system and requires an operability reason.',
      $${
        "type": "object",
        "required": ["agentId", "mode", "reason"],
        "properties": {
          "agentId": { "type": "string", "format": "uuid" },
          "toolId": { "type": "string", "format": "uuid" },
          "toolSlug": { "type": "string" },
          "mode": { "type": "string", "enum": ["include", "exclude"] },
          "reason": { "type": "string", "minLength": 1 }
        },
        "oneOf": [
          { "required": ["toolId"] },
          { "required": ["toolSlug"] }
        ]
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
from grant_tools
where not exists (
  select 1
  from public.tool existing
  where existing.workspace_id is null
    and existing.slug = grant_tools.slug
);

with planner_template as (
  select id
  from public.tool_policy_template
  where slug = 'planner'
    and workspace_id is null
  order by created_at asc
  limit 1
),
grant_tools as (
  select id as tool_id
  from public.tool
  where workspace_id is null
    and slug in ('agent_tool_grant.create', 'agent_tool_grant.update')
)
insert into public.tool_policy_template_tool (
  template_id,
  tool_policy_template_id,
  tool_id,
  workspace_id
)
select
  planner_template.id,
  planner_template.id,
  grant_tools.tool_id,
  null
from planner_template
cross join grant_tools
where not exists (
  select 1
  from public.tool_policy_template_tool existing
  where existing.template_id = planner_template.id
    and existing.tool_id = grant_tools.tool_id
);
