# Learning Sidecar — Implementation PR Plan

> Superseded by
> [`../active/learning-agent-redesign-scope.md`](../active/learning-agent-redesign-scope.md).

Implementation sequence for
[`learning-sidecar-scope.md`](./learning-sidecar-scope.md). Migrations
land in `harper-server`, schema + API + retrieval injection in
`parallel-agent-platform`, run-finalize hook + reflection job in
`parallel-agent-runtime`. PR descriptions in each repo link back here.

## Current state recap

Audit against `main` of all three repos at scoping time:

### Schema (`harper-server/supabase/migrations/`)

| Object | Status |
|---|---|
| `memory_items` table | Exists. `20260227124000_create_memory_items_and_search.sql`. Full shape (workspace/agent scope, `run_summary` enum value, embedding, FTS, `source_run_id`, `source_task_id`, `supersedes_id`). |
| `memory_hybrid_search()` SQL function | Exists. Same migration. RRF-ranked FTS + pgvector. |
| Workspace RLS on `memory_items` | Exists. `20260227125000_apply_workspace_memory_rls.sql`. |
| `memory_items` source-path guards | Exists. `20260305160000_enforce_memory_paths_not_in_agent_files.sql` + `20260305143000_memory_items_add_source_path.sql`. |
| `scheduled_task` table | Exists. Polled by orchestrator Scheduler GenServer. |
| `skill` table | **Does not exist.** A `docs/active/agent-skills-platform-scope.md` doc was *drafted* during scoping but is **not yet committed to any branch** in this repo — Track D depends on that scope being authored and landed (or this PR plan picking up the contract definition itself) before the distiller has anywhere to put skill candidates. |
| `ScheduledTaskDeliverySchema` | Exists at `contracts/scheduled-tasks.ts:51` but is a single-kind literal (`z.literal("scheduled_agent_message")`). Track B reflection and Track D distillation both want a second + third kind. **Contract widening is its own PR (B0 below)** before the job-handler PRs land. |

### Platform API (`parallel-agent-platform/apps/api`)

- Zero readers of `memory_items`.
- Zero writers of `memory_items`.
- Prompt-building path: extends `gateway_config.runners[0]` plus injected
  agent context — no per-run memory lookup today.
- Scheduled-task CRUD lives at `apps/api/src/services/scheduled-tasks.ts`.

### Orchestrator (`parallel-agent-runtime/apps/orchestrator`)

- `AgentRunner.run/3` → `BrokerLogAdapter.finalize/2` on terminal state.
  This is the hook point.
- `SessionStore.complete_run/2` has the full transcript in-memory at the
  same moment.
- `SymphonyElixir.ScheduledTask.Scheduler` polls every ~60s; `Delivery`
  hands the task instruction to the agent via `ChatGateway`. No new
  scheduler needed for reflection or distillation jobs.

## PR sequence at a glance

```
A1 (harper)  ── index for source_run_id ───┐
                                            │
A2 (plat)   ── memory repo + types ────────┼──→ B (write) and C (read) unblock
A3 (plat)   ── service-role write endpoint ┘

B0a (plat)  ── widen ScheduledTaskDeliverySchema (discriminated union) ──┐
B0b (rt)    ── mirror in Elixir; dispatch by kind ───────────────────────┤
B1 (rt)     ── finalize hook → enqueue learning_reflection row ──────────┤
B2 (plat)   ── reflection job handler: transcript → memories ────────────┘
                                                                  │
                                                                  ▼
                                                      writes via A3

C1 (plat)   ── retriever: hybrid_search wrapper ────┐
C2 (plat)   ── memory.search tool + pinned block ───┤
C3 (web)    ── memory inspector UI (read-only) ─────┤  optional
C4 (web)    ── provider-change embedding warning ───┘  optional, after A3 + C1

D0 (plat)   ── agent-skills-platform-scope.md authored + skill table migrated
              (separate scope, not part of this plan; Track D depends on it)
D1 (plat)   ── skill distiller scheduled job  (BLOCKED on D0)
D2 (plat)   ── PR-bot opens .codex/skills/<slug>.md (BLOCKED on D1)

E1 (plat)   ── per-workspace memory budget caps + audit log
```

