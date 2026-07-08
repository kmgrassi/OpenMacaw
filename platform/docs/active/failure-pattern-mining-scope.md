# Failure Pattern Mining — Scope

## Goal

Add a durable derived layer for recurring agent failure mechanisms, backed by
the existing run, tool-call, and eval evidence tables.

OpenMacaw already has the raw substrate:

- `broker_run` and `broker_task` record execution history.
- `agent_tool_call_event` records ordered tool-call behavior.
- `agent_eval_run`, `agent_eval_run_case`,
  `agent_eval_assertion_result`, and `agent_eval_observation` record eval
  suites, case results, assertion results, and typed evidence.

This scope does **not** replace those logs. It adds the missing learning object:
a normalized `failure_pattern` that answers "what recurring mechanism explains
these bad runs, and what should the harness change?" rather than only "what
happened in this run?"

## Motivation

Logs are necessary but not sufficient for self-improvement. They preserve the
raw event stream for one run. A failure pattern clusters evidence across runs
into an actionable explanation.

Example:

> On repo-editing tasks, the agent repeatedly edits before inspecting dirty
> worktree state. The verifier outcome varies, but the causal mechanism is
> missing preflight source-control inspection.

That object needs lifecycle, confidence, evidence links, and mitigation status.
If it stays as log text, every learning agent must rediscover the same cluster
from scratch, and OpenMacaw cannot reliably track whether a mitigation reduced
recurrence.

## Non-Goals

- **No raw trace duplication.** `failure_pattern` rows summarize and link back
  to evidence; authoritative details remain in the existing tables.
- **No harness self-editing in this slice.** This scope stops at storing and
  reviewing mined patterns. Later scopes can use patterns to propose context,
  workflow, tool-policy, or runner changes.
- **No replacement for eval assertions.** Assertions still determine case-level
  pass/fail. Failure patterns explain recurring mechanisms across those
  outcomes.
- **No free-form log bucket.** Pattern rows should stay structured enough to
  query, rank, and close.

## Data Model

OpenMacaw owns the migration under `platform/supabase/migrations/` with the
matching reference SQL in `docs/supabase/openmacaw-schema.sql`.

### `failure_pattern`

A derived, workspace-scoped learning object for one recurring failure mode.

- `id`
- `workspace_id`
- `title`
- `status` — `proposed` | `confirmed` | `mitigated` | `dismissed`
- `pattern_kind` — registry-owned snake_case kind, such as
  `missing_preflight`, `tool_misuse`, `context_gap`, `workflow_gap`,
  `policy_gap`, `verifier_gap`, `model_limit`, `external_flake`
- `affected_surface` — `context` | `workflow` | `tool_policy` | `prompt` |
  `runner` | `eval` | `unknown`
- `verifier_cause` — terminal eval/verifier cause when available, such as
  `timeout`, `missing_artifact`, `assertion_failed`, `wrong_tool`,
  `unexpected_tool`, `runtime_error`
- `causal_mechanism` — concise text explanation of the agent behavior or
  harness behavior believed to cause the failures
- `severity` — `low` | `medium` | `high` | `critical`
- `confidence` — numeric 0..1
- `support_count` — count of linked evidence rows used for the current claim
- `first_seen_at`
- `last_seen_at`
- `summary`
- `proposed_mitigation`
- `metadata` jsonb
- `created_by_agent_id`
- `created_by_user_id`
- `created_at`
- `updated_at`
- `mitigated_at`
- `dismissed_at`
- `dismissal_reason`

Constraints:

- `workspace_id` is required and covered by RLS.
- `status`, `affected_surface`, and `severity` should use check constraints.
- `pattern_kind` remains registry-owned so new mined categories do not require
  a schema migration.
- At most one of `created_by_agent_id` and `created_by_user_id` may be set.

### `failure_pattern_evidence`

Join table linking a pattern to the existing evidence that supports it.

- `id`
- `failure_pattern_id`
- `workspace_id`
- `run_id` — references `broker_run.run_id` when the evidence is a product run
- `broker_task_id` — references `broker_task.task_id` when a turn/task row is
  the key evidence
- `agent_tool_call_event_id`
- `eval_run_id`
- `eval_run_case_id`
- `assertion_result_id`
- `eval_observation_id`
- `message_id`
- `work_item_id`
- `evidence_role` — `supporting_failure` | `preserved_success` |
  `counterexample` | `diagnostic_context`
- `evidence_note`
- `created_at`

