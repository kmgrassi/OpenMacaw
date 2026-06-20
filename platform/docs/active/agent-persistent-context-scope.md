# Agent Persistent Context — Scope

## Goal

An agent should have a **persistent text context** — a workspace-tunable
block of instructions, preferences, and learned patterns that flows
into every turn's system prompt. Today the `agent.context` column
exists on the DB but is **not wired into anything** — the runtime
loads it into the agent struct and then never reads it. Users have no
UI to edit it; agents have no tool to update it.

This scope wires the field end-to-end so it's a first-class
mechanism for shaping agent behavior over time.

Why this matters now: the upcoming manager-agent sweep work (deferred
gap) needs a customization surface so users (and agents themselves)
can specify situation-specific guidance — "always rebase on CI
failure," "always tag @kevin on schema migrations," "when a PR has
been idle 4h, ping the reviewer." Without a real persistent context
mechanism, the manager-agent has nowhere to read that guidance from.

Specifically:

1. **Prompt injection** — the runtime reads `agent.context` and
   prepends it to the system prompt on every turn.
2. **User-facing edit UI** — a "Context / Instructions" textarea in
   the agent settings page that round-trips to `agent.context`.
3. **Agent-callable tool** — `agent_context.update` lets the agent
   itself propose updates based on what it learns mid-task.
4. **Self-update policy** — workspace-level toggle controlling
   whether agent-initiated updates apply immediately or require
   user approval.
5. **Versioning + history** — every change writes a row to
   `agent_context_version` so users can audit and revert.

The "agent updates its own context based on what it learns" is the
key payoff: the agent that just got bitten by a flaky test can write
"these tests in `tests/integration/auth_test.exs` are flaky; retry
once before declaring failure" into its own context, and every
future turn (and every future agent run) starts with that knowledge.

## Current state

This section is grounded in a code audit.

### What exists

- **`agent.context` column** on the `agent` table in harper-server
  (`packages/supabase-schema/src/database.types.ts`, type `string |
  null`). Nullable text. No default.
- **Runtime loads it** into the agent struct:
  `parallel-agent-runtime/apps/orchestrator/lib/symphony_elixir/agent_inventory/agent.ex:25,65,88`.
  The struct field is `context: String.t() | nil`.
- **Comments hint at custom-instructions intent** but the field is
  not used — `agent_config.ex:17` mentions "custom instructions" in
  a comment about future runtime knobs, but does not implement them.

### What doesn't exist

- **No prompt injection.** Grep across the runtime's runner code
  (`llm_tool_runner.ex`, `planner.ex`, `codex.ex`, `openclaw.ex`,
  `computer_use.ex`, `local_relay.ex`) shows zero call sites that
  read `agent.context` and inject it into system prompts or message
  construction. The field is dead data today.
- **No user-facing edit UI.** The agent settings page in
  `apps/web/src/components/settings/` has no "Context" or
  "Instructions" textarea bound to `agent.context`. Existing fields
  (model, credentials, tools) are edited but not context.
- **No agent-callable tool.** No `agent_context.update`,
  `agent.update_context`, or any tool that writes back to
  `agent.context`. The platform's tool catalog and runtime tool
  registry have no entry for this.
- **No versioning / history.** A single nullable text column with no
  audit trail; previous values are lost on update.
- **No self-update policy.** Without the tool and history,
  workspace-level toggle for approval flow isn't meaningful yet.

## Proposed model

### Schema additions

Harper-server migration:

```sql
-- Add versioning to the existing agent.context field.
ALTER TABLE public.agent
  ADD COLUMN context_version integer NOT NULL DEFAULT 1
    CHECK (context_version > 0),
  ADD COLUMN context_updated_at timestamptz,
  ADD COLUMN context_updated_by_user_id uuid REFERENCES public."user"(id),
  ADD COLUMN context_updated_by_agent_id uuid REFERENCES public.agent(id);

-- Constraint: exactly one of (user, agent) is the last updater, or
-- neither (system default). Both being set is invalid.
ALTER TABLE public.agent
  ADD CONSTRAINT agent_context_updater_single_source CHECK (
    num_nonnulls(context_updated_by_user_id, context_updated_by_agent_id) <= 1
  );

-- Immutable history of every prior context value.
CREATE TABLE public.agent_context_version (
  agent_id uuid NOT NULL REFERENCES public.agent(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  context text,                              -- the context at this version
  reason text,                               -- why it was changed (free text)
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id uuid REFERENCES public."user"(id),
  updated_by_agent_id uuid REFERENCES public.agent(id),
  PRIMARY KEY (agent_id, version),
  CONSTRAINT agent_context_version_updater_single_source CHECK (
    num_nonnulls(updated_by_user_id, updated_by_agent_id) <= 1
  )
);

CREATE INDEX agent_context_version_recent
  ON public.agent_context_version (agent_id, version DESC);

COMMENT ON TABLE public.agent_context_version IS
  'Immutable history of every prior agent.context value. New row written on every update. Reverts work by reading an old version and writing it as a new version (not by deleting newer versions).';

-- Pending updates from agent self-update when policy requires
-- user approval before applying.
CREATE TABLE public.agent_context_pending_update (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.agent(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  proposed_context text NOT NULL,
  proposed_reason text NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  proposed_by_agent_id uuid NOT NULL REFERENCES public.agent(id),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'approved', 'rejected', 'superseded')),
  resolved_at timestamptz,
  resolved_by_user_id uuid REFERENCES public."user"(id),
  resolution_notes text
);

CREATE INDEX agent_context_pending_workspace
  ON public.agent_context_pending_update (workspace_id, state)
  WHERE state = 'pending';
```

### Workspace policy

Add to the workspace settings (or `gateway_config.body`):

```typescript
agent_context: {
  auto_apply_self_updates: z.boolean().default(false),
  // false (v1 default): agent-initiated updates create a pending row;
  //                     a workspace member approves/rejects via UI.
  // true:               agent-initiated updates apply immediately,
  //                     write directly to agent.context and history.
}
```

User-initiated updates always apply immediately (no policy gate — the
user has direct authority over their own context).

### Prompt injection

In every runner that builds a system prompt
(`llm_tool_runner.ex`, `planner.ex`, `codex.ex`, etc.), inject
`agent.context` (when non-empty) into the system prompt. Suggested
placement: after the runner-kind-specific preamble, before any
task-specific framing:

```
[runner preamble — describes the agent kind, e.g. "You are a coding agent..."]

[CONTEXT BLOCK — only when agent.context is non-empty]
The following is workspace-specific guidance for this agent:

<agent.context verbatim>

[/CONTEXT BLOCK]

[task-specific framing]
```

The context block is wrapped with delimiters so the model knows what
chunk is user-tunable workspace guidance vs the system's
instructions.

Token budget: `agent.context` is unbounded in the DB today. Add an
8,000-character application-layer cap with a clear validation error.
(Long context erodes attention; if a workspace needs more, the
universal memory items system is a better home.)

### `agent_context.update` tool

New tool registered in the platform tool catalog:

```typescript
// contracts/tools/agent-context-update.ts
const args = z.object({
  new_context: z.string().min(1).max(8000),
  reason: z.string().min(1).max(2000),
});
```

Tool dispatch (runtime side):

1. Validate args; reject if outside limits.
2. Read workspace policy `agent_context.auto_apply_self_updates`.
3. **If true (auto-apply)**:
   - Write to `agent.context`, increment `context_version`, set
     `context_updated_at`, `context_updated_by_agent_id`.
   - Write prior context to `agent_context_version`.
   - Return success with the new version number.
4. **If false (default — requires approval)**:
   - Write a row to `agent_context_pending_update` with state
     `pending`.
   - Return a confirmation message including the pending update id.
   - The agent's turn continues — the proposed update doesn't pause
     the work item.