Tracks A → B → C are the minimum viable learning loop. D blocks on the
agent-skills scope being authored (D0) and then on its own track. E hardens
before opening to all workspaces.

---

## Track A — Memory storage plumbing

Goal: anything (orchestrator, future jobs, web UI) can read and write
`memory_items` through a typed, audited path.

### PR A1 — `harper-server` — Index for run-scoped memory lookups

**Repo:** `harper-server`

**Migration:** `supabase/migrations/<timestamp>_index_memory_items_source_run.sql`

```sql
create index if not exists idx_memory_items_workspace_source_run
  on public.memory_items (workspace_id, source_run_id)
  where source_run_id is not null;

create index if not exists idx_memory_items_workspace_source_task
  on public.memory_items (workspace_id, source_task_id)
  where source_task_id is not null;
```

Why: the reflector and the audit/lineage queries both filter by
`(workspace_id, source_run_id)`. Without this index they scan
workspace-wide.

**Risk:** none. New partial indexes. Reversible with `drop index if exists`.

**Test plan:**
- `supabase db push --dry-run`
- `supabase db push --include-all --dry-run`

### PR A2 — `parallel-agent-platform` — Memory repository + contract types

**Repo:** `parallel-agent-platform`

**Adds:**
- `contracts/memory-items.ts` — Zod schemas mirroring `memory_items`:
  `MemoryItemSchema`, `MemoryScopeSchema`,
  `MemoryWriteRequestSchema`, `MemoryHybridSearchRequestSchema`,
  `MemoryHybridSearchResponseSchema`.
- `apps/api/src/repositories/memory-items.ts` —
  `insertMemoryItem(...)`, `getMemoryItem(id, workspaceId)`,
  `searchMemoryItemsHybrid({ workspaceId, agentId?, scope?, queryText, queryEmbedding?, limit })`.
- Generated types refresh (`pnpm run db:schema:sync`).

**Not** in this PR: any route. Repository only, plus tests.

**Test plan:**
- `pnpm -C apps/api test src/repositories/memory-items.test.ts`
- Typecheck.

### PR A3 — `parallel-agent-platform` — Service-role memory write endpoint

**Repo:** `parallel-agent-platform`

