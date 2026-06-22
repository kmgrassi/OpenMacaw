with core_tools(slug, name, description, parameters, execution_kind, runner_kind) as (
  values
    (
      'repo.read_file',
      'Read repository file',
      'Read a file from the current repository workspace.',
      '{"type":"object","properties":{"path":{"type":"string","minLength":1}},"required":["path"],"additionalProperties":false}'::jsonb,
      'filesystem',
      'llm_tool_runner'
    ),
    (
      'repo.list',
      'List repository files',
      'List files under a repository directory.',
      '{"type":"object","properties":{"path":{"type":"string"},"maxEntries":{"type":"integer","minimum":1,"maximum":500}},"additionalProperties":false}'::jsonb,
      'filesystem',
      'llm_tool_runner'
    ),
    (
      'repo.search',
      'Search repository',
      'Search repository files for text.',
      '{"type":"object","properties":{"query":{"type":"string","minLength":1},"path":{"type":"string"},"maxResults":{"type":"integer","minimum":1,"maximum":100}},"required":["query"],"additionalProperties":false}'::jsonb,
      'filesystem',
      'llm_tool_runner'
    ),
    (
      'repo.read_symbols',
      'Read repository symbols',
      'Read symbol information for repository files when available.',
      '{"type":"object","properties":{"path":{"type":"string","minLength":1}},"required":["path"],"additionalProperties":false}'::jsonb,
      'filesystem',
      'llm_tool_runner'
    ),
    (
      'plan.create',
      'Create plan',
      'Create a plan in the current workspace.',
      '{"type":"object","properties":{"name":{"type":"string","minLength":1},"description":{"type":"string"}},"required":["name"],"additionalProperties":false}'::jsonb,
      'database',
      'planner'
    ),
    (
      'plan.read',
      'Read plan',
      'Read a plan from the current workspace.',
      '{"type":"object","properties":{"planId":{"type":"string","minLength":1}},"required":["planId"],"additionalProperties":false}'::jsonb,
      'database',
      'planner'
    ),
    (
      'plans.read',
      'List plans',
      'List plans in the current workspace.',
      '{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":100}},"additionalProperties":false}'::jsonb,
      'database',
      'planner'
    ),
    (
      'plan.delete',
      'Delete plan',
      'Delete a plan in the current workspace.',
      '{"type":"object","properties":{"planId":{"type":"string","minLength":1}},"required":["planId"],"additionalProperties":false}'::jsonb,
      'database',
      'planner'
    ),
    (
      'task.create',
      'Create task',
      'Create a work item task for a plan.',
      '{"type":"object","properties":{"planId":{"type":"string"},"name":{"type":"string","minLength":1},"description":{"type":"string"}},"required":["name"],"additionalProperties":false}'::jsonb,
      'database',
      'planner'
    ),
    (
      'task.read',
      'Read task',
      'Read a task from the current workspace.',
      '{"type":"object","properties":{"taskId":{"type":"string","minLength":1}},"required":["taskId"],"additionalProperties":false}'::jsonb,
      'database',
      'planner'
    ),
    (
      'task.update',
      'Update task',
      'Update a task in the current workspace.',
      '{"type":"object","properties":{"taskId":{"type":"string","minLength":1},"status":{"type":"string"},"name":{"type":"string"},"description":{"type":"string"}},"required":["taskId"],"additionalProperties":false}'::jsonb,
      'database',
      'planner'
    ),
    (
      'scheduled_task.create',
      'Create scheduled task',
      'Create a scheduled task for an agent.',
      '{"type":"object","properties":{"agentId":{"type":"string"},"instruction":{"type":"string","minLength":1},"scheduleAt":{"type":"string"},"enabled":{"type":"boolean"},"metadata":{"type":"object"}},"required":["instruction"],"additionalProperties":true}'::jsonb,
      'database',
      'llm_tool_runner'
    ),
    (
      'scheduled_task.read',
      'Read scheduled task',
      'Read a scheduled task in the current workspace.',
      '{"type":"object","properties":{"scheduledTaskId":{"type":"string","minLength":1}},"required":["scheduledTaskId"],"additionalProperties":false}'::jsonb,
      'database',
      'llm_tool_runner'
    ),
    (
      'scheduled_task.update',
      'Update scheduled task',
      'Update a scheduled task in the current workspace.',
      '{"type":"object","properties":{"scheduledTaskId":{"type":"string","minLength":1},"enabled":{"type":"boolean"},"metadata":{"type":"object"}},"required":["scheduledTaskId"],"additionalProperties":true}'::jsonb,
      'database',
      'llm_tool_runner'
    ),
    (
      'scheduled_task.list',
      'List scheduled tasks',
      'List scheduled tasks visible in the current workspace.',
      '{"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":100}},"additionalProperties":false}'::jsonb,
      'database',
      'llm_tool_runner'
    ),
    (
      'scheduled_task.delete',
      'Delete scheduled task',
      'Disable or delete a scheduled task in the current workspace.',
      '{"type":"object","properties":{"scheduledTaskId":{"type":"string","minLength":1}},"required":["scheduledTaskId"],"additionalProperties":false}'::jsonb,
      'database',
      'llm_tool_runner'
    ),
    (
      'git.run',
      'Run Git or GitHub command',
      'Run a scoped git or gh command in the registered local workspace.',
      '{"type":"object","properties":{"command":{"type":"string","minLength":1},"cwd":{"type":"string"}},"required":["command"],"additionalProperties":false}'::jsonb,
      'shell',
      'llm_tool_runner'
    ),
    (
      'shell.exec',
      'Run shell command',
      'Run a shell command in the registered local workspace.',
      '{"type":"object","properties":{"argv":{"type":"array","items":{"type":"string"},"minItems":1},"cwd":{"type":"string"},"timeoutMs":{"type":"integer","minimum":1000,"maximum":120000}},"required":["argv"],"additionalProperties":false}'::jsonb,
      'shell',
      'local_model_coding'
    ),
    (
      'apply_patch',
      'Apply patch',
      'Apply a unified patch in the registered local workspace.',
      '{"type":"object","properties":{"patch":{"type":"string","minLength":1}},"required":["patch"],"additionalProperties":false}'::jsonb,
      'filesystem_write',
      'local_model_coding'
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
  execution_kind,
  runner_kind,
  true,
  null,
  now()
from core_tools
where not exists (
  select 1
  from public.tool existing
  where existing.workspace_id is null
    and existing.slug = core_tools.slug
);

with templates(slug, name, description) as (
  values
    ('planner', 'Planning Agent', 'Default tools for planning agents.'),
    ('coding', 'Coding Agent', 'Default tools for coding agents.'),
    ('manager', 'Manager Agent', 'Default tools for manager agents.'),
    ('local_model_coding', 'Local Model Coding Agent', 'Default tools for local model coding agents.')
)
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
  slug,
  name,
  description,
  true,
  true,
  null,
  now()
from templates
where not exists (
  select 1
  from public.tool_policy_template existing
  where existing.workspace_id is null
    and existing.slug = templates.slug
);

with template_tool_slugs(template_slug, tool_slug) as (
  values
    ('planner', 'repo.read_file'),
    ('planner', 'repo.list'),
    ('planner', 'repo.search'),
    ('planner', 'repo.read_symbols'),
    ('planner', 'plan.create'),
    ('planner', 'task.create'),
    ('planner', 'task.update'),
    ('planner', 'plans.read'),
    ('planner', 'plan.read'),
    ('planner', 'plan.delete'),
    ('planner', 'task.read'),
    ('planner', 'scheduled_task.create'),
    ('planner', 'scheduled_task.read'),
    ('planner', 'scheduled_task.update'),
    ('planner', 'scheduled_task.list'),
    ('planner', 'scheduled_task.delete'),
    ('coding', 'repo.read_file'),
    ('coding', 'repo.list'),
    ('coding', 'repo.search'),
    ('coding', 'repo.read_symbols'),
    ('coding', 'plan.create'),
    ('coding', 'task.create'),
    ('coding', 'task.update'),
    ('coding', 'plans.read'),
    ('coding', 'plan.read'),
    ('coding', 'plan.delete'),
    ('coding', 'task.read'),
    ('coding', 'scheduled_task.create'),
    ('coding', 'scheduled_task.read'),
    ('coding', 'scheduled_task.update'),
    ('coding', 'scheduled_task.list'),
    ('coding', 'scheduled_task.delete'),
    ('manager', 'git.run'),
    ('manager', 'repo.read_file'),
    ('manager', 'repo.list'),
    ('manager', 'repo.search'),
    ('manager', 'repo.read_symbols'),
    ('manager', 'plan.create'),
    ('manager', 'task.create'),
    ('manager', 'task.update'),
    ('manager', 'plans.read'),
    ('manager', 'plan.read'),
    ('manager', 'plan.delete'),
    ('manager', 'task.read'),
    ('manager', 'scheduled_task.create'),
    ('manager', 'scheduled_task.read'),
    ('manager', 'scheduled_task.update'),
    ('manager', 'scheduled_task.list'),
    ('manager', 'scheduled_task.delete'),
    ('local_model_coding', 'repo.read_file'),
    ('local_model_coding', 'repo.list'),
    ('local_model_coding', 'repo.search'),
    ('local_model_coding', 'git.run'),
    ('local_model_coding', 'shell.exec'),
    ('local_model_coding', 'apply_patch'),
    ('local_model_coding', 'scheduled_task.create'),
    ('local_model_coding', 'scheduled_task.read'),
    ('local_model_coding', 'scheduled_task.update'),
    ('local_model_coding', 'scheduled_task.list'),
    ('local_model_coding', 'scheduled_task.delete'),
    ('local_model_coding', 'skill.create')
),
template_tools as (
  select
    template.id as template_id,
    tool.id as tool_id
  from template_tool_slugs
  join public.tool_policy_template template
    on template.workspace_id is null
   and template.slug = template_tool_slugs.template_slug
  join public.tool tool
    on tool.workspace_id is null
   and tool.slug = template_tool_slugs.tool_slug
)
insert into public.tool_policy_template_tool (
  template_id,
  tool_policy_template_id,
  tool_id,
  workspace_id
)
select
  template_id,
  template_id,
  tool_id,
  null
from template_tools
where not exists (
  select 1
  from public.tool_policy_template_tool existing
  where existing.template_id = template_tools.template_id
    and existing.tool_id = template_tools.tool_id
);
