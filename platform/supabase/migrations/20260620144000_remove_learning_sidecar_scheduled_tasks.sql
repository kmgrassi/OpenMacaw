with retired_tasks as (
  select id
  from public.scheduled_task
  where delivery->>'kind' in ('learning_reflection', 'learning_distillation')
     or metadata->>'kind' = 'learning_operability_remediation'
)
delete from public.scheduled_task_run
where scheduled_task_id in (select id from retired_tasks);

delete from public.scheduled_task
where delivery->>'kind' in ('learning_reflection', 'learning_distillation')
   or metadata->>'kind' = 'learning_operability_remediation';