**Adds:**
- `POST /api/memory/items` — service-role-only (rejects user JWTs;
  validates the orchestrator's signing JWT). Body matches
  `MemoryWriteRequestSchema`. Calls `insertMemoryItem`.
- Route registered in `apps/api/src/app.ts`.
- Auth middleware: extend the existing service-role guard so the
  Elixir orchestrator can call this without impersonating a user.

**Why service-role:** the orchestrator runs as a daemon, not a user.
Memory rows it writes are attributed via `source_run_id`, not via the
auth user.

**Risk:** new write surface on production data. Mitigation: rate-limited,
bounded payload size, schema-validated, audit-logged. The endpoint
does not accept arbitrary `created_at` (server-set) and rejects
`is_deleted=true` writes (deletion is a separate concern).

**Test plan:**
- Contract: round-trip a valid `MemoryWriteRequestSchema` payload.
- Auth: reject user-JWT requests with 403.
- Auth: reject unsigned requests with 401.
- `pnpm -C apps/api test src/routes/memory.test.ts`

---

## Track B — Run reflection

Goal: every finished run produces 1–N `memory_items` summarising what
was learned. Uses Track A's write endpoint.

**Track-B prerequisite (B0):** widen the scheduled-task contract so
non-agent-message kinds (reflection, distillation) can flow through the
existing scheduler/dispatcher. The current `ScheduledTaskDeliverySchema`
in `contracts/scheduled-tasks.ts` is a single `z.literal("scheduled_agent_message")`
— inserting a row with any other `kind` value fails Zod validation in
the platform's scheduled-task service.

### PR B0a — `parallel-agent-platform` — Widen `ScheduledTaskDeliverySchema`

**Repo:** `parallel-agent-platform`

**Adds:**
- Refactor `ScheduledTaskDeliverySchema` in `contracts/scheduled-tasks.ts`
  from a single literal to a discriminated union:

  ```ts
  export const ScheduledTaskDeliverySchema = z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("scheduled_agent_message"),
      sessionStrategy: z.literal("scheduled_task").optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
    z.object({
      kind: z.literal("learning_reflection"),
      sourceRunId: z.string(),
      sourceTaskId: z.string().nullable().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
    z.object({
      kind: z.literal("learning_distillation"),
      windowDays: z.number().int().positive().default(7),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  ]);
  ```

- Update `apps/api/src/services/scheduled-tasks.ts` to dispatch by
  `delivery.kind`: the existing `scheduled_agent_message` branch stays;
  new `learning_reflection` and `learning_distillation` branches route
  to placeholder handlers that just log "not implemented" until B2 / D1
  land. The placeholder approach lets us ship the contract change first
  and add handlers incrementally without leaving rows un-parsable in the DB.
- Generated types refresh; tests covering each kind round-trip.

**Why split this out:** the contract change touches a shared schema
that every scheduled-task writer/reader depends on. Landing it as a
discrete PR with thorough Zod tests is safer than bundling with the
reflector business logic (B2). It also unblocks B0b in parallel.

**Risk:** other readers/writers of `ScheduledTaskDeliverySchema`
break if they assume the single-literal shape. Audit before merging:
the schema is imported in `apps/api/src/services/scheduled-tasks.ts`
and the contract is consumed by the runtime via the generated types
(which Track B0b updates separately).

**Test plan:**
- Unit: each kind validates round-trip; rejecting unknown kinds.
- Unit: scheduled-tasks dispatcher hits the right branch per kind.
- Snapshot of the JSON Schema generated from the union (so cross-repo
  consumers can diff before adopting).

### PR B0b — `parallel-agent-runtime` — Mirror discriminated union; dispatch by kind

**Repo:** `parallel-agent-runtime`

**Adds:**
- Mirror the discriminated-union shape on the Elixir side. Today
  `SymphonyElixir.ScheduledTask.Delivery` posts the task instruction
  through `ChatGateway` unconditionally; with new kinds it must
  dispatch instead.

  ```elixir
  def deliver(task, opts) do
    case task.delivery.kind do
      "scheduled_agent_message" -> deliver_agent_message(task, opts)
      "learning_reflection"     -> enqueue_platform_handler(task, opts)
      "learning_distillation"   -> enqueue_platform_handler(task, opts)
    end
  end
  ```

  For `learning_*` kinds the runtime delegates to the platform-side
  handler by POSTing to a new platform endpoint (`POST /api/learning/jobs/<run_id>`
  or similar — see B2). It does not invoke an agent run. The runtime
  is *transport* for these jobs, not executor.

- Mix config gate `:learning, reflection_enabled: false` by default.
  Even with the contract supporting the new kinds, the runtime won't
  insert rows of those kinds until B1 flips this and only for workspaces
  where the platform's per-workspace flag is on.

**Test plan:**
- `mix test` for the dispatcher branch table.
- Unit: a row with kind `learning_reflection` does not invoke
  `ChatGateway`; it invokes the platform-handler POST.
- Unit: a row with an unknown kind raises (so a future kind shipping
  in platform without a runtime update fails loudly).

### PR B1 — `parallel-agent-runtime` — Finalize hook → reflection enqueue

**Repo:** `parallel-agent-runtime`

**Depends on:** B0a + B0b (the dispatcher must understand
`learning_reflection` before this PR starts inserting rows of that kind).

**Adds:**
- `apps/orchestrator/lib/symphony_elixir/learning/reflection_dispatcher.ex`
  — module called from `BrokerLogAdapter.finalize/2` after the
  `broker_run` row is updated. Inserts a `scheduled_task` row with:

  ```json
  {
    "delivery": {
      "kind": "learning_reflection",
      "sourceRunId": "<run_id>",
      "sourceTaskId": "<work_item_id_or_null>"
    },
    "next_run_at": "<now>"
  }
  ```

  so the scheduler picks it up on the next tick.
- Application config gate: `LEARNING_REFLECTION_ENABLED=true` env var
  (default false). When off, finalize is a no-op for the dispatcher.
- Per-workspace dark launch: the per-workspace
  `workspace.settings.learning.enabled` flag (set in the platform) is
  read by the runtime via the existing workspace-settings RPC. The
  dispatcher checks this and short-circuits when off.

**Why a scheduled_task hop and not a direct call:** decouples the agent's
hot path from the reflection model call. Failures retry through the
existing scheduler. Reflection can be paused workspace-wide by disabling
the scheduled rows.

**Test plan:**
- `mix test` for new module.
- Unit: terminal-state finalize enqueues exactly one reflection row
  with `delivery.kind = "learning_reflection"`.
- Unit: failing the finalize-side enqueue does not fail the run
  (reflection is best-effort).
- Unit: env-var off and per-workspace flag off both short-circuit.

### PR B2 — `parallel-agent-platform` — Reflection job handler

**Repo:** `parallel-agent-platform`

**Depends on:** B0a (placeholder handler replaced by real one).

**Adds:**
- `apps/api/src/services/learning/reflector.ts` — given a `sourceRunId`,
  reads the transcript via the existing message-history API, calls the
  workspace's primary model with a fixed reflection prompt, parses
  ≤ K candidate memory objects from the response, computes embeddings,
  and POSTs each to `/api/memory/items` (Track A3).
- Replaces the B0a placeholder `learning_reflection` branch in
  `scheduled-tasks.ts` with a call to the reflector.
- New scoped instructions doc:
  `apps/api/src/services/learning/reflection-prompt.md` — the fixed
  system prompt the reflector uses (versioned in source).

**Why platform-side handler:** keeps LLM-call business logic in
TypeScript where the rest of model-provider code already lives. The
Elixir orchestrator is the transport for the scheduled-task row but
not the executor of the reflection itself.

**Bounded outputs:** reflector enforces ≤ 5 memory items per run,
≤ 1KB content per item, importance score required (1–10). Anything
beyond is dropped with a warning logged.

**Test plan:**
- Unit: transcript → memories with mocked LLM.
- Integration: end-to-end run a fake agent, observe memory rows.
- `pnpm -C apps/api test src/services/learning/reflector.test.ts`

---

## Track C — Memory retrieval (read path)

Goal: agents see relevant prior memories when they need them — primarily
by calling a `memory.search` tool, supplemented by a small pinned block
of high-importance facts in the system prompt. See
[`learning-sidecar-scope.md#3-memory-retriever-tool-call-primary-minimal-pinned-injection`](./learning-sidecar-scope.md#3-memory-retriever-tool-call-primary-minimal-pinned-injection)
for the design rationale (tool-call beats every-message injection on
per-turn cost, query specificity, and pollution risk).

### PR C1 — `parallel-agent-platform` — Hybrid search service wrapper

**Repo:** `parallel-agent-platform`

**Adds:**
- `apps/api/src/services/learning/memory-retriever.ts` —
  `retrieveRelevantMemories({ workspaceId, agentId, queryText, scope?, importanceMin?, limit })`.
  Calls `searchMemoryItemsHybrid` (Track A2). Computes the query
  embedding using the workspace's embedding provider (workspace credential
  resolver, falls back to FTS-only ranking if none).
- Cross-agent visibility: when `scope='workspace'`, returns rows with
  `agent_id IS NULL` plus rows tagged for the requesting agent; when
  `scope='agent'`, narrows to `agent_id = requesting agent`. Default
  is workspace + own-agent union.
- Token budget guard: caller passes max tokens; retriever drops
  lower-rank results until the result fits.

This module is consumed by both the tool handler (C2) and the pinned
prompt block (C2). Centralising in one service keeps the
workspace+agent+RLS logic in one place.

**Test plan:**
- Unit: seed memory rows, query, assert RRF ranking.
- Unit: missing embedding provider → FTS-only path returns results.
- Unit: `scope='workspace'` includes `agent_id IS NULL` rows; default
  scope unions workspace-wide + own-agent.
- `pnpm -C apps/api test src/services/learning/memory-retriever.test.ts`

### PR C2 — `parallel-agent-platform` — `memory.search` tool + pinned prompt block

**Repo:** `parallel-agent-platform`

**Adds:**
- New tool registered in the existing tool registry:

  ```
  memory.search({
    query: string,
    scope?: "workspace" | "agent" | "task",
    importance_min?: number,    // 1–10, default 1
    limit?: number              // default 5, max 20
  }) -> { results: MemoryItem[] }
  ```

  Granted by default to every agent type when
  `workspace.settings.learning.enabled` is true. Handler delegates to
  `retrieveRelevantMemories` from C1.

- Pinned-prompt block: modifies the prompt builder to prepend a
  bounded section at session start (NOT every turn) when
  `learning.enabled`:

  ```
  ## Workspace memory (pinned)

  You have access to a workspace memory store from prior agent runs.
  Use the `memory.search` tool when you need historical context,
  prior decisions, or known gotchas. Top long-term facts:

  - (importance 9) This repo uses pnpm, not npm.
  - (importance 8) Tests require DATABASE_URL.
  - (importance 7) Linear webhooks fire from project INGEST.
  ```

  Pinned items are top-N (N=3) `scope='long_term'` memories by
  importance, bounded at ≤ 300 tokens.

- Telemetry: log `(workspace_id, agent_id, session_id, pinned_count,
  pinned_token_count)` at session start; log
  `(workspace_id, agent_id, run_id, tool=memory.search, query, result_count,
  result_token_count)` per tool call. Lets us see tool-call usage rates
  in real workspaces before deciding whether retrieval is working.

- Behind per-workspace flag `workspace.settings.learning.enabled`
  (default off). Tool not registered for the agent when flag is off.

**Why a tool, not always-inject:** see scope doc. Short version:
per-turn cost, agent agency, focused queries, pollution avoidance in
large memory stores.

**Test plan:**
- Unit: flag off → tool not in agent's spec list; pinned block absent.
- Unit: flag on + ≥1 long_term memory → pinned block formatted as
  expected, bounded by token budget.
- Unit: tool handler with seeded memories returns RRF-ranked rows.
- Unit: tool handler enforces `limit ≤ 20` and `importance_min ∈ [1,10]`.
- Integration: snapshot test of system prompt with pinned block.
- Integration: end-to-end run a fake agent that calls `memory.search`,
  assert it receives expected results.

### PR C3 — `parallel-agent-platform` (web) — Memory inspector UI (optional)

**Repo:** `parallel-agent-platform`

**Adds:** read-only Settings → Memory tab showing per-workspace and
per-agent memories, filterable by scope, importance, source_run_id.
Useful for debugging retrieval and for end users to understand what
the agent "knows."

Future extension (out of this PR): a "pin this" / "unpin" action so
users can curate the pinned-prompt list when the importance-score
heuristic doesn't surface the right facts.

**Status:** nice-to-have. Ship after C2 if there's appetite; not on
the critical path.

### PR C4 — `parallel-agent-platform` (web) — Provider-change embedding warning

**Repo:** `parallel-agent-platform`

**Adds:**
- In the agent settings panel, when a user changes the agent's
  provider (or the workspace's embedding-provider credential), show a
  modal:

  > Changing this agent's provider will stop new embeddings from being
  > generated by the previous provider. The agent's existing memories
  > stay searchable via full-text search (no semantic similarity), and
  > new memories saved after this change will use the new provider.
  > Memories created with two providers cannot be ranked against each
  > other on similarity — only on text match.
  >
  > [ Cancel ]   [ Change provider ]

- The warning fires only when `workspace.settings.learning.enabled` is
  true AND the workspace has ≥1 `memory_items` row with a non-null
  embedding (don't nag users who never used memory).

- Telemetry: log when the modal is shown and which button is clicked
  (lets us know how often this trips up users vs. how often it's
  ignored — informs whether we need a higher-friction confirmation).

**Why this lives here, not earlier:** the warning is a UX nicety on
top of the actual `memory_hybrid_search` graceful degradation. The
search still works after a provider change (FTS-only); this just
tells the user *why* their semantic results got worse.

**Test plan:**
- Unit: modal renders when conditions met; doesn't render when flag
  off or memory store empty.
- Unit: cancel → provider unchanged. Confirm → provider changes.
- Snapshot of modal body matches the canonical message.

---

## Track D — Skill distillation

**Hard dependency (D0):** an agent-skills scope must be authored and
the skill table migrated before D1/D2 can land. During this PR's
scoping a draft `docs/active/agent-skills-platform-scope.md` was
sketched but **never committed** to any branch in this repo. Treat the
skills work as out-of-scope-for-this-plan but blocking:

- **D0 (external).** Author and merge an agent-skills scope (and the
  matching `skill` table migration in harper-server). Until that
  happens, the distiller has nowhere to put approved skills — D1
  outputs would have to live in memory rows tagged
  `candidate_skill=true` and a manual review process.

If you (the reader) intend to pick up D0, follow the same scope-doc
shape as this one: a `*-scope.md` defining tables/contracts plus a
`*-pr-plan.md` sequencing the work. Once it lands, this plan should be
updated to link to it (and the [Current state recap](#current-state-recap)
row for `skill` table should flip from "does not exist" to "exists, see
`<doc>`").

### PR D1 — `parallel-agent-platform` — Distiller scheduled job

**Repo:** `parallel-agent-platform`

**Adds:**
- `apps/api/src/services/learning/distiller.ts` — for a given workspace:
  reads recent `run_summary` memories (last N days, importance ≥ T),
  clusters via FTS-similarity (v1; pgvector k-means later), prompts an
  LLM per cluster: "is there a reusable skill here? If yes, emit
  `SkillCreateRequestSchema` JSON."
- Per-workspace `scheduled_task` row seeded by a migration (runs nightly).
- Output stored as memory rows tagged `candidate_skill=true,
  cluster_id=<uuid>` until D2 routes them to a PR.

### PR D2 — `parallel-agent-platform` — Skill-candidate PR bot

**Repo:** `parallel-agent-platform`

**Adds:**
- A handler that takes a `candidate_skill=true` memory and opens a PR
  against the workspace's bound repository (uses the configured GitHub
  integration) adding `.codex/skills/<slug>.md`.
- In `parallel-agent-platform`, this lands as
  `POST /api/workspaces/:workspaceId/learning/skill-candidate-prs`
  plus a reusable `openSkillCandidatePullRequest(...)` service so D1
  can call the same handler after the scheduled distiller lands.
- PR description links the source `memory_items` rows and the runs
  they came from.
- Once the PR merges, the agent-skills resolver picks the skill up on
  next dispatch (per the agent-skills scope's contract).

**Why PR-driven, not auto-write:**
[`learning-sidecar-scope.md#design`](./learning-sidecar-scope.md#design)
covers the reasoning — skills shape future agent behaviour; humans
review.

---

## Track E — Observability + governance

Pre-launch hardening. Ship before flipping the per-workspace flag for
external users.

### PR E1 — `parallel-agent-platform` — Memory budget + audit

**Adds:**
- `workspace.settings.learning.memory_budget` (default 5000 items/workspace).
- Distiller / reflector reject writes that would exceed budget; emit
  warning event.
- New audit log line per memory write: `(workspace_id, source_run_id,
  scope, importance, byte_count)` shipped to the existing log pipeline.

### PR E2 — `parallel-agent-platform` — Reflection-cost telemetry

**Adds:** per-workspace token-spend rollup for reflection + retrieval +
distillation. Surfaces in the existing platform-cost view. Lets us
turn off learning for a workspace that runs away on cost.

---

## Cross-repo dependency table

| PR | Repo | Depends on |
|---|---|---|
| A1 | harper-server | — |
| A2 | parallel-agent-platform | A1 merged + schema synced |
| A3 | parallel-agent-platform | A2 |
| B0a | parallel-agent-platform | — (independent contract change) |
| B0b | parallel-agent-runtime | B0a merged (Elixir mirrors the schema) |
| B1 | parallel-agent-runtime | A3 + B0a + B0b |
| B2 | parallel-agent-platform | A3 + B0a |
| C1 | parallel-agent-platform | A2 |
| C2 | parallel-agent-platform | C1 |
| C3 | parallel-agent-platform | A2 (read-only) |
| C4 | parallel-agent-platform (web) | A3 + C1 (needs the memory store to be populated to be useful) |
| D0 | parallel-agent-platform | external (skills scope must be authored — not in this plan) |
| D1 | parallel-agent-platform | C1 + D0 |
| D2 | parallel-agent-platform | D1 |
| E1 | parallel-agent-platform | A3 |
| E2 | parallel-agent-platform | B2 + C2 + D1 |

## Migration inventory (just the SQL changes)

Across the whole effort, the harper-server migration footprint is small
— the heavy schema work was already done in 2026-02. New migrations:

| Migration | Purpose | PR |
|---|---|---|
| `<ts>_index_memory_items_source_run.sql` | Two partial indexes for source_run_id and source_task_id lookups | A1 |
| `<ts>_seed_reflection_scheduled_task.sql` *(optional, per-workspace)* | Idempotent seed of the reflection scheduled-task per active workspace | B1 follow-up |
| `<ts>_seed_distillation_scheduled_task.sql` | Same for nightly distillation | D1 |

All other schema (`memory_items` table, hybrid-search function, RLS,
scheduled_task table, source-path guards) exists today.

## Flags + env

| Flag | Default | Read by |
|---|---|---|
| `LEARNING_REFLECTION_ENABLED` (env, runtime) | `false` | `ReflectionDispatcher` in orchestrator |
| `workspace.settings.learning.enabled` (DB, platform) | `false` | Prompt builder (C2), reflector (B2) |
| `workspace.settings.learning.memory_budget` (DB) | `5000` | Memory writer (A3 + E1) |
| `LEARNING_REFLECTION_MODEL` (env, platform) | workspace primary | Reflector (B2) |
| `LEARNING_EMBEDDING_PROVIDER` (env, platform) | workspace primary | Retriever (C1) + reflector (B2) |

Everything ships dark behind the per-workspace flag. We turn it on for
the internal kmgrassi workspace first, observe a week, then expand.

## What this does not do

Repeating from the scope doc for visibility in the PR plan:

- No personal-user memory. Workspace + agent scope only.
- No auto-merged skill changes. PR-driven.
- No memory eviction in v1.
- No replacement of the existing agent runner (Codex / planner /
  llm_tool_runner stay).
- No new cron / scheduler. Reuses `scheduled_task`.
- No new vector DB. Reuses pgvector via `memory_hybrid_search`.

## Cross-repo companions

| Repo | Doc | Owns |
| --- | --- | --- |
| `parallel-agent-platform` (this repo) | `docs/superseded/learning-sidecar-scope.md` | Canonical design |
| `parallel-agent-platform` (this repo) | `docs/superseded/learning-sidecar-pr-plan.md` (this doc) | PR sequence across all repos |
| `parallel-agent-platform` (this repo) | `docs/superseded/learning-sidecar-runtime-scope.md` | B0b + B1 (Elixir dispatcher + finalize hook) |
| `local-runtime-helper` | `docs/learning-sidecar-helper-scope.md` | "No-op" rationale — explains why the helper doesn't need changes for v1 and what hypothetical futures would require it |

Each cross-repo PR should link back to **this PR plan** as the source
of truth for sequencing, plus the **repo-local scope doc** for the
repo-specific implementation notes.

## How to use this doc

When opening any of the PRs above, link back to the section here from
the PR description ("Implements PR B2 of
[`learning-sidecar-pr-plan.md`](...)"). Keep the audit table near the
top current — if anything in the existing-infrastructure column moves
between scoping and implementation, update this doc before merging.
