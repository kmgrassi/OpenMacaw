# Session Policy Engine — Platform + Runtime Scope

## Goal

Add a **stateful, per-session policy engine** that decides whether a given
agent action may proceed *at the moment it is attempted*, on top of the
existing static tool-grant allowlist. Today an agent's capabilities are a fixed
set resolved once at session/turn start (`agent_tool_grant` →
`ToolRegistry.execute/4` membership check). That answers *"does this agent have
tool X?"* but cannot answer *behavioral* questions like *"has this session
already spent $10?"*, *"is this the 51st tool call?"*, or *"should a human
approve this shell command first?"*

This scope adds a policy layer that:

- Evaluates a chain of **policies** on every gated event (primarily
  `tool_call`), returning a verdict of `allow`, `deny`, or `ask`.
- Carries **mutable per-session state** (counters, accrued cost, risk score) so
  budgets, rate limits, and escalating risk are expressible.
- Composes across **three tiers** — `session`, `agent`, `workspace` — with a
  deterministic precedence (first `deny` wins; `ask` escalates to a human gate).
- Reuses OpenMacaw's existing approval primitives (`approval_state`,
  `escalation`) rather than inventing a parallel human-in-the-loop path.

This is the OpenMacaw analog of the policy engine in the Omnigent meta-harness
(`docs/openmacaw-vs-omnigent.md`), adapted to our data model, snake_case enum
conventions, PostgREST-only runtime DB access, and Elixir enforcement point.

## Motivation

The tool-grant model (`agent-tool-grant-data-model-scope.md`) is the right
answer for *capability* — what an agent is allowed to touch at all. It is the
wrong tool for *governance* — bounding cost, rate, and risk **during** a run.
The two are orthogonal and should compose:

| Question | Mechanism | Status |
| --- | --- | --- |
| Does this agent have tool X at all? | `agent_tool_grant` allowlist | exists |
| Which runner/model/credential? | `routing_rule` execution profile | exists |
| May this *specific* call proceed *now*, given session state? | **session policy engine** | this doc |

The enforcement seam already exists: `ToolRegistry.execute/4`
(`runtime/apps/orchestrator/lib/symphony_elixir/tool_registry.ex:161`) is the
single chokepoint every tool call passes through. Today it only runs
`allowed?(name, allowed)`. The policy engine slots in immediately after that
check, before `dispatch/3`.

## Non-Goals

- **Not** a replacement for tool grants or execution profiles. Policies run
  *after* the allowlist gate; a denied grant is still denied regardless of
  policy.
- **Not** general workflow approval (PR review, manager escalation). It reuses
  the `escalation` table for the human gate but does not change escalation
  semantics.
- **Not** a sandbox/network enforcement layer. Filesystem/network containment
  stays in the runtime (`shell_executor.ex` path boundary,
  `production-container-tool-execution-scope.md`). A policy may *gate* an OS
  tool, but the hard boundary remains the runner.
- **No** new credential or secret handling. PII/secret-scanning policies are
  listed as future built-ins but are out of scope for the first cut.

## Policy Model

### Verdicts

A policy evaluation returns exactly one of (snake_case, per repo convention):

- `allow` — proceed.
- `deny` — block; the agent receives an in-band tool error (mirrors the
  existing `:not_allowed` shape at `tool_registry.ex:217`).
- `ask` — pause and require human approval. Approval → `allow`, refusal →
  `deny`.
- (internally) `abstain` — policy does not apply to this event; contributes no
  verdict.

### Tiers and precedence

Three scopes, evaluated in order, **first `deny` short-circuits**:

1. `session` — set on the live session, the tightest scope. Lets a user clamp
   their own run (e.g. "ask before every shell command in this session").
2. `agent` — declared as part of the agent's configuration.
3. `workspace` — admin defaults for the whole workspace.

Resolution rule:

- Any `deny` from any tier ⇒ `deny` (stop).
- Else any `ask` ⇒ `ask` (stop, await human).
- Else `allow`.

This is intentionally the same "tightest wins" model as the grant resolver's
explicit `exclude`, so the mental model carries over.

### Policy kinds (built-in registry)

Policies are registry-driven, exactly like tools — no hardcoded policy logic
scattered through runner code. Each kind has a stable snake_case `kind`, a Zod
parameter schema, and a runtime evaluator. First-cut built-ins:

| `kind` | Params | Event | Verdict logic |
| --- | --- | --- | --- |
| `max_tool_calls_per_session` | `limit` | `tool_call` | `deny` once session call count ≥ `limit` |
| `cost_budget` | `max_cost_usd`, `ask_thresholds_usd[]` | `tool_call` / `llm_request` | `ask` at each threshold, `deny` over `max` |
| `ask_on_shell` | — | `tool_call` (shell/os tools) | `ask` |
| `ask_on_tool` | `tools[]` | `tool_call` | `ask` if tool ∈ list |
| `block_tools` | `tools[]` | `tool_call` | `deny` if tool ∈ list (dynamic complement to a grant) |
| `risk_score` | `guarded_tools[]`, `threshold`, `weights` | `tool_call` | accrue points; `ask`/`deny` once over threshold |