5. On any pending update being **approved** by a user (via the UI):
   - Apply the proposed_context the same way auto-apply would.
   - Mark the pending row `approved`.
6. On **rejection**: mark the pending row `rejected` with optional
   notes.
7. On a **new proposal landing while an earlier one is pending**:
   mark the earlier one `superseded`; only the latest pending row is
   reviewable.

### `agent_context.read` tool

Optional but cheap: agent can read its own current context if
helpful. (The context is in the system prompt anyway, so this is
mostly redundant — but useful for the agent to verify it's been
applied before proposing an update.) Skip in v1 unless explicit need.

### User-facing edit UI

Agent settings page gets a new section:

```
┌─ Context / Instructions ──────── version 7 ─┐
│ Persistent guidance for this agent. Included│
│ in every turn's system prompt.              │
│                                             │
│ ┌─────────────────────────────────────────┐ │
│ │ <textarea bound to agent.context>      │ │
│ │                                         │ │
│ └─────────────────────────────────────────┘ │
│ 2,341 / 8,000 characters                    │
│                                             │
│ [View version history]    [Save changes]    │
└─────────────────────────────────────────────┘

┌─ Pending agent-proposed updates ─────────────┐
│ (rendered only when pending rows exist)      │
│                                              │
│ ◉ Agent proposed at 2026-05-23 11:00:        │
│   reason: "encountered flaky test, want to   │
│           remember the retry pattern"         │
│   <diff: old context vs proposed_context>    │
│   [Approve] [Reject with notes]              │
└──────────────────────────────────────────────┘
```

Version history opens a side panel listing
`agent_context_version` rows with timestamps, the actor (user vs
agent), reason, and diff view. Revert button writes the old version
as a new version.

### Auto-apply vs approval — default rationale

Default `auto_apply_self_updates: false` because:

- Self-drift is real: an agent can quietly accumulate self-modifying
  instructions that gradually change its behavior in unintended
  ways.