This table intentionally allows several nullable references because evidence
can come from product runs, eval runs, message transcripts, tool events, or
assertion results. Application code should require at least one concrete
evidence pointer.

### Optional Later Table: `failure_pattern_mitigation`

Do not add this until OpenMacaw has a concrete harness-edit flow. The likely
shape is:

- `id`
- `failure_pattern_id`
- `workspace_id`
- `mitigation_kind` — `context_update` | `workflow_change` |
  `tool_policy_change` | `prompt_change` | `runner_change` | `eval_change`
- `status` — `proposed` | `accepted` | `rejected` | `rolled_back`
- `linked_context_version_id`
- `linked_pr_url`
- `validation_eval_run_id`
- `summary`
- `created_at`
- `updated_at`

## Runtime and Platform Flow

### Pattern Mining

The first miner can be a scheduled or manually triggered learning-agent job:

1. Select recent failed eval cases and failed/errored product runs.
2. Read linked messages, tool-call events, assertion results, and observations.
3. Cluster by causal mechanism, not just terminal verifier cause.
4. Upsert `failure_pattern` rows.
5. Attach evidence links with roles.

The clustering prompt should explicitly distinguish:

- terminal verifier cause, such as timeout or missing artifact
- causal status of relevant agent behavior
- abstract mechanism exposed by the trace
- passing behaviors that should be preserved

### Human Review

The UI should treat patterns like an issue queue for agent behavior:

- proposed patterns need confirmation or dismissal
- confirmed patterns can be ranked by severity, confidence, and support count
- mitigated patterns remain searchable and can reopen if fresh evidence appears

### Agent Consumption

Learning and manager agents should consume confirmed patterns as compact
context, not by rereading all supporting logs each turn. The pattern row is the
summary; linked evidence is the audit trail.

## API Surface

First-cut API routes:

- `GET /api/failure-patterns`
  - filter by `status`, `affectedSurface`, `severity`, `patternKind`
  - include counts and latest evidence timestamp
- `GET /api/failure-patterns/:id`
  - include evidence rows and selected linked run/eval summaries
- `PATCH /api/failure-patterns/:id`
  - confirm, dismiss, reopen, mark mitigated, update summary/mitigation
- `POST /api/failure-patterns/:id/evidence`
  - attach explicit evidence from a user or agent

Use camelCase at the API boundary and convert to snake_case in repositories, per
platform conventions.

## Tool Surface

Database-backed tools should use normal CRUD names:

- `failure_pattern.list`
- `failure_pattern.read`
- `failure_pattern.create`
- `failure_pattern.update`
- `failure_pattern_evidence.create`

Do not add a vague `failure_pattern.manage` tool.

## Acceptance Criteria

1. Migrations create `failure_pattern` and `failure_pattern_evidence` with RLS,
   indexes, comments, and generated schema updates.
2. Repository/API code exposes list/read/update and evidence attachment.
3. The learning-agent tool catalog includes read/list and evidence attachment;
   create/update can be granted only to learning or manager agents by default.
4. A first mining command can produce proposed patterns from existing
   `agent_eval_*`, `broker_run`, and `agent_tool_call_event` rows.
5. The dashboard can show proposed/confirmed/mitigated/dismissed patterns with
   evidence links.
6. Tests cover schema constraints, repository mapping, API filtering, and tool
   permissions.

## PR Slices

1. **Schema + generated types**
   - Add migration and reference SQL updates.
   - Sync generated Supabase types.
   - Add RLS policies and indexes.

2. **API + repositories**
   - Add typed repository functions.
   - Add list/read/update/evidence routes.
   - Add tests for filters and workspace isolation.

3. **Agent tools**
   - Add CRUD-shaped database-backed tools.
   - Seed catalog rows and conservative default grants.
   - Add restricted-allowlist coverage where needed.

4. **Miner command**
   - Add a deterministic first-pass miner over failed eval cases and failed
     product runs.
   - Write proposed patterns only; humans confirm them.

5. **Dashboard**
   - Add a compact pattern queue with status controls and evidence drill-in.

## Open Questions

- Should `pattern_kind` start as a loose registry string or a constrained
  contract constant with an enum-drift check?
- Should dismissed patterns be eligible for automatic reopening when new
  high-confidence evidence appears?
- Should confirmed patterns feed directly into `agent.context`, or should that
  always go through the separate persistent-context approval flow?
- Which agents receive create/update grants by default: learning only, manager
  only, or both?