Future built-ins (explicitly out of first cut, listed so the schema leaves room):
`user_daily_cost_budget` (cross-session), `deny_pii_in_llm_request`,
`github_scope`, `block_working_dir_changes`.

The registry must be extensible without a schema migration: adding a `kind`
means adding an evaluator module + Zod schema, mirroring how a new tool is
added to `ToolRegistry`.

## Data Model

OpenMacaw owns the migration under `platform/supabase/migrations/` with the
matching reference SQL in `docs/supabase/openmacaw-schema.sql`. Default to
explicit columns over opaque JSONB (runtime DB conventions); only the
kind-specific `params` is JSONB because its shape is per-`kind`.

### `policy`

A configured policy instance at one tier.

- `id`
- `workspace_id` (RLS key; non-null)
- `scope` — `workspace` | `agent` | `session`
- `agent_id` — non-null when `scope = agent`
- `session_thread_id` — non-null when `scope = session`
- `kind` — snake_case policy kind from the registry
- `params` — JSONB validated by the kind's Zod schema at write time
- `priority` — integer ordering within a tier
- `enabled` — boolean
- `source` — `manual` | `system` | `template` (audit provenance, mirrors
  `agent_tool_grant.source`)
- `reason`, `created_by_user_id`, `created_at`

Constraints:

- `CHECK` that `agent_id`/`session_thread_id` presence matches `scope` (the DB
  enforces correctness, per platform conventions).
- `kind` is **not** a DB enum (registry is code-owned and extensible); validity
  is enforced in contracts. A `CHECK` against a known-kinds list is acceptable
  only if kept in lockstep with the registry via the cross-repo enum drift
  check pattern (`scripts/check-cross-repo-enums.mjs`).

### `policy_session_state`

Mutable per-session accumulator. One row per `(session_thread_id, key)`.

- `session_thread_id`
- `workspace_id`
- `key` — e.g. `tool_call_count`, `accrued_cost_usd`, `risk_points`
- `value_numeric` / `value_json` (numeric for counters/budgets; json only when
  a policy genuinely needs structured state)
- `updated_at`

Authoritative copy lives **in-process** during an active run (see Runtime); this
table is the durable snapshot so state survives orchestrator restarts and so the
dashboard can read live counters.

### Reuse, do not duplicate

- **Human gate:** an `ask` verdict writes through the existing `escalation`
  table (`reason_kind = policy_ask`) and sets `agent_tool_call_event.approval_state`.
  No new approval table.
- **Session identity:** `session_thread` is the session scope anchor; runs are
  already tracked in `broker_run` / `scheduled_task_run`.
- **Cost inputs:** `cost_budget` reads token/cost from the usage already emitted
  per turn rather than recomputing pricing.

## Runtime Enforcement (Elixir)

The engine lives in the runtime because that is where tools execute and where
the single chokepoint is.

### Evaluation seam

In `tool_registry.ex`, extend `execute/4` so that after the allowlist passes and
before `dispatch/3`:

```elixir
cond do
  not allowed?(name, allowed) ->
    {:error, :not_allowed}

  true ->
    case PolicyEngine.evaluate(%{type: :tool_call, target: name,
                                 data: arguments, context: context}) do
      :allow            -> dispatch(module, ...)
      {:deny, reason}   -> {:error, {:policy_denied, reason}}
      {:ask, escalation}-> {:error, {:policy_ask, escalation}}
    end
end
```

- `{:policy_denied, reason}` surfaces to the agent in-band as a tool error,
  reusing the existing failure-response shaping (`tool_registry.ex:217-227`).
- `{:policy_ask, _}` pauses the turn, writes an `escalation`, and resumes on
  approval. The turn loop must learn to await this verdict (today approval is
  only `local_model_coding`); generalize the `approval_policy` plumbing in
  `runtime-dispatch-context.ts` rather than adding a second path.

### State management

- A per-session `PolicyEngine` holds the authoritative counters in process for
  the life of the run (the session already runs in one orchestrator process).
- On each verdict, apply `state_updates` (`set` / `increment` / `append`) to the
  in-process state and write-behind to `policy_session_state` via
  `SymphonyElixir.PostgRESTClient` (no Ecto Repo; PostgREST is the only DB path).
- On run start, hydrate from `policy_session_state` so a restart resumes
  budgets/counters. Cross-session budgets (future `user_daily_cost_budget`) read
  aggregate usage via PostgREST rather than in-process state.

### Configuration load

At session/turn start the runtime fetches the effective policy set for
`(workspace_id, agent_id, session_thread_id)` — the same point where grants are
resolved (`resolve_for_agent/1`, `tool_registry.ex:264`) — so policy and grants
load together and stay consistent for the turn.

