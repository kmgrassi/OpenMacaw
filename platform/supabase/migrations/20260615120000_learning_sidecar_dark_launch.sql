-- Learning sidecar production rollout guardrail.
--
-- The production-readiness plan dark-launches learning for one internal
-- workspace first. Keep new workspaces opted out until the rollout explicitly
-- enables them.

alter table public.workspace_settings
  alter column learning_enabled set default false;

insert into public.workspace_settings (
  workspace_id,
  learning_enabled,
  tracker_kind,
  tracker_credential_id,
  updated_at,
  updated_by_user_id
)
select
  w.id,
  false,
  'database',
  null,
  now(),
  null
from public.workspaces w
where not exists (
  select 1
  from public.workspace_settings ws
  where ws.workspace_id = w.id
);

update public.scheduled_task st
set
  enabled = false,
  updated_at = now(),
  metadata =
    coalesce(st.metadata, '{}'::jsonb)
    || jsonb_build_object('disabled_by', 'learning_sidecar_dark_launch')
from public.workspace_settings ws
where st.workspace_id = ws.workspace_id
  and st.delivery->>'kind' = 'learning_distillation'
  and ws.learning_enabled = false
  and st.enabled = true;

comment on column public.workspace_settings.learning_enabled is
  'Whether workspace learning/reflection is enabled. Defaults off for controlled rollout; enable explicitly per workspace.';

create or replace function public.ensure_default_workspace_for_user(
  p_user_id uuid,
  p_workspace_name text default 'Personal Workspace'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workspace_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('openmacaw_default_workspace'), hashtext(p_user_id::text));

  select wm.workspace_id
    into v_workspace_id
  from public.workspace_members wm
  where wm.user_id = p_user_id
  order by wm.created_at asc
  limit 1;

  if v_workspace_id is not null then
    insert into public.workspace_settings (
      workspace_id,
      learning_enabled,
      tracker_kind,
      tracker_credential_id,
      updated_at,
      updated_by_user_id
    )
    values (v_workspace_id, false, 'database', null, now(), null)
    on conflict (workspace_id) do nothing;

    return v_workspace_id;
  end if;

  insert into public.workspaces (name, owner_user_id)
  values (coalesce(nullif(trim(p_workspace_name), ''), 'Personal Workspace'), p_user_id)
  returning id into v_workspace_id;

  insert into public.workspace_settings (
    workspace_id,
    learning_enabled,
    tracker_kind,
    tracker_credential_id,
    updated_at,
    updated_by_user_id
  )
  values (v_workspace_id, false, 'database', null, now(), null)
  on conflict (workspace_id) do nothing;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_workspace_id, p_user_id, 'owner')
  on conflict (workspace_id, user_id) do update set role = excluded.role;

  return v_workspace_id;
end;
$$;
