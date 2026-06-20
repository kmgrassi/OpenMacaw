# Learning Sidecar — Runtime Scope

> Superseded by
> [`../active/learning-agent-redesign-scope.md`](../active/learning-agent-redesign-scope.md).

Runtime-side companion to the Hermes-style learning sidecar scoped in
`parallel-agent-platform`. This doc owns the Elixir orchestrator
changes that let the platform's `memory_items` table be populated
after agent runs and let new scheduled-task kinds dispatch correctly.

Cross-repo companions:

- **Platform** (canonical scope + write/read APIs + tools):
  `parallel-agent-platform/docs/superseded/learning-sidecar-scope.md`
- **Platform** (PR plan across all repos):
  `parallel-agent-platform/docs/superseded/learning-sidecar-pr-plan.md`
- **Helper** (no work required — explanation):
  `local-runtime-helper/docs/learning-sidecar-helper-scope.md`

## What runtime owns

Two changes here, both already enumerated as PRs in the platform's PR
plan; this doc just gives them a runtime-local home so the work is
discoverable from the runtime side.

### 1. Mirror `ScheduledTaskDeliverySchema` widening (PR B0b)

**Platform PR plan reference:** PR B0b.

Today `SymphonyElixir.ScheduledTask.Delivery` posts the task instruction
through `ChatGateway` unconditionally — every row is treated as a
`scheduled_agent_message`. Once the platform widens
`ScheduledTaskDeliverySchema` into a discriminated union covering
`scheduled_agent_message | learning_reflection | learning_distillation`
(platform PR B0a), the runtime needs to dispatch by `delivery.kind`:

```elixir
def deliver(task, opts) do
  case task.delivery["kind"] do
    "scheduled_agent_message" ->
      deliver_agent_message(task, opts)

    kind when kind in ["learning_reflection", "learning_distillation"] ->
      # The runtime is transport for these; the platform owns execution.
      enqueue_platform_handler(task, opts)
  end
end
```

For the `learning_*` kinds the runtime POSTs the task payload to a new
platform endpoint (see platform PR B2) rather than spinning up an
agent. The runtime is *transport* for these jobs, not executor.

**Files that change:**

| Path | Change |
| --- | --- |
| `apps/orchestrator/lib/symphony_elixir/scheduled_task/delivery.ex` | Replace single-branch delivery with dispatch by `kind`. |
| `apps/orchestrator/lib/symphony_elixir/scheduled_task/repository.ex` | If any row-shape parsing assumes the single-literal kind, widen it. |
| `apps/orchestrator/test/symphony_elixir/scheduled_task/delivery_test.exs` | Add cases for the two new kinds — one asserting `ChatGateway` is NOT called, one asserting the platform-handler POST is. |

**Risk:** a row with an unknown `kind` should fail loudly (raise) so a
future kind shipping in platform without a runtime update doesn't get
silently dropped. The existing `case` will fall through to a `MatchError`
if we don't add an explicit catch-all — current scope: do not add one,
loud failure is desired.

### 2. Session-completion hook → enqueue reflection (PR B1)

**Platform PR plan reference:** PR B1.

Earlier drafts of this doc named `BrokerLogAdapter.finalize/2` as the
hook point. That is **wrong** — that function only takes
`(run_id, result)` and writes `broker_run.status`. It does not have
the scope, the transcript, the session_thread_id, or anything else
the reflector needs.

The actual completion-with-data path is in the chat gateway. Two
separate code paths converge on `SessionStore.complete_run/2`:

| Caller | File | What's in scope at call time |
| --- | --- | --- |
| Server-initiated runs | `apps/orchestrator/lib/symphony_elixir/chat_gateway.ex:279` (`defp complete_run/5`) | `scope` (workspace_id + agent_id), `session_thread_id`, `run_id`, `buffer` (full transcript), `opts` (model, provider, usage, response_id) |
| WebSocket-driven runs | `apps/orchestrator/lib/symphony_elixir_web/gateway_socket.ex:181` | Same shape — `scope`, `session_thread_id`, `run_id`, plus the WS-side buffer |

