# Learning Agent Redesign Scope

Status: **active**. Reframes the learning system away from a memory-centric
"sidecar" toward (a) two universal agent capabilities — **memory** and
**skills** — and (b) a **learning meta-agent** that reviews other agents'
transcripts and acts on what it finds.

> **Supersedes (as this lands):** the `learning-sidecar-*` series —
> [`learning-sidecar-scope.md`](./learning-sidecar-scope.md),
> [`learning-sidecar-pr-plan.md`](./learning-sidecar-pr-plan.md),
> [`learning-sidecar-production-readiness-scope.md`](./learning-sidecar-production-readiness-scope.md),
> [`../reference/learning-sidecar-production-rollout.md`](../reference/learning-sidecar-production-rollout.md),
> and the runtime
> [`learning-sidecar-runtime-scope.md`](../../../runtime/docs/learning-sidecar-runtime-scope.md).
> Move them to `docs/superseded/` with a pointer when the first PR of this
> series merges.

External reference: Claude **Agent Skills** —
<https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview>.
We adopt that format and loading model verbatim (see [Skills](#2-skills--a-first-class-db-backed-capability)).

## TL;DR

The original learning sidecar made `memory_items` the first-class sink for
**all** learning output: post-run reflection wrote memories, nightly
distillation wrote `candidate_skill` memories, and retrieval fed them back via
a pinned-prompt block plus a `memory.search` tool. That conflated three
different output types (durable facts, actionable bugs, reusable procedures)
into one recall store — and routed bug-finding through a table that has no
issue lifecycle. The retrieval half (the only reason memory beat plain
messages) is also barely working: `memory_hybrid_search` is a recency stub
that ignores the query text and embedding, and the read-side opt-in gate
disagrees with the write-side gate.

We replace it with:

1. **Memory** as a universal, ungated capability — `memory.create` +
   `memory.search`, available to **every** agent, for saving and recalling
   durable facts. `memory_items` becomes a general agent scratchpad,
   decoupled from learning.
2. **Skills** as a first-class, DB-backed capability in the **Claude Agent
   Skills** format — `skill.create` available to every agent, writing
   **draft** skills that a human **approves** in a new UI; approved skills are
   materialized into each run's filesystem so native progressive disclosure
   loads them.
3. A **learning meta-agent** — a normal agent whose *input is other agents'
   transcripts*. Opt-in and toggleable; default cadence is a **daily** run
   that samples **one random recent transcript (~10 messages)**, reflects, and
   acts: bugs → hand off to the planning agent; learnings → `skill.create`;
   durable facts → `memory.create`. Its **transcript is the output**, viewable
   like any other agent.

## Why (the reframe)

- **Bugs aren't memories; skills aren't memories.** The dominant production
  signal is operability defects (missing tool grants, wrong arguments, DB
  rejections). Those are *issues* with a lifecycle, not recall facts. The
  prior design even tagged them `kind: operability` to keep them "separable
  from durable workspace facts" — i.e. it knew two things were jammed into one
  table.
- **The planner hand-off was already the right call.** The production-readiness
  doc's P7 explicitly rejected a `remediation_candidate` table as
  over-engineering and decided "hand the issue to the planning agent; the
  planner owns remediation, work-items are the record." We keep that and drop
  the memory staging in front of it.
- **Skills now have a real model.** Claude Agent Skills give us a portable,
  filesystem-based, progressively-disclosed format. The repo already uses a
  `.codex/skills/<slug>.md` convention; this is conforming, not inventing.
- **The memory retrieval path isn't load-bearing.** `memory_hybrid_search` is
  a recency stub; the call signature doesn't match the migration; the gates
  are split-brain. Little is lost by removing memory as the learning surface.

## What gets retired

- `apps/api/src/services/learning/reflector.ts` — post-run reflection →
  memory writes.
- `apps/api/src/services/learning/distiller.ts` — clustering → `candidate_skill`
  memories.
- `apps/api/src/services/learning/pinned-memory.ts` — pinned-prompt injection.
- The `candidate_skill` memory convention and the
  `learning-skill-prs` / `skill-candidate-pr-bot` PR path (skills now live in a
  table; a "promote to repo" PR may return later as an option).
- The runtime after-every-run trigger:
  `learning/reflection_dispatcher.ex` and its calls from
  `chat_gateway.ex` / `gateway_socket.ex`.
- `learning_enabled` as a gate on memory tools (memory becomes universal).
- The distillation / operability scheduled-task seeds.

## New components

### 1. Memory — a universal capability

- **`memory.create`** (NEW agent tool): wraps the existing
  `insertMemoryItem` (`repositories/memory-items.ts:217`) and the
  service-role `POST /api/memory/items` write path. Lets any agent save a
  durable fact it judges important.
- **`memory.search`** (exists, `services/learning/memory-tool.ts`): keep, but
  **ungate** it — remove the `isLearningEnabledForAgent` check in
  `local-chat-agent-tools.ts` and `database-tool-executor.ts`. Available to
  all agents by default.
- `memory_items` shape is unchanged; over time drop learning-specific scope/tag
  usage (`run_summary`, `candidate_skill`).
- **Make the search real** (or accept recency-only): `memory_hybrid_search` is
  a stub. Either implement FTS + pgvector ranking and fix the `p_`-prefixed
  call signature mismatch, or explicitly document recency-only for v1.

### 2. Skills — a first-class DB-backed capability

Adopt the Claude Agent Skills format and loading model.

**Skills are agent-owned, shared by copy.** Every skill belongs to exactly
one agent (`agent_id` NOT NULL). An agent's effective skill set is the set of
skills attached to *it* — there is **no** workspace-wide/null scope. Sharing
happens by **copy**: another agent that wants a skill copies it into a new row
it owns, with a `copied_from_skill_id` provenance link. (Decided — see
[Resolved decisions](#resolved-decisions).)

**New `skill` table:**

| Column | Notes |
|---|---|
| `id` | uuid PK |
| `workspace_id` | uuid, RLS-enforced |
| `agent_id` | uuid **NOT NULL** — the owning agent |
| `name` | ≤64 chars, `^[a-z0-9-]+$`, no `claude`/`anthropic` (Skills rule) |
| `description` | ≤1024 chars, "what it does and when to use it" (Skills rule) |
| `body` | `SKILL.md` markdown body (instructions) |
| `status` | `draft` \| `approved` \| `archived` |
| `copied_from_skill_id` | uuid NULL — source skill when this row was copied |
| `created_by_agent_id` / `created_by_user_id` | provenance (who proposed it) |
| `source_run_id` | link back to the run that proposed it |
| `created_at` / `updated_at` | |

Unique on `(agent_id, name)` so a skill name is stable per agent. (Bundled
Level-3 files/scripts deferred — markdown `SKILL.md` body first.)

- **`skill.create`** (NEW agent tool, all agents): writes a **`draft`** skill
  attached to a target agent. Same ergonomics as `memory.create`. When the
  learning meta-agent authors one, it attaches it to the agent whose
  transcript revealed the learning.
- **`skill.copy`** (NEW agent tool / UI action): copy an existing skill into a
  new row owned by another agent (`copied_from_skill_id` set, `status: draft`).
  This is the only cross-agent sharing path.
- **Approval gate:** only **`approved`** skills are materialized into runs.
  Draft → approved is a human action in the UI. This preserves the original
  "agent proposes, human approves" stance and the Agent Skills security
  guidance ("treat like installing software; trusted sources only").
- **Runtime materialization:** at run start, write the **owning agent's**
  `approved` skills to that run's skills directory as
  `<skills-dir>/<name>/SKILL.md` (e.g. `.claude/skills/` for `claude_code`).
  Native progressive disclosure then handles loading — Level 1 metadata
  always, body on match. **This replaces `pinned-memory` + `memory.search`
  injection.**
- **UI (required):** list skills; review/edit/approve/archive drafts; show
  provenance (which run/agent proposed it). New surface alongside the existing
  settings sections.

### 3. The learning meta-agent

A normal agent (runs, produces a transcript, calls tools) whose **role** is
meta: its input is *other agents' runs*, not a user task.

- **Identity:** a new first-class **`learning`** agent type, modeled like
  `manager`/`router` — a **system-provisioned workspace singleton**,
  auto-created when learning is enabled, **not** user-creatable in the agent
  dropdown (those types are already excluded at `default-agents.ts:136`). See
  [Cross-repo agent-type propagation](#cross-repo-agent-type-propagation) — the
  enum is the least-guarded in the repo, so adding `learning` is also when we
  make agent type first-class (DB CHECK + drift check).
- **Observer tool (NEW):** `agent_run.read` (or `transcript.read`) — read
  another agent's run messages + `agent_tool_call_event` rows **within the
  workspace**, read-only. Today only server-side code reads those; the
  meta-agent needs an agent-facing, workspace-scoped tool. Default-granted to
  the `learning` type.
- **Cadence (opt-in, toggleable per workspace; default OFF):** a **daily**
  scheduled run that samples **one random recent transcript** and reads a
  **window of ~10 messages** — deliberately lightweight. Not per-run, not full
  transcripts. Reuses the `scheduled_task` machinery (delivery
  `scheduled_agent_message` to the learning agent, with sampling metadata).
  Random sampling is the v1 selector; the sampler is **pluggable** so a future
  version can let the **user** or **an agent** choose the transcript.
- **Actions (ordinary tool calls, all visible in its transcript):**
  - **Bug** → hand off to the **planning agent** (reuse the existing
    `scheduled_agent_message` / `ChatGateway.post_message` hand-off; the
    planner creates work-items, tagged with an issue signature for dedup).
  - **Learning** → `skill.create` (draft).
  - **Durable fact** → `memory.create`.
- **Output:** its own transcript — the human opens it, sees what it flagged
  and why, and acts (approve a draft skill, review a planner work-item).

## Gating / flags

- `workspace_settings.learning_enabled` now means **"is the learning
  meta-agent scheduled to run"** — nothing more. It no longer gates memory or
  skills (those are universal).
- The `learning/memory-status` endpoint (recently pointed at the column) needs
  revisiting: its `learningEnabled` field now describes the meta-agent
  schedule, not memory availability.

## Triggers / scheduling

- One `scheduled_task` per opted-in workspace: daily, `scheduled_agent_message`
  → learning agent, with sampling metadata.
- Sampling (pick one random recent run, take a ~10-message window): either
  server-side at delivery time, or via a `agent_run.sample` tool the agent
  calls. *(Open — see decisions.)*
- Remove `reflection_dispatcher.maybe_enqueue` from the run-completion sites.

## Resolved decisions

1. **Learning agent type:** new first-class **`learning`** type (system role,
   like `manager`/`router`), *plus* make agent type first-class — DB CHECK
   constraint + add it to the cross-repo enum drift check. See
   [Cross-repo agent-type propagation](#cross-repo-agent-type-propagation).
2. **Sampling strategy:** **random** for v1; sampler built **pluggable** for
   future user-driven or agent-driven selection.
3. **Sampling location:** **server-side** seed at delivery (guaranteed to run);
   the agent can pull more via `agent_run.read`.
4. **Skill scope:** **agent-owned** (`agent_id` NOT NULL); cross-agent sharing
   is by **copy** (`skill.copy`, `copied_from_skill_id`). No workspace-wide
   scope.
5. **Memory search quality:** **recency-only for v1.** `memory.search` keeps
   the current behavior — most-recently-updated matching rows, not
   query-ranked — documented as a known limitation. FTS + vector ranking is
   deferred to a later pass. *Caveat:* reconcile the `memory_hybrid_search`
   call-signature mismatch so the recency RPC actually returns rows (the
   service passes `p_`-prefixed args the migration's function does not
   declare); this is *not* a special store for the learning agent — it's the
   one shared memory tool every agent uses.

## Cross-repo agent-type propagation

Agent type is the **least-guarded enum in the repo**: unlike
`runner_kind`/`provider`/`tracker_kind` it is **not** in
`platform/scripts/check-cross-repo-enums.mjs` and the DB `agent.type` column
has **no CHECK constraint**. Adding `learning` is the moment to fix that.
Touch together, in one series:

- **Platform contract:** `contracts/agents.ts:8` (`AgentTypeSchema`),
  `contracts/agent-runner-defaults.ts` (default runner kind for `learning`).
- **Platform branches:** `services/setup/builders/tool-policy.ts`,
  `services/tool-bundles.ts`, `services/default-agent-tools.ts`,
  `services/setup/default-agents.ts` (provision the singleton, keep it out of
  the user-selectable list).
- **Runtime (Elixir):** `agent_inventory/agent.ex:6`,
  `runner/llm_tool_runner.ex` (tool-bundle + prompt branches).
- **DB:** new migration adding a CHECK constraint on `agent.type`.
- **Drift guard:** add `agent_type` to `check-cross-repo-enums.mjs`.
- **Web:** *no* dropdown changes — `learning` is system-provisioned, not
  user-creatable (mirrors `manager`/`router`).
- **Go helper:** none (it only knows runner kinds).

## What we keep

- `memory_items` table + `memory.search` (ungated, general-purpose).
- `scheduled_task` machinery.
- The planning-agent hand-off for bugs (`scheduled_agent_message` /
  `post_message`); work-items as the remediation record.
- The filesystem skills convention as the materialization target.

## Rough PR sequencing

1. `memory.create` tool + ungate memory tools.
2. `skill` table + contract + `skill.create` tool (draft status) + RLS.
3. Skill materialization into the runner filesystem (Agent Skills format).
4. Skills UI (list, review, approve, edit, archive).
5. Learning meta-agent: `custom` agent + `agent_run.read` observer tool +
   sampling.
6. Daily scheduled trigger + per-workspace toggle; remove the
   after-every-run reflection dispatcher.
7. Retire `reflector` / `distiller` / `pinned-memory` / `candidate_skill` and
   move the superseded docs.
