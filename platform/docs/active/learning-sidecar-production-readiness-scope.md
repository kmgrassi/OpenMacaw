# Learning Sidecar — Production Readiness Scope

Status: **active**. Owns the work to get the self-improving / learning
loop actually running in production. Companion to the design docs it does
**not** replace:

- [`learning-sidecar-scope.md`](./learning-sidecar-scope.md) — canonical design
- [`learning-sidecar-pr-plan.md`](./learning-sidecar-pr-plan.md) — original build sequence
- [`../../../runtime/docs/learning-sidecar-runtime-scope.md`](../../../runtime/docs/learning-sidecar-runtime-scope.md) — runtime hooks
- [`agent-persistent-context-scope.md`](./agent-persistent-context-scope.md) — agent self-update channel
- [`fleet-sampling-observer-scope.md`](./fleet-sampling-observer-scope.md) — always-on advisory loop
- [`../../../docs/openmacaw-vs-openclaw-hermes.md`](../../../docs/openmacaw-vs-openclaw-hermes.md) — positioning vs. Hermes

## TL;DR

The "learning agent" we decided on is **not a new agent type**. It is a
**workspace-scoped learning sidecar** — post-run *reflection* that distills
transcripts into `memory_items`, plus nightly *distillation* that clusters
memories into skill-candidate PRs. The design is sound and ~85% built. It is
**not running in production** because of one concrete, verified break: the
runtime POSTs learning jobs to a platform HTTP endpoint **that does not exist
in the shape the runtime expects**. Reflection 404s on a path mismatch;
distillation has no route at all. Everything downstream of that edge (LLM
reflection, embeddings, clustering, memory writes) is implemented and unit
tested. This scope fixes the edge and the production config around it.

It also closes a **content gap that matters more than the plumbing**: today the
reflector reads only the chat `message` table, but the dominant production
failures are **operability defects** — agents missing a tool, calling a tool
with the wrong columns, DB rejections. That signal lives in
`agent_tool_call_event`, which the reflector never reads. P6 below makes
tool-call events first-class reflection input so the loop actually learns from
the problems we're seeing, not just from conversational text.

## What was actually decided (clearing up "learning agent")

There is no `learning` agent type and the design never called for one. Agent
types are fixed at `coding | planning | manager | router | custom`
([`platform/contracts/agents.ts:8`](../../contracts/agents.ts)). Learning is a
**capability of the workspace**, gated by a single flag and executed as
out-of-band jobs:

- **Gate:** `workspace_settings.learning_enabled`, default **true** / opt-out
  ([`platform/contracts/workspace-settings.ts`](../../contracts/workspace-settings.ts),
  `DEFAULT_WORKSPACE_SETTINGS_VALUES.learningEnabled = true`).
- **Transport:** `scheduled_task` rows carrying a discriminated delivery union
  ([`platform/contracts/scheduled-tasks.ts:50`](../../contracts/scheduled-tasks.ts)):
  `scheduled_agent_message | learning_reflection | learning_distillation`.
- **Why distillation seeds onto the oldest manager agent:** scheduled-task rows
  require an `agent_id` FK, so the nightly distillation job is attached to the
  workspace's oldest manager agent purely as a row owner — not because a manager
  "does" the learning
  ([`platform/supabase/migrations/20260609123000_seed_distillation_scheduled_task.sql`](../../supabase/migrations/20260609123000_seed_distillation_scheduled_task.sql)).

So: **learning is enabled by a workspace setting; reflection and distillation
run as platform-side jobs on the existing scheduled-task machinery.** That is
the decision. This doc is about making that decision operational.

## Current state — verified against `main`

### Working end-to-end (LLM + data layer)