Both call sites invoke `SessionStore.complete_run(run_id, opts)` and
then persist the assistant message via `record_assistant_message`.
The reflection enqueue belongs **after** the assistant message
persists (so the platform has the transcript on disk by the time the
reflector reads it back).

The work is one new module that the two completion sites call into:

`apps/orchestrator/lib/symphony_elixir/learning/reflection_dispatcher.ex`

```elixir
defmodule SymphonyElixir.Learning.ReflectionDispatcher do
  @moduledoc """
  After every completed run, enqueue a learning_reflection scheduled_task
  row so the platform-side reflector can summarise the transcript into
  memory_items. Best-effort: failing the enqueue must NOT fail the run.

  The dispatcher's payload is intentionally minimal: workspace_id,
  agent_id, run_id, source_work_item_id. It does NOT carry the
  transcript inline — the platform reflector reads the persisted
  transcript via the existing message-history API. Keeps the
  dispatcher fast and decouples it from in-memory SessionStore state
  (which is process-local).
  """

  def maybe_enqueue(_scope, _run_id, _opts) when not @reflection_enabled, do: :ok
  def maybe_enqueue(scope, run_id, opts) do
    if workspace_learning_enabled?(scope.workspace_id) do
      enqueue(scope, run_id, opts)
    else
      :ok
    end
  rescue
    error ->
      Logger.warning("reflection_enqueue_failed", error: inspect(error), run_id: run_id)
      :ok
  end
end
```

Called from **both** completion call sites (chat_gateway and
gateway_socket) after the assistant message has been recorded:

```elixir
# chat_gateway.ex:279 (sketch)
defp complete_run(scope, session_thread_id, run_id, buffer, opts) do
  case SessionStore.complete_run(run_id, opts) do
    {:ok, session} ->
      :ok = record_assistant_message(scope, session_thread_id, ..., run_id, ...)
      # NEW:
      ReflectionDispatcher.maybe_enqueue(scope, run_id,
        source_work_item_id: extract_source_work_item_id(opts)
      )
      {:ok, run_id}
    # ...
  end
end
```

The dispatcher reads two gates:

1. `LEARNING_REFLECTION_ENABLED` env var (default `false`) — kill
   switch for the whole runtime.
2. The platform's per-workspace `workspace.settings.learning.enabled`
   flag (via the existing workspace-settings RPC). Lets us dark-launch
   per workspace.

The `scheduled_task` row this writes has shape:

```json
{
  "agent_id": "<scope.agent_id>",
  "workspace_id": "<scope.workspace_id>",
  "delivery": {
    "kind": "learning_reflection",
    "sourceRunId": "<run_id>",
    "sourceTaskId": "<source_work_item_id_or_null>"
  },
  "next_run_at": "<now>",
  "enabled": true
}
```

The existing `Scheduler` GenServer picks it up on the next tick and
the dispatcher from change #1 routes it to the platform handler.
**Importantly, the transcript itself is not in the payload** — only the
identifiers needed for the reflector to look it up. This matches the
existing patterns: scheduled-task rows carry references, not bulk
data.

**Why not `BrokerLogAdapter.finalize/2`?** It runs in the runner-loop
process and only has the run_id. Even if we expanded its signature, it
runs *before* the chat-gateway path persists the assistant message —
the reflector would race the message-history write. The chat-gateway /
gateway-socket completion sites both run *after* persistence, which
makes them the correct hook.

**Files that change:**