## Platform Areas To Update

### Contracts (`platform/contracts/`)

- New `policy.ts`: `PolicyScopeSchema` (`workspace`/`agent`/`session`),
  `PolicyKindSchema`, a discriminated union of per-`kind` `params` schemas,
  `PolicyVerdictSchema` (`allow`/`deny`/`ask`), and `PolicySchema` /
  `PolicyRowSchema` (snake_case `*Row` mirror per case-convention rules).
- Extend escalation contracts with `policy_ask` reason kind.
- Register policy kinds so a drift check can assert the TS registry, the Elixir
  evaluator set, and any DB `CHECK` agree (`scripts/check-cross-repo-enums.mjs`).

### API (`apps/api/`)

- `policy-resolver.ts` — resolve effective policies for an agent/session,
  mirroring `agent-tool-grant-resolver.ts` (workspace + agent + session, enabled
  only), for both runtime dispatch context and settings UI.
- Thread the resolved policy set into `runtime-dispatch-context.ts` alongside
  `workspace_policy` and tool grants.
- Endpoints (authorized on workspace membership/admin, consistent with the tool
  settings API):
  - `GET /api/agents/:id/policies` → workspace + agent policies, available
    kinds with schemas, effective resolved set.
  - `PUT /api/agents/:id/policies/:policyId` / `DELETE` → mutate agent-tier
    policies.
  - `POST /api/sessions/:sessionThreadId/policies` / `DELETE` → session-tier
    policies a user adds to their own run (the Omnigent "tighten my session"
    capability).
  - `GET /api/sessions/:sessionThreadId/policy-state` → live counters for the
    dashboard.

### Frontend (`apps/web/`)

- Agent settings: a "Policies" panel beside the tool grants panel — apply/edit
  workspace+agent policies, show provenance (`manual`/`system`/`template`).
- Session view: surface live counters (calls used, cost accrued, risk) and an
  `ask` approval prompt wired to the escalation queue, plus a control to add a
  session-scoped policy mid-run.

## PR Sequence

1. **PR-1 — Schema.** Create `policy` and `policy_session_state` (migration +
   `openmacaw-schema.sql` + `pnpm run db:schema:sync` / runtime schema sync).
   RLS via the standard `workspace_id` member policy loop.
2. **PR-2 — Contracts + registry.** `policy.ts`, kind schemas, verdict schema,
   drift check, escalation `policy_ask` reason.
3. **PR-3 — Runtime engine (allow/deny only).** `PolicyEngine` + in-process
   state + write-behind; wire into `execute/4`; implement
   `max_tool_calls_per_session` and `block_tools`. No human gate yet.
4. **PR-4 — Resolver + dispatch.** `policy-resolver.ts`, dispatch-context
   plumbing, runtime config load at turn start.
5. **PR-5 — `ask` / human gate.** Generalize `approval_policy`, write
   `escalation` on `ask`, pause/resume the turn, `ask_on_shell` / `ask_on_tool`.
6. **PR-6 — Cost + risk.** `cost_budget`, `risk_score`, live counter endpoint.
7. **PR-7 — Settings + session UI.** Policy panels and the in-session approval +
   add-policy controls.

Bundle PR-1/PR-2 if review surfaces overlap; keep the runtime engine (PR-3) and
the human-gate change (PR-5) independently revertable since they carry distinct
rollout risk.

## Verification

- `pnpm -C apps/api run validate`
- `pnpm exec tsc --noEmit -p apps/web/tsconfig.app.json`
- Runtime: `cd runtime/apps/orchestrator && mix compile --warnings-as-errors && mix test`
- Engine unit tests: precedence (`deny` > `ask` > `allow`), tier ordering,
  counter increments, budget thresholds, risk escalation, restart hydration.
- Full-stack smoke: configure `max_tool_calls_per_session: 2`, confirm the 3rd
  call returns a policy error to the agent; configure `ask_on_shell`, confirm a
  shell call raises an escalation and resumes on approval.
- Diagnostic: extend `GET /api/diagnostic/agents/:id` to show resolved policies
  and current session counters.

## Open Questions

- **Event coverage in v1.** Start with `tool_call` only, or also gate
  `llm_request` (needed for true pre-spend `cost_budget` and PII scanning)?
  Leaning `tool_call` first; `cost_budget` charges post-turn until then.
- **State durability cadence.** Write-behind per verdict (simplest, more
  PostgREST traffic) vs. batched flush per turn (fewer writes, small loss window
  on crash). Leaning per-turn flush with a final flush on turn end.
- **Concurrency.** A session is single-process today; if parallel tool calls
  within a turn ever land, in-process counters need serialization (a per-session
  GenServer already gives this).
- **Who may set session policies.** Any workspace member on their own session,
  or only the run's initiator? Default to the initiator + workspace admins.