| Piece | Location | Notes |
|---|---|---|
| `memory_items` table + `memory_hybrid_search()` + workspace RLS | supabase migrations | Pre-existing, complete |
| Reflection service | `apps/api/src/services/learning/reflector.ts` (`reflectRunToMemories`) | Reads transcript → LLM → ≤5 memory candidates → embeddings → `memory_items`. Unit tested. |
| Distillation service | `apps/api/src/services/learning/distiller.ts` (`distillWorkspaceSkills`) | Clusters recent memories → LLM per cluster → skill candidates. Unit tested. |
| Retrieval | `apps/api/src/services/learning/memory-retriever.ts`, `pinned-memory.ts`, `memory.search` tool | `memory.search` tool + pinned-facts prompt block |
| Budget / cost | `apps/api/src/services/learning/memory-budget.ts`, `learning-cost.ts` | Per-workspace caps + telemetry |
| Shared dispatcher | `apps/api/src/services/scheduled-tasks.ts:515` (`dispatchScheduledTaskDelivery`) | **Already handles all three kinds correctly** |

### Working on the runtime side (job production + transport)

| Piece | Location | Notes |
|---|---|---|
| Reflection enqueue (post-run hook) | `runtime/.../learning/reflection_dispatcher.ex` | Best-effort; fails open; reads `workspace_settings.learning_enabled` |
| Delivery routing by kind | `runtime/.../scheduled_task/delivery.ex:102` (`deliver_learning_job`) | Builds payload, calls the HTTP client |
| HTTP client | `runtime/.../platform_learning_client.ex` | POSTs `{endpoint}/api/learning/jobs/<kind>` with the job payload as JSON body |
| Distillation seed | migration `20260609123000_...` | One nightly row per learning-enabled workspace |

### The break (production blocker)

The runtime client constructs the URL as
`endpoint <> "/api/learning/jobs/" <> kind` where `kind` is the literal
`learning_reflection` or `learning_distillation`
([`platform_learning_client.ex:112`](../../../runtime/apps/orchestrator/lib/symphony_elixir/platform_learning_client.ex)).
So in production it POSTs:

- `POST /api/learning/jobs/learning_reflection`
- `POST /api/learning/jobs/learning_distillation`