| Path | Change |
| --- | --- |
| `apps/orchestrator/lib/symphony_elixir/learning/reflection_dispatcher.ex` | New module. |
| `apps/orchestrator/lib/symphony_elixir/chat_gateway.ex` | After `record_assistant_message` returns in `complete_run/5`, call `ReflectionDispatcher.maybe_enqueue/3`. |
| `apps/orchestrator/lib/symphony_elixir_web/gateway_socket.ex` | Same hook after the WS-path `SessionStore.complete_run` succeeds. |
| `apps/orchestrator/lib/symphony_elixir/scheduled_task/repository.ex` | New insert helper for the learning-job rows (keep separate from the existing agent-message insert path; uses the partial unique index from the harper-server migration to dedupe on `source_run_id`). |
| `apps/orchestrator/config/runtime.exs` | Read `LEARNING_REFLECTION_ENABLED` env into `:learning` app config. |
| `apps/orchestrator/test/symphony_elixir/learning/reflection_dispatcher_test.exs` | New module's tests. |
| `apps/orchestrator/test/symphony_elixir/chat_gateway_test.exs` + `test/symphony_elixir_web/gateway_socket_test.exs` | Assert each completion path calls the dispatcher; assert dispatcher failure doesn't propagate to the run. |

## What runtime does NOT own

| Concern | Owner |
| --- | --- |
| `memory_items` schema (already migrated) | `harper-server` |
| Memory write endpoint (`POST /api/memory/items`) | `parallel-agent-platform` (Track A3) |
| Reflection LLM call / prompt / output parsing | `parallel-agent-platform` (Track B2) |
| `memory.search` tool handler + pinned-prompt block | `parallel-agent-platform` (Track C) |
| Skill distillation | `parallel-agent-platform` (Track D, blocked) |
| `ScheduledTaskDeliverySchema` contract definition | `parallel-agent-platform` (Track B0a) |

Memory-writes flow through the platform's HTTP API even though the
runtime is the trigger — keeps Supabase-row-write business logic
(validation, RLS, audit) in one place and one language. The runtime's
job is to *notice* a run completed and *enqueue* a job; the platform
does the LLM call and the persistence.

## Dependency order

```
platform B0a (contract widening)
    ↓
runtime  B0b  (this scope — dispatcher change)  ← independent of B1
    ↓
runtime  B1   (this scope — finalize hook)      ← needs B0a + B0b
                                                  ← needs platform A3 endpoint live
                                                    to actually result in memory rows
                                                    being written, but does not need
                                                    A3 to be in code for B1 to merge
```

B0b can ship while platform B2 is still in development — the runtime
will route to the platform handler that B0a stubbed out, which logs
"not implemented" until B2 lands. B1 should only flip `:learning,
reflection_enabled: true` in any environment after both B2 and A3 are
in place.

## Risks specific to the runtime

**Hot-path latency.** The chat-gateway / gateway-socket completion
paths are called inline from the agent's run-completion path (right
after the assistant message is persisted). The dispatcher's enqueue
must be fast and must not block on platform availability — implemented
as a fire-and-forget DB insert into `scheduled_task` (no HTTP call, no
remote dependency). The platform-handler POST in change #1 only fires
on scheduler tick, not at completion time.

**Idempotency.** If a completion path runs twice for the same run
(restart, retry, race between the two completion sites), the
dispatcher must not enqueue two reflection rows. Either: insert with
`ON CONFLICT DO NOTHING` on a partial unique index, or pre-check
before insert. Initial scope: partial unique index on
`scheduled_task(workspace_id, delivery->>'sourceRunId')` where
`delivery->>'kind' = 'learning_reflection'` — migration owned by
harper-server (call it out as an addendum to the platform PR plan's
A1 migration or its own follow-up).

**Two call sites must stay in sync.** Hooking in both `chat_gateway`
and `gateway_socket` means one path could grow a new code branch that
forgets the dispatcher call. Mitigation: a small integration test
that exercises both paths and asserts a reflection row appears. If a
third completion path is ever added, this doc must grow a row in the
"Files that change" table.

**Per-workspace flag latency.** The runtime caches workspace settings
for a short TTL (current value: 30s). A flip in the platform UI may
take up to that long to take effect in the runtime. Acceptable for v1.

## Out of scope here

Same as the canonical platform scope, repeated for runtime-reader
convenience:

- No replacing the agent runner with a Hermes runner.
- No new scheduler — reuses `scheduled_task`.
- No new vector store — reuses pgvector via `memory_hybrid_search`
  (called from platform; runtime never touches it directly).
- No memory eviction in v1.
