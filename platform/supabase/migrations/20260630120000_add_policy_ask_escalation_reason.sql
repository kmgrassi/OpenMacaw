alter table public.escalation
  drop constraint if exists escalation_reason_kind_check;

alter table public.escalation
  add constraint escalation_reason_kind_check check (reason_kind is null or reason_kind in (
    'ambiguous_intent',
    'missing_context',
    'policy_uncertain',
    'policy_ask',
    'destructive_action_unverified',
    'out_of_scope',
    'stuck_after_retries',
    'other'
  ));
