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

`ToolRegistry.execute/4`
(`runtime/apps/orchestrator/lib/symphony_elixir/tool_registry.ex:161`) is *one*
enforcement point — but **not the only one**, so the engine must not hook there.
Several tool-execution paths skip the registry entirely (see
[Runtime Enforcement](#runtime-enforcement-elixir) for the full list): the
tool-calling dispatcher can invoke a custom executor or ship the call to the
local helper, and the cloud coding executor calls `ShellExec` / `ApplyPatch`
directly. Hooking only `ToolRegistry.execute/4` would silently bypass
`ask_on_shell`, `block_tools`, and the per-session counters for exactly the
highest-risk paths (shell, patch, container, local-relay). The engine therefore
gates at the **logical pre-execution funnels** that sit above the
executor/transport split, through one shared `PolicyGate`.

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

The engine lives in the runtime because that is where tools execute. There is
**no single chokepoint** today; tool calls reach execution through several
paths, and the gate must cover all of them or it is trivially bypassable.

### The tool-execution paths (why one hook is not enough)

| # | Path | Where it executes | Hits `ToolRegistry.execute/4`? |
| --- | --- | --- | --- |
| 1 | Registry tool | in orchestrator process | yes |
| 2 | Custom executor (function/module) — `tool_execution_dispatcher.ex:155-162`, `:194-204` | in orchestrator process | **no** |
| 3 | Local-relay tool — dispatcher ships a frame to the helper daemon | on the user's machine | **no** |
| 4 | Cloud coding executor `shell.exec` / `apply_patch` — `coding_executor.ex:206-231` (`ShellExec.execute` / `ApplyPatch.execute`) | in the cloud container | **no** |

Paths 3 and 4 execute **off-process** (helper daemon / container), so the policy
decision — especially `ask`, counters, and budgets — must be made in the
orchestrator *before* the call is dispatched. That rules out a hook inside the
executor and points at the dispatch funnels.

### Evaluation seam: one `PolicyGate`, called at each pre-execution funnel

Introduce `SymphonyElixir.PolicyGate.evaluate/1` and call it at the logical
funnels that sit **above** the executor/transport split, so a single decision
covers registry, custom-executor, and local-relay tools at once:

- **`tool_execution_dispatcher.ex` — `request_tool_execution/3` (line 106)** —
  above the runtime-vs-helper split (109-114) and the executor split (155), so it
  gates paths 1, 2, and 3 for the cloud tool-calling loop.
- **`tool_execution_dispatcher.ex` — `execute_direct_tool/2` (line 184)** — above
  its executor split (194), gating the direct / local-model-coding path.
- **`coding_executor.ex` — `execute_tool/5` (line 206)** — the separate cloud
  container runner; gate at the top before the `shell.exec` / `apply_patch`
  branches (path 4).
- **`ToolRegistry.execute/4`** keeps the allowlist check (`allowed?/2`) but is
  *not* the policy seam — the gate has already run upstream by the time a
  registry tool reaches it.

```elixir
# at each funnel, before any executor / transport dispatch
case PolicyGate.evaluate(%{type: :tool_call, target: call.name,
                           data: call.arguments, session: session}) do
  :allow             -> dispatch_however_this_path_dispatches()
  {:deny, reason}    -> {:error, {:policy_denied, reason}}
  {:ask, escalation} -> {:error, {:policy_ask, escalation}}
end
```

`PolicyGate.evaluate/1` is the single implementation (state, tiers, verdict
composition); the funnels above are the only call sites. Adding a future runner
path means adding one `PolicyGate.evaluate/1` call at its funnel — enforced by a
test that asserts every tool-dispatch funnel is gated (see Verification).

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

The sequence is ordered so each PR is independently shippable and verifiable,
and so behavior only changes once — at PR-3. PRs 1, 2, and 4 are additive or
non-behavioral; the engine itself is gated by data, not a flag (see
[Incremental rollout property](#incremental-rollout-property)), so early PRs are
safe to merge before the feature is complete.

Each PR lists how to **verify it works in isolation** before moving on.

1. **PR-1 — Schema.** Create `policy` and `policy_session_state` (migration +
   `openmacaw-schema.sql` + `pnpm run db:schema:sync` / runtime schema sync).
   RLS via the standard `workspace_id` member policy loop.
   - *Verify:* migration applies cleanly; `db:schema:sync` regenerates types
     with no hand edits; insert a `policy` row via PostgREST with the
     service-role key and read it back; confirm an anon-key client only sees
     rows for its own workspace (RLS). No behavior change — existing
     `pnpm -C apps/api run validate` and `mix test` stay green and agents still
     run normally.
2. **PR-2 — Contracts + registry.** `policy.ts`, kind schemas, verdict schema,
   drift check, escalation `policy_ask` reason.
   - *Verify:* unit tests on each kind's Zod schema (valid params parse,
     invalid params reject — e.g. `max_tool_calls_per_session` requires a
     positive integer `limit`); the cross-repo drift check passes with the TS
     registry, the Elixir evaluator stubs, and any DB `CHECK` in agreement.
     Pure TS — `pnpm -C apps/api run validate`.
3. **PR-3 — Runtime engine (allow/deny only).** `PolicyGate` + `PolicyEngine` +
   in-process state + write-behind; wire `PolicyGate.evaluate/1` into **all**
   pre-execution funnels (`request_tool_execution/3`, `execute_direct_tool/2`,
   `coding_executor.execute_tool/5`), not just the registry path; implement
   `max_tool_calls_per_session` and `block_tools`. No human gate yet. **First
   behaviorally testable PR.**
   - *Verify:* `mix` unit tests for the engine — precedence (`deny` > `ask` >
     `allow`), tier ordering, counter increment, restart hydration from
     `policy_session_state`. **Path-coverage test (the Codex P1):** with one
     `block_tools` policy active, assert the call is denied for each path —
     a registry tool, a custom-executor tool, a local-relay tool, and the cloud
     coding `shell.exec` — so no runner/transport bypasses the gate. Full-stack
     smoke: insert `max_tool_calls_per_session: 2` directly via PostgREST, run an
     agent, and confirm the 3rd tool call returns an in-band policy error while
     calls 1–2 succeed; repeat the count against a `shell.exec`-driven cloud
     coding run to prove the counter increments off-registry too. Separately
     grant a tool, then add a `block_tools` policy for it, and confirm the call
     is denied even though the grant still exists — proving policy composes
     *after* the allowlist.
4. **PR-4 — Resolver + dispatch.** `policy-resolver.ts`, dispatch-context
   plumbing, runtime config load at turn start.
   - *Verify:* API test that `GET /api/agents/:id/policies` returns the resolved
     workspace+agent set; assert `runtime-dispatch-context` now carries the
     policy set alongside `workspace_policy`. Repeat the PR-3 smoke but configure
     the policy through the **resolver path** (not a manual PostgREST insert) and
     confirm the runtime loads it at turn start. Extend the diagnostic endpoint
     and confirm `GET /api/diagnostic/agents/:id` lists resolved policies.
5. **PR-5 — `ask` / human gate.** Generalize `approval_policy`, write
   `escalation` on `ask`, pause/resume the turn, `ask_on_shell` / `ask_on_tool`.
   - *Verify:* `mix` tests for pause/resume around an `ask` verdict. Full-stack:
     configure `ask_on_shell`, run an agent that calls a shell tool, confirm an
     `escalation` row (`reason_kind = policy_ask`) is written and the turn
     blocks; **approve** via the escalation queue and confirm the call proceeds;
     re-run and **refuse** and confirm it resolves to `deny` with an in-band
     error. Confirm `agent_tool_call_event.approval_state` reflects each outcome.
6. **PR-6 — Cost + risk.** `cost_budget`, `risk_score`, live counter endpoint.
   - *Verify:* configure `cost_budget` with a low `max_cost_usd` and one
     `ask_thresholds_usd` entry; run turns and confirm an `ask` fires at the
     threshold and a `deny` once over `max`. Configure `risk_score` over a couple
     of guarded tools and confirm escalation once the accrued points cross
     `threshold`. Confirm `GET /api/sessions/:id/policy-state` reports the live
     `tool_call_count` / `accrued_cost_usd` / `risk_points`.
7. **PR-7 — Settings + session UI.** Policy panels and the in-session approval +
   add-policy controls.
   - *Verify:* browser smoke per `platform/CLAUDE.md` — `pnpm run dev`, log in
     with the **Use dev credentials** button, open the agent Policies panel and
     apply/edit/remove a policy (confirm provenance shows), then in a live
     session add a session-scoped policy mid-run, watch the live counters update,
     and approve an `ask` prompt from the session view. Check the browser console
     for errors.

Bundle PR-1/PR-2 if review surfaces overlap; keep the runtime engine (PR-3) and
the human-gate change (PR-5) independently revertable since they carry distinct
rollout risk.

### Incremental rollout property

The engine is a **no-op until a policy row exists.** With zero `policy` rows for
a workspace/agent/session, `PolicyEngine.evaluate/1` returns `allow` and the only
added cost is one resolver read per turn. This is what makes the sequence safe to
land incrementally: merging PR-3/PR-4 to `main` changes nothing for existing
workspaces until someone deliberately adds a policy, so each PR can ship and be
exercised on real traffic without a feature flag or a big-bang cutover. Roll out
by adding one policy to one test agent, watching the diagnostic + counter
endpoints, then widening.

## Verification (global gates)

Run on every PR in the series, in addition to that PR's per-step checks above:

- `pnpm -C apps/api run validate`
- `pnpm exec tsc --noEmit -p apps/web/tsconfig.app.json`
- Runtime: `cd runtime/apps/orchestrator && mix compile --warnings-as-errors && mix test`
- Observability for any policy PR: `GET /api/diagnostic/agents/:id` (resolved
  policies) and `GET /api/sessions/:id/policy-state` (live counters) — these are
  the two windows used to confirm each step on real runs.

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
