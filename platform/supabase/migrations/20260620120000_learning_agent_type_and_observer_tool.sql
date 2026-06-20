alter table public.agent
  drop constraint if exists agent_type_check;

alter table public.agent
  add constraint agent_type_check
  check (
    type is null
    or type in ('coding', 'planning', 'manager', 'learning', 'router', 'custom')
  )
  not valid;

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
  'agent_run.read',
  'Read agent run transcript',
  'Read messages and tool-call events for another run in the current workspace. Restricted to the learning agent.',
  '{
    "type": "object",
    "properties": {
      "run_id": {
        "type": "string",
        "description": "The run_id to inspect."
      },
      "message_limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100,
        "description": "Maximum transcript messages to return. Defaults to 10."
      },
      "tool_event_limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 200,
        "description": "Maximum tool-call events to return. Defaults to 50."
      },
      "include_tool_events": {
        "type": "boolean",
        "description": "Whether to include tool-call event rows. Defaults to true."
      }
    },
    "required": ["run_id"],
    "additionalProperties": false
  }'::jsonb,
  'agent_run.read',
  'database',
  'llm_tool_runner',
  true,
  null,
  now()
where not exists (
  select 1
  from public.tool existing
  where existing.workspace_id is null
    and existing.slug = 'agent_run.read'
);

insert into public.tool_policy_template (
  slug,
  name,
  description,
  system_managed,
  enabled,
  workspace_id,
  updated_at
)
select
  'learning',
  'Learning Agent',
  'Read-only transcript observation and learning-output tools for the system learning agent.',
  true,
  true,
  null,
  now()
where not exists (
  select 1
  from public.tool_policy_template
  where slug = 'learning'
    and workspace_id is null
);

with template as (
  select id
  from public.tool_policy_template
  where slug = 'learning'
    and workspace_id is null
  order by created_at asc
  limit 1
),
template_tools as (
  select tool.id as tool_id
  from public.tool
  where tool.workspace_id is null
    and tool.slug in (
      'agent_run.read',
      'memory.search',
      'memory.create',
      'skill.create',
      'scheduled_task.create'
    )
)
insert into public.tool_policy_template_tool (
  template_id,
  tool_policy_template_id,
  tool_id,
  workspace_id
)
select
  template.id,
  template.id,
  template_tools.tool_id,
  null
from template
cross join template_tools
where not exists (
  select 1
  from public.tool_policy_template_tool existing
  where existing.template_id = template.id
    and existing.tool_id = template_tools.tool_id
);
