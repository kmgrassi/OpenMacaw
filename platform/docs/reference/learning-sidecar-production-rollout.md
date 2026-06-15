# Learning Sidecar Production Rollout

Use this runbook for P5 of
[`learning-sidecar-production-readiness-scope.md`](../active/learning-sidecar-production-readiness-scope.md).
The application repo now defaults `workspace_settings.learning_enabled` to
`false`; production rollout is opt-in per workspace.

## 1. Confirm rollout state

Run before deploy and after the migration:

```sql
select
  w.id as workspace_id,
  w.name,
  u.email as owner_email,
  coalesce(ws.learning_enabled, false) as learning_enabled,
  ws.updated_at
from public.workspaces w
join public."user" u on u.id = w.owner_user_id
left join public.workspace_settings ws on ws.workspace_id = w.id
order by learning_enabled desc, w.created_at asc;
```

Only the internal `kmgrassi` workspace should be enabled during dark launch:

```sql
update public.workspace_settings ws
set learning_enabled = true,
    updated_at = now(),
    updated_by_user_id = null
from public.workspaces w
join public."user" u on u.id = w.owner_user_id
where ws.workspace_id = w.id
  and u.email = '<internal-workspace-owner-email>';
```

Disable every other workspace explicitly:

```sql
update public.workspace_settings ws
set learning_enabled = false,
    updated_at = now(),
    updated_by_user_id = null
from public.workspaces w
join public."user" u on u.id = w.owner_user_id
where ws.workspace_id = w.id
  and u.email <> '<internal-workspace-owner-email>';
```

Re-enable the internal workspace's distillation row if the dark-launch
migration disabled it:

```sql
update public.scheduled_task st
set enabled = true,
    updated_at = now(),
    metadata = coalesce(st.metadata, '{}'::jsonb) || jsonb_build_object('enabled_by', 'learning_sidecar_dark_launch_rollout')
where st.workspace_id = '<internal-workspace-id>'::uuid
  and st.delivery->>'kind' = 'learning_distillation';
```

## 2. Verify prerequisites

Reflection needs a stored workspace provider credential. Environment variables
alone are not enough.

```sql
select
  c.workspace_id,
  c.provider,
  c.label,
  c.is_active,
  c.updated_at
from public.credential c
where c.workspace_id = '<internal-workspace-id>'::uuid
order by c.updated_at desc;
```

Distillation also needs platform API task environment:

- `OPENAI_API_KEY`
- `LEARNING_DISTILLATION_MODEL`
- frozen embedding model choice via `LEARNING_EMBEDDING_MODEL` or the deployed default

The runtime task must set:

- `PLATFORM_LEARNING_HANDLER_ENDPOINT`
- `PLATFORM_LEARNING_HANDLER_API_KEY`, exactly equal to platform API
  `SUPABASE_SERVICE_ROLE_KEY`

## 3. Verify reflection

Complete a real agent run in the internal workspace, then check the scheduled
task row and memory writes:

```sql
select
  st.id,
  st.workspace_id,
  st.agent_id,
  st.delivery,
  st.last_run_status,
  st.last_error,
  st.last_run_at
from public.scheduled_task st
where st.workspace_id = '<internal-workspace-id>'::uuid
  and st.delivery->>'kind' = 'learning_reflection'
order by st.updated_at desc
limit 20;
```

```sql
select
  id,
  workspace_id,
  agent_id,
  scope,
  source_run_id,
  source_task_id,
  created_at,
  left(body, 200) as body_preview
from public.memory_items
where workspace_id = '<internal-workspace-id>'::uuid
  and source_run_id is not null
order by created_at desc
limit 20;
```

## 4. Verify distillation

Find the enabled nightly distillation task:

```sql
select
  id,
  workspace_id,
  agent_id,
  enabled,
  next_run_at,
  delivery
from public.scheduled_task
where workspace_id = '<internal-workspace-id>'::uuid
  and delivery->>'kind' = 'learning_distillation'
order by next_run_at asc;
```

Manually dispatch it through:

```bash
curl -X POST \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  "$PLATFORM_API_URL/api/internal/scheduled-tasks/<scheduled-task-id>/dispatch"
```

Then let the runtime-delivered scheduled path run separately and verify
candidate memories:

```sql
select
  id,
  tags,
  source_task_id,
  created_at,
  left(body, 240) as body_preview
from public.memory_items
where workspace_id = '<internal-workspace-id>'::uuid
  and tags->>'source' = 'learning_distillation'
order by created_at desc
limit 20;
```

## 5. Learning-job status query

Use this query for a dashboard panel or log-derived alert. Any recent
`failed` row or non-empty `error` should page the owning team during rollout;
404s indicate runtime/platform route drift.

```sql
select
  str.created_at,
  str.started_at,
  str.finished_at,
  str.status,
  str.error,
  str.workspace_id,
  str.agent_id,
  str.scheduled_task_id,
  st.delivery->>'kind' as learning_job_kind,
  st.last_run_status,
  st.last_error
from public.scheduled_task_run str
join public.scheduled_task st on st.id = str.scheduled_task_id
where st.delivery->>'kind' in ('learning_reflection', 'learning_distillation')
order by str.created_at desc
limit 100;
```