…with the full job payload in the body (snake_case envelope, nested
`delivery` union — see [Payload contract](#payload-contract-runtime--platform)).

The platform registers exactly one learning-job route
([`apps/api/src/routes/learning.ts:14`](../../apps/api/src/routes/learning.ts)):

```ts
app.post("/api/learning/jobs/:sourceRunId/reflection", …)
// body schema only accepts { sourceTaskId? }; sourceRunId comes from the PATH
```

Consequences, both confirmed:

1. **Reflection 404s.** Express matches `/api/learning/jobs/:sourceRunId/reflection`
   against the runtime's `/api/learning/jobs/learning_reflection` — no trailing
   `/reflection` segment, no match. Even if it matched, the handler reads
   `sourceRunId` from the path, but the runtime carries it inside the body's
   `delivery.sourceRunId`.
2. **Distillation has no route at all.** Nothing matches
   `/api/learning/jobs/learning_distillation`, so the nightly seeded job fails
   on every run with a 404 → `{:platform_learning_handler_failed, …}` and the
   scheduled-task run is marked failed.

The correct execution logic already exists in `dispatchScheduledTaskDelivery`
but is only reachable via the **internal, test-only** route
`POST /api/internal/scheduled-tasks/:scheduledTaskId/dispatch`
([`routes/scheduled-tasks.ts:174`](../../apps/api/src/routes/scheduled-tasks.ts)),
which looks the task up by id in the DB — not the path the runtime uses.

This exactly matches the observed symptom: *runtime produces learning jobs;
platform handler wiring is missing/mismatched.*

## Goal

A single, coherent HTTP contract between runtime and platform for learning
jobs, with the platform reusing its existing dispatch logic, plus the
production configuration and observability needed to turn the loop on for a
real workspace and confirm it works.

Per repo convention (**no backwards-compat shims; refactor over quick fixes**),
we converge runtime and platform on **one** endpoint shape rather than teaching
the platform to also accept the old reflection-only path.

## Payload contract (runtime → platform)

The runtime already sends this body (snake_case envelope; `delivery` is the
persisted union with camelCase keys), from
[`delivery.ex:114`](../../../runtime/apps/orchestrator/lib/symphony_elixir/scheduled_task/delivery.ex):

```jsonc
{
  "kind": "learning_reflection" | "learning_distillation",
  "scheduled_task_id": "uuid",
  "scheduled_task_run_id": "uuid",
  "scheduled_run_id": "scheduled_<run>",
  "workspace_id": "uuid",
  "agent_id": "uuid",                 // optional (present for reflection)
  "source_work_item_id": "uuid",      // optional
  "scheduled_for": "iso8601",         // optional
  "delivery": {                       // the ScheduledTaskDeliverySchema member
    "kind": "learning_reflection",
    "sourceRunId": "…", "sourceTaskId": "…"   // OR for distillation: "windowDays": 7
  },
  "trace_id": "…"                     // optional
}
```

This is the source of truth for the new endpoint's request schema. The handler
takes `workspace_id` + the nested `delivery` union and routes exactly as
`dispatchScheduledTaskDelivery` already does.

## Work plan

Ordered; each item is one reviewable PR unless noted. Platform and runtime
changes can land in parallel because we keep the URL shape the runtime already
uses (`/api/learning/jobs/<kind>`) — the runtime side needs no change to the
URL, only verification.

### P1 — Platform: real learning-job handler (the core fix)

- Replace the reflection-only route in
  [`routes/learning.ts`](../../apps/api/src/routes/learning.ts) with a single
  kind-dispatched endpoint matching the runtime:
  `POST /api/learning/jobs/:kind`.
- Add a `LearningJobRequestSchema` (a `Row`-style snake_case schema, since the
  runtime is an upstream we don't control — see platform case-convention rules)
  that validates the envelope above and the nested `delivery` discriminated
  union.
- Auth: `requireServiceRoleBearer` (unchanged; the runtime sends
  `PLATFORM_LEARNING_HANDLER_API_KEY` as the bearer). Note this helper does an
  **exact** string compare against the platform's `SUPABASE_SERVICE_ROLE_KEY`
  ([`services/service-role-auth.ts`](../../apps/api/src/services/service-role-auth.ts)) —
  the two values must be identical, not merely both valid service tokens (see P4).
- Validate that the `:kind` path segment equals `body.kind` equals
  `body.delivery.kind`; 400 on mismatch.
- **Reuse the existing dispatcher.** Refactor `dispatchScheduledTaskDelivery`
  so the per-kind execution (reflect / distill) is callable from a payload, not
  only from a looked-up `ScheduledTaskProjection`. Both the new runtime route
  and the internal-by-id route funnel through the same function. No duplicated
  reflect/distill call sites.
- Delete the old `/api/learning/jobs/:sourceRunId/reflection` route — no dual
  support.
- Return `202` with the `ReflectRunResult` / `LearningDistillationResult`.

### P2 — Platform: tests for the edge that was missing

- Route-level test: `POST /api/learning/jobs/learning_reflection` and
  `/api/learning/jobs/learning_distillation` with the **real runtime payload
  shape**, asserting 202 and that the dispatcher is invoked with the right
  args. This is the test gap that let the mismatch ship — unit tests mocked the
  HTTP layer and never exercised the URL/shape contract.
- Negative tests: missing service-role bearer → 401; kind mismatch → 400;
  unknown kind → 400.

### P3 — Runtime: contract verification (likely no code change)

- Add/confirm a `platform_learning_client` test asserting the constructed URL
  is `/api/learning/jobs/learning_reflection` and `/api/learning/jobs/learning_distillation`
  and that the payload matches P1's schema. The runtime already does this shape;
  this pins it so the two repos can't drift again.
- Confirm the cross-repo enum/contract drift check covers the delivery union
  (extend `scripts/check-cross-repo-enums.mjs` if it doesn't already cover
  learning kinds).

### P4 — Production configuration (private infra repo)

These live in the **private infra repo**, not here, but are part of "working in
production." The runtime fails loud at job time if the endpoint is unset
(`:missing_platform_learning_endpoint`), so these must be set before enabling:

- `PLATFORM_LEARNING_HANDLER_ENDPOINT` → the platform API base URL reachable
  from the orchestrator (e.g. internal service URL, **not** localhost).
- `PLATFORM_LEARNING_HANDLER_API_KEY` → **must equal the platform API's
  `SUPABASE_SERVICE_ROLE_KEY` exactly.** `requireServiceRoleBearer` compares the
  incoming bearer to `process.env.SUPABASE_SERVICE_ROLE_KEY` with `!==`, so a
  *different* but otherwise-valid service token is rejected with 403. Provision
  the same value on both sides (or change the auth code first — out of scope here).

The two jobs source their LLM credentials **differently** — do not assume one
env list covers both:

- **Reflection** does *not* read `OPENAI_API_KEY` from env. It loads the
  provider key from the workspace `credential` table
  ([`services/learning/reflector.ts:409`](../../apps/api/src/services/learning/reflector.ts)),
  failing with `reflection_credential_missing` (and a 4xx) when the workspace
  has no stored provider credential. `LEARNING_REFLECTION_MODEL` is an
  *optional* override and `LEARNING_EMBEDDING_MODEL` *defaults*, so setting env
  alone will **not** make reflection work — the target workspace must have a
  provider credential stored. Document this as a prerequisite separate from the
  distillation envs.
- **Distillation** *does* require env: `OPENAI_API_KEY` and
  `LEARNING_DISTILLATION_MODEL` are both mandatory and the distiller throws a
  4xx if either is unset
  ([`services/learning/distiller.ts:105`](../../apps/api/src/services/learning/distiller.ts)).
  Confirm both are set in the platform-api task definition.
- Decide the embedding model and **freeze it** — changing embedding providers
  later silently breaks cosine similarity across existing rows (there is already
  a `learning-provider-warning` surface; wire it to the deployed value).

### P5 — Rollout + verification

- Keep `learning_enabled` **false** for all but the internal `kmgrassi`
  workspace initially (the design's dark-launch stance), even though the column
  default is `true`. Confirm which workspaces have rows vs. rely on the default
  before deploy — a `true` default means *every* workspace is on unless we set
  rows. **Open question O1.**
- Verify reflection: ensure the test workspace has a stored provider credential
  (reflection fails `reflection_credential_missing` without one — see P4) →
  complete an agent run → confirm a `learning_reflection` scheduled-task row is
  enqueued → confirm a platform 202 in logs → confirm new `memory_items` rows
  with `source_run_id` set.
- Verify distillation: manually trigger the nightly row via
  `POST /api/internal/scheduled-tasks/:id/dispatch` (and separately let the
  runtime path fire) → confirm skill-candidate memories written.
- Add a dashboard / log query for learning-job HTTP status so a future 404 is
  visible immediately, not silent.

### P6 — Feed tool-call events into reflection (operability learning) — **priority**

Rationale: in practice the majority of run failures are tool/config defects —
an agent lacks a granted tool, calls a tool with the wrong columns/arguments, or
the DB rejects the call. None of that is reliably visible in the chat
transcript, and the current reflector cannot surface it. The structured record
already exists; we just need to read it and prompt for it.

- **Widen the reflector's inputs.** In
  [`services/learning/reflector.ts`](../../apps/api/src/services/learning/reflector.ts),
  in addition to `loadRunMessages`, load this run's `agent_tool_call_event`
  rows (by `run_id`) via the service-role client — the same table/columns
  `agent-dashboard.ts` already queries: `tool_slug, status, arguments, result,
  output_summary, error_code, error_message, approval_state, started_at`. No
  migration — the table exists.
- **Build a structured tool-call summary** alongside the chat transcript and
  feed both to the model: each call's tool, status (esp. `error`/`denied`),
  error code/message, and the argument shape. Redact values per the existing
  "no secrets" rule; keep keys/shape so "called `scheduled_task.create` with a
  non-existent `due_at` column" survives.
- **Revise the reflection prompt**
  ([`reflection-prompt.md`](../../apps/api/src/services/learning/reflection-prompt.md)).
  Today it tells the model to *exclude* "transient status / process commentary,"
  which actively suppresses tool-failure lessons. Add an explicit category for
  **tool & configuration failures** (missing-tool, wrong-argument/column,
  repeated DB rejection, denied-grant) and instruct the model to record them as
  actionable memories. Tag these distinctly (e.g.
  `tags: { kind: "operability", failure: "tool_call", tool_slug }`) so the
  router/manager agents that *can* fix them (grant a tool, correct arg shape)
  can retrieve them, and so they're separable from durable workspace facts.
- **Don't let the ≤5-memory cap crowd them out.** Either give operability
  memories a separate small budget within the run, or run tool-failure
  extraction as its own concern so a chatty run can't starve the failure
  lessons. Decide in the PR; recommend a separate budget over a second LLM call.
- **(Stretch) cross-run aggregation.** A repeat offender — same `tool_slug` +
  same `error_code` across many runs/agents — is the highest-value signal.
  That's a distillation-style rollup over the new operability memories; note it
  as a fast follow once per-run capture lands.
- Tests: a reflector test with a run that has a failed `agent_tool_call_event`
  (wrong-column DB error) asserting an operability-tagged memory is produced.

This depends on P1 (jobs must actually reach the platform) but is otherwise
independent of distillation, and given production experience it should land
right after the core wiring fix.

### P7 — Close the loop: operability finding → planning agent → coding agent → PR

The strategic payoff, and the largest track here. P1–P6 give *detection*
(operability memories). P7 turns detection into *autonomous remediation* by
routing recurring findings to the planning agent, which already owns
plans/work-items and drives the coding agent against the repo. The design intent
already exists — the [fleet-sampling-observer scope](./fleet-sampling-observer-scope.md)
states "advisory by default… acting on it is the consuming agent's job." P7
wires that consumer.

> **Design choice (decided): hand the issue to the planning agent; don't build a
> remediation control plane.** An earlier draft added a `remediation_candidate`
> table with a status state machine and a recurrence counter. That was
> over-engineering — a deterministic layer reinventing what an intelligent
> planning agent already does, and what the **existing plan/work-item records
> already track**. We drop it. The planner consumes operability findings and
> owns remediation. **Consequence: P7 needs no migration** (consistent with
> P1–P6). The one piece of determinism we keep — a recurrence pre-filter — is a
> read-time query, not a stored table (see Stages). Dedup becomes the planner's
> job, anchored on a work-item signature tag (concrete query, not LLM memory).

#### The endpoint is a PR, not a merge (decided)

The autonomous loop's job is to land a **review-ready PR** and stop. **The agent
never merges.** What happens to the PR after that is entirely the human's
existing repo infrastructure — branch protection, required reviews, CI gates,
CODEOWNERS, GitHub auto-merge. If the owner configures "auto-merge once approved
+ green," reviewed PRs merge with no human keystroke; if they require manual
review, they review. Either way the *learning system* holds no merge button and
bypasses none of the repo's configured controls. This keeps full autonomy up to
PR while delegating merge policy to where it belongs, and sidesteps the
"agent poisons its own instructions" risk: the agent proposes a diff; the repo's
own rules decide if it lands.

This also means **we don't need a merge webhook to close the loop** — see step 7.

#### Stages (green = exists, amber = new)

1. **Detect** *(P6)* — tool-call failures → operability-tagged `memory_items`.
2. **Recurrence pre-filter** *(new, read-time — no stored state)* — at hand-off,
   a cheap `GROUP BY` over operability memories counts occurrences per signature
   `(tool_slug, error_code, agent_type)` and surfaces only those seen **≥N times
   across the window**. This is the one piece of determinism worth keeping — it
   stops the loop acting on one-off blips — and it's a query, not a table.
3. **Hand off to planning** *(new — the piece this is really about)* — reuse the
   existing `scheduled_agent_message` primitive: `ChatGateway.post_message`
   delivers free-text `instructions` to a target `agent_id`
   ([`delivery.ex` `deliver_agent_message`](../../../runtime/apps/orchestrator/lib/symphony_elixir/scheduled_task/delivery.ex)).
   Seed a scheduled task at the workspace's **planning agent**: *"Here are the
   recurring operability issues this window (signature + count + example
   transcript). For each, first check whether an open remediation work-item
   already exists for its signature; if not, classify code-vs-config and create
   a plan + work-items tagged with the signature."* The planner does the
   reasoning; **we hand it the issue, not a remediation.**
4. **Plan → work items** *(exists)* — planner creates plan + work-items and
   **tags each with the issue signature** in work-item metadata (this tag is the
   entire dedup mechanism — no new table).
5. **Code → PR** *(exists)* — the coding agent picks up work-items, edits the
   repo, and opens a PR. The PR is linked from the work-item (existing
   completion metadata).
6. **Endpoint** *(decided, above)* — the PR sits in the human's merge
   infrastructure. The loop is done.
7. **Close — by signal decay, nothing to resolve** *(emergent)* — there's no
   candidate row to mark resolved. When the fix lands, the signature stops
   recurring, so step 2 stops surfacing it and the planner stops seeing it —
   the loop quiesces on its own. Conversely, if a signature **keeps recurring
   while an open work-item/PR exists for it** (step 4's tag check finds one), the
   planner must **not** open a second PR — it escalates (attention item /
   `needs_human`) instead. **Natural quiescence is the success signal.**

#### State lives in records that already exist

No new table. The "is this being worked / already fixed?" state is read from:

- **operability `memory_items`** — the recurrence signal (step 2).
- **the plan + work-items the planner creates**, tagged with the issue signature
  — dedup and "in progress" status (step 4). The work-item's existing completion
  metadata carries the PR link.

Provenance is preserved end-to-end without a candidate table: PR → work-item
(signature tag + source memory ids) → `memory_items` → `agent_tool_call_event`.

#### PR breakdown

- **P7.1 — recurrence query + hand-off seed** *(platform)*: the read-time
  signature aggregation over operability memories, and a seeded planning-agent
  `scheduled_agent_message` carrying the recurring issues. Add a workspace
  creation-time hook so new workspaces get this and the distillation row
  (closes O2). No migration; no new delivery kind required (it's a
  `scheduled_agent_message`).
- **P7.2 — planner behavior** *(prompt + classification)*: the instruction
  template; signature-tagging of work-items; the "open work-item already exists?"
  dedup check; code-vs-config routing (O5); a per-run cap on new remediation
  work-items.
- **P7.3 — work-item ↔ issue linkage** *(platform, light)*: a convention/helper
  for the signature tag and source-memory ids on work-item metadata, plus the
  query the planner uses to find an existing open work-item for a signature.
- **P7.4 — tests + observability** *(platform)*: end-to-end — failed tool call →
  operability memory → recurs past threshold → planner creates a signature-tagged
  plan + work-item → PR opened and linked → on re-run the dedup check prevents a
  second PR; plus a simple view of recurring issues and their open work-items.

#### Guardrails

- **Recurrence threshold** (step 2) before anything is surfaced.
- **Dedup via signature tag** (soft, but anchored on a concrete work-item query —
  not LLM memory) + a **per-run cap** on new remediation work-items.
- **Escalate, don't re-PR**, when a signature recurs with an open work-item/PR.
- **Config-fix routing (O5):** grants/allowlists are workspace state, not code —
  route to a planner grant-mutation tool, a seed/IaC PR, or the attention queue;
  don't assume every fix is a repo edit.
- The loop **never** edits agent instructions/context (that's the separate
  [persistent-context channel](./agent-persistent-context-scope.md)) and
  **never** merges — merge is the repo's configured infrastructure.

> **Accepted tradeoff:** dedup is soft (a tag the planner must check) rather than
> a DB-unique constraint. The failure mode is a duplicate PR, not data
> corruption; the per-run cap and your merge infra are the backstop. If
> duplicates show up in practice, promoting the signature tag to a small
> uniqueness-enforcing table is a clean later step — but we don't pay for it up
> front.

Sequencing: P7 depends on P6 (something to route) and P1 (jobs must run).

## Out of scope (tracked elsewhere)

- **Skill → PR bot** (Track D in the original PR plan): turning distilled skill
  candidates into actual `.md` PRs depends on the agent-skills scope and the
  `skill` table, which don't exist yet. Distillation currently writes candidate
  *memories*; promoting them to reviewed PRs is a follow-on.
- **Fleet sampling observer** — separate always-on advisory loop, its own scope.
- **Agent persistent-context self-updates** — separate channel, its own scope.

## Open questions

- **O1 — default-on vs. dark-launch tension.** `learning_enabled` defaults to
  `true`, but the rollout plan wants internal-workspace-first. Resolve by either
  (a) flipping the column default to `false` and explicitly enabling the
  internal workspace, or (b) accepting default-on and confirming P4 config is
  safe for all workspaces before deploy. Recommend (a) for a controlled launch.
- **O2 — distillation seed coverage.** The seed migration only created rows for
  workspaces that existed and were learning-enabled at migration time. New
  workspaces get no distillation row. Need a hook in workspace/agent setup
  (`default-agents.ts` path) to seed the nightly distillation task on creation.
- **O3 — failure visibility.** Today a handler failure marks the scheduled-task
  run failed and logs a warning. Decide whether learning-job failures should
  raise an attention-queue item or stay log-only (recommend log-only + a metric;
  learning is best-effort and must never block runs).
- **O4 — autonomy gate (P7). DECIDED:** the loop's endpoint is a **review-ready
  PR**; the agent never merges. Merge is governed entirely by the human's
  existing repo infrastructure (branch protection, required reviews, CI,
  CODEOWNERS, GitHub auto-merge). Owners who want hands-off operation enable
  auto-merge-on-approval; the learning system itself holds no merge button. No
  in-system human step is required to keep the loop autonomous up to PR.
- **O5 — fix routing (P7).** How are *config* fixes (missing tool grant, wrong
  allowlist) applied vs. *code* fixes? Options: planning agent with scoped
  grant-mutation tools; an IaC/seed PR if grants are declarative; or human via
  the attention queue. Decide before P7, since a large share of operability
  findings are config, not code.

## Definition of done

1. Runtime POSTs to `/api/learning/jobs/learning_reflection` and
   `/api/learning/jobs/learning_distillation` both return 202 in production.
2. A real agent run produces `memory_items` rows via reflection.
3. The nightly distillation job runs without 404 and writes skill candidates.
4. Route-level tests exercise the real payload shape in both repos; the
   cross-repo drift check guards the contract.
5. Learning is enabled for the internal workspace with the documented config,
   and there is a log/metric surface for learning-job HTTP status.
6. Reflection ingests `agent_tool_call_event` and produces operability-tagged
   memories for tool/config failures (missing tool, wrong column/argument, DB
   rejection) — verified by a run with a real failed tool call yielding such a
   memory.
7. (P7) A recurring operability signature (read-time threshold) is handed to the
   planning agent → it creates a signature-tagged plan + work-items → the coding
   agent opens a PR, with **no human step inside the system** and **no new
   table**; a re-run with an open work-item for the same signature does not open
   a second PR. The loop quiesces when the signature stops recurring. Merge
   remains the repo's own infrastructure.