- Approval flow is cheap when updates are infrequent (which they
  should be — context updates are not per-task, they're per-pattern).
- Workspaces that want fully autonomous self-tuning can opt in.

The approval flow is **lightweight** — not coupled to the attention
queue (which is for human-gated escalations and may not be built
yet). A dedicated section on the agent settings page is enough.

## Phased migration

### Phase 1 — DB schema (harper-server)

Migration extending `agent` + adding `agent_context_version` +
`agent_context_pending_update` tables. RLS using
`public.is_workspace_member` per the canonical helper.

### Phase 2 — Prompt injection (runtime)

In each runner that builds a system prompt, read `agent.context`
from the agent struct and inject the CONTEXT BLOCK when non-empty.
Tests cover the with-context and without-context cases.

### Phase 3 — Repository + read API (platform)

- `apps/api/src/repositories/agent-context.ts` with `read` (gets
  current context + version) and `update` (user-initiated update;
  writes new context + history row).
- Routes: `GET /api/agents/:agentId/context`, `PUT
  /api/agents/:agentId/context`.
- Validation: char length, sanitization.

### Phase 4 — Settings UI (platform web)

Agent settings page gets the Context section. React Query for the
data fetch; optimistic save with rollback on error.

### Phase 5 — Version history UI

Side panel with the version list, diff view, revert button.

### Phase 6 — `agent_context.update` tool (platform + runtime)

- Contract in `contracts/tools/agent-context-update.ts`.
- Platform tool catalog entry.
- Default grant: every agent gets this tool by default (workspace can
  exclude via the existing tool grant mechanism if it wants).
- Runtime tool dispatcher implements the policy-gated write.
- Pending-update repository in platform.

### Phase 7 — Pending-update review UI

Settings page's "Pending agent-proposed updates" subsection.
Approve / reject actions.

### Phase 8 — Workspace policy toggle

Workspace settings writes
`agent_context.auto_apply_self_updates` via a boolean checkbox.
Default off.

## Open questions

### OQ-AC-1 — Per-agent or per-workspace context?

v1 scopes per-agent only. But many workspaces will want
"workspace-level instructions that apply to every agent" too. Two
shapes:

- Per-workspace `workspace.context` field that the runtime prepends
  to per-agent context.
- Workspace memory items (from the learning-agent redesign scope) that
  every agent retrieves.

**Tentative answer**: defer workspace-level context until a use case
demands it. If users start writing the same instructions into every
agent's context, that's the signal to add workspace-level.

### OQ-AC-2 — Read tool — yes or no?

Skip in v1. The context is in the system prompt; the agent can see
it. A read tool is mostly redundant.

**Tentative answer**: no read tool in v1. Add if agents start asking
"what's my current context?" mid-turn in ways that indicate they
need to verify it independently of the prompt.

### OQ-AC-3 — Is the 8K context cap reasonable?

A typical "context" should be 100-2000 chars. 8K is already generous
and keeps the API/tool/UI validators aligned.

**Tentative answer**: yes, ship with 8K. Revisit if a real use case
hits the cap.

### OQ-AC-4 — What about agent-pending-update tool grant?

Default grant of `agent_context.update` to every agent feels right
(it's a self-update; no privilege escalation). But the tool-grant
system might want to be explicit.

**Tentative answer**: include in the default tool templates
(`planner`, `coding`, `manager`) via the existing
`tool_policy_template` mechanism. Workspaces can exclude via grant.

### OQ-AC-5 — Diff view for version history — simple or fancy?

A side-by-side diff is nice but adds React complexity. A plain
"old text / new text" two-pane is simpler.

**Tentative answer**: plain two-pane in v1. Upgrade to inline diff
later if asked.

## Out of scope

- **Workspace-level shared context** — see OQ-AC-1.
- **Per-agent context that varies by task / runner kind** — v1 is
  one context per agent. If `codex` and `local_model_coding` runners
  on the same agent need different contexts, that's a future
  extension.
- **Per-conversation context** (different context for different
  message threads on the same agent). Not a real use case yet.
- **Memory integration** — the `memory_items` system is
  the right home for *retrieved* context (per-situation). This scope
  is for *standing* context that applies to every turn. Two different
  surfaces; don't conflate.
- **Template / shared-context library** ("clone this context from
  another agent"). Probably a useful follow-up; not v1.
- **Attention-queue integration for pending updates.** Pending
  agent-context updates have their own dedicated UI section, not the
  attention queue. The attention queue is for human-required
  decisions that pause work items; pending context updates don't
  pause anything.

## Success criteria

1. An agent with `agent.context = "Always use four-space
   indentation."` actually has that text in every turn's system
   prompt — verified by capturing the prompt in a test.
2. A user editing the textarea in agent settings round-trips the
   value to `agent.context`. Save creates a new
   `agent_context_version` row with the prior text + the user as
   updater.
3. An agent calling
   `agent_context.update(new_context: "...", reason: "...")` with
   workspace policy `auto_apply_self_updates: false` creates a
   `agent_context_pending_update` row in state `pending`. The agent's
   turn continues; nothing is written to `agent.context` yet.
4. A user approving the pending update applies the new context
   atomically, creates a history row with the agent as updater,
   transitions the pending row to `approved`.
5. With `auto_apply_self_updates: true`, the agent's
   `agent_context.update` writes directly without a pending row.
6. Revert from the version history list writes the old context as a
   new version (preserves linear history; doesn't delete).
7. `agent.context` exceeding 8,000 chars on save returns a clear
   API error; the DB enforces no hard cap (cap is application-layer
   to allow programmatic writes; CHECK on length is overkill).

When all seven are true, the agent persistent context surface is
real, usable, and ready to be referenced by the upcoming
manager-agent sweep scope (which can store its
context-based behavior tuning in `agent.context` on the manager
agent itself).
