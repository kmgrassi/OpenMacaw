begin;

-- The custom repo.* tools were retired in favor of command-line workspace
-- access through shell.exec. Keep the local tool-call battery useful by
-- rewriting the old repo-tool eval cases to shell.exec cases, then remove the
-- retired tool slugs from grants, templates, and the global tool catalog.

with suite as (
  select id
  from public.agent_eval_suite
  where workspace_id is null
    and slug = 'local-tool-calling'
),
case_updates(slug, name, prompt, tags, argument_hint) as (
  values
    (
      'repo-read-file-readme',
      'Read a known repository file with shell',
      'Use shell.exec to run this exact command from /workspace: sed -n 1,20p README.md. Then reply with the first heading you found.',
      array['shell', 'read-only', 'local-helper'],
      'README.md'
    ),
    (
      'repo-search-tool-parser',
      'Search repository with shell',
      'Use shell.exec to run rg -n "extractToolCalls" . from /workspace. Then reply with the best matching file path only.',
      array['shell', 'search', 'read-only', 'local-helper'],
      'extractToolCalls'
    ),
    (
      'repo-list-platform-scripts',
      'List a repository directory with shell',
      'Use shell.exec to run ls -la platform/scripts from /workspace. Then reply with whether manager-tool-call-battery.mjs is present.',
      array['shell', 'list', 'read-only', 'local-helper'],
      'platform/scripts'
    )
)
update public.agent_eval_case c
set
  name = case_updates.name,
  prompt = case_updates.prompt,
  tags = case_updates.tags,
  updated_at = now()
from suite
join case_updates on true
where c.suite_id = suite.id
  and c.slug = case_updates.slug;

with suite as (
  select id
  from public.agent_eval_suite
  where workspace_id is null
    and slug = 'local-tool-calling'
),
case_updates(slug, argument_hint) as (
  values
    ('repo-read-file-readme', 'README.md'),
    ('repo-search-tool-parser', 'extractToolCalls'),
    ('repo-list-platform-scripts', 'platform/scripts')
)
update public.agent_eval_case_assertion a
set
  tool_slug = 'shell.exec',
  expected_json = jsonb_build_object('argument_hints', array[case_updates.argument_hint]),
  updated_at = now()
from public.agent_eval_case c
join suite on suite.id = c.suite_id
join case_updates on case_updates.slug = c.slug
where a.case_id = c.id
  and a.assertion_type = 'tool_call_observed'
  and a.subject_kind = 'tool_call'
  and a.tool_slug in ('repo.list', 'repo.search', 'repo.read_file', 'repo.read_symbols');

with retired_tools as (
  select id
  from public.tool
  where slug in ('repo.list', 'repo.search', 'repo.read_file', 'repo.read_symbols')
)
delete from public.agent_tool_grant grant_row
using retired_tools
where grant_row.tool_id = retired_tools.id;

with retired_tools as (
  select id
  from public.tool
  where slug in ('repo.list', 'repo.search', 'repo.read_file', 'repo.read_symbols')
)
delete from public.agent_tool agent_tool_row
using retired_tools
where agent_tool_row.tool_id = retired_tools.id;

with retired_tools as (
  select id
  from public.tool
  where slug in ('repo.list', 'repo.search', 'repo.read_file', 'repo.read_symbols')
)
delete from public.tool_policy_template_tool template_tool
using retired_tools
where template_tool.tool_id = retired_tools.id;

delete from public.tool
where slug in ('repo.list', 'repo.search', 'repo.read_file', 'repo.read_symbols');

with shell_tool as (
  select id
  from public.tool
  where workspace_id is null
    and slug = 'shell.exec'
),
templates as (
  select id, slug
  from public.tool_policy_template
  where workspace_id is null
    and slug in ('coding', 'manager')
)
insert into public.tool_policy_template_tool (
  template_id,
  tool_policy_template_id,
  tool_id,
  workspace_id
)
select
  templates.id,
  templates.id,
  shell_tool.id,
  null
from templates
cross join shell_tool
where not exists (
  select 1
  from public.tool_policy_template_tool existing
  where existing.template_id = templates.id
    and existing.tool_id = shell_tool.id
);

with shell_tool as (
  select id
  from public.tool
  where workspace_id is null
    and slug = 'shell.exec'
),
template_by_agent as (
  select
    agent.id as agent_id,
    agent.workspace_id,
    agent.created_by_user_id,
    template.id as template_id
  from public.agent agent
  join public.tool_policy_template template
    on template.workspace_id is null
   and template.slug = case
     when agent.type = 'manager' then 'manager'
     else 'coding'
   end
  where agent.type in ('coding', 'manager')
    and coalesce(agent.status, 'active') <> 'archived'
),
grant_candidates as (
  select
    template_by_agent.agent_id,
    template_by_agent.workspace_id,
    template_by_agent.created_by_user_id,
    template_by_agent.template_id,
    shell_tool.id as tool_id
  from template_by_agent
  cross join shell_tool
)
insert into public.agent_tool_grant (
  agent_id,
  workspace_id,
  tool_id,
  mode,
  source,
  source_tool_template_id,
  reason,
  created_by_user_id,
  updated_at
)
select
  grant_candidates.agent_id,
  grant_candidates.workspace_id,
  grant_candidates.tool_id,
  'include',
  'template',
  grant_candidates.template_id,
  'applied default shell.exec tool policy template',
  grant_candidates.created_by_user_id,
  now()
from grant_candidates
where not exists (
  select 1
  from public.agent_tool_grant existing
  where existing.agent_id = grant_candidates.agent_id
    and existing.workspace_id = grant_candidates.workspace_id
    and existing.tool_id = grant_candidates.tool_id
);

commit;
