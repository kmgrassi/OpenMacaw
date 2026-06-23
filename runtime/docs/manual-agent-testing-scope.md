# Manual Agent Testing Scope

## Goal

Make local agent development easier to prove end-to-end from the CLI. A
developer or coding agent should be able to start the runtime, trigger the same
paths the platform UI uses, force specific agent behaviors, and collect enough
evidence to know whether the stack worked.

This is the runtime-side companion to the platform manual-testing scope in
`parallel-agent-platform/docs/active/agent-manual-testing-scope.md`. The two
documents should converge on one local testing story: Platform owns user-facing
agent setup, message submission, browser proof, and cross-layer summaries;
Runtime owns gateway turns, model/tool execution, relay behavior, manager
scheduling, and runtime transcripts.

This document focuses on manual and semi-automated test surfaces for:

- gateway chat turns
- model-driven tool calls
- runtime-managed tool execution
- planner work item creation
- manager polling and dispatch
- local relay helper integration
- persistence and observability checks

Prefer end-to-end checks where practical. Unit tests are useful when they make a
CLI/API harness safe to refactor, but they should not be the only proof that
agent behavior works locally.

## Current Baseline

Useful pieces already exist, but they should not be treated as peer-level
commands. They answer different questions at different stages of debugging.

### Default command ladder

Use this order unless the failure already points at a specific subsystem:

1. `pnpm run start:local`
2. `pnpm run doctor:runtime`
3. `pnpm run snapshot:runtime -- --json`
4. `pnpm run smoke:gateway -- --message "hello"`
5. `pnpm run smoke:manager -- --workspace-id <workspace-id>` only when manager
   scheduling or manager-agent behavior is in scope.
6. `pnpm run smoke:local-relay -- --workspace-id <workspace-id>` only when
   local helper / local model routing is in scope.
7. `pnpm run logs:runtime -- --since 10m` after a smoke fails, using the IDs
   from the failed command when available.

The main rule: start broad, then narrow. Do not begin with raw `curl` endpoints
or low-level websocket debugging unless a higher-level command points there.

### Existing tools and when to use them

| Surface | What it answers | Use it when | Do not use it when |
|---|---|---|---|
| `pnpm run start:local` | Can the local launcher and orchestrator start? | Starting a fresh local runtime or reproducing a local failure from scratch. | Services are already running and you only need status; use `doctor:runtime`. |
| `pnpm run doctor:runtime` | What is obviously unhealthy right now? | First diagnostic step after "it does not work". Checks ports, health, env shape, and logs. | You need proof that a chat turn, tool call, or manager dispatch worked end-to-end. |
| `pnpm run snapshot:runtime -- --json` | What is the current structured runtime state? | You need machine-readable context for an agent, CI log, or follow-up debugging. | You only need a quick pass/fail health check; use `doctor:runtime` or `smoke:runtime`. |
| `pnpm run logs:runtime` | Which recent log lines explain a failure? | A smoke or doctor command failed and returned IDs, timestamps, or service names. | Before running a smoke. Logs are evidence after a failure, not the first proof. |
| `pnpm run smoke:runtime` | Are launcher, orchestrator, and direct database connectivity healthy? | Validating the base runtime stack before testing higher-level agent behavior. | Debugging a browser/gateway chat issue; use `smoke:gateway`. |
| `pnpm run smoke:gateway` | Does `/ws` accept gateway requests and optionally a `chat.send` turn? | Testing browser-equivalent chat transport without opening the UI. | Testing manager polling, due work item selection, or local relay registration. |
| `pnpm run smoke:manager` | Is a manager scheduler configured and ticking cleanly? | Checking manager health for a known workspace. | Proving the manager processed a specific due work item. This only proves readiness today. |
| `pnpm run smoke:local-relay` | Is local relay routing/registration healthy? | Testing local helper or local model routing. | Testing normal OpenAI/Codex gateway behavior. |
| `pnpm run debug:orchestrator:ws` | What exact gateway frames are sent and received? | You need low-level protocol visibility after `smoke:gateway` is too coarse. | As a routine health check. It exposes implementation detail and is easier to misuse. |
| `GET /api/v1/health` | Is the orchestrator HTTP process alive? | As a fallback curl, or when debugging a script that cannot call `doctor:runtime`. | As proof that agents work. Health only proves the process responds. |
| `GET /api/v1/state` | What work items/runs does the orchestrator currently know about? | Inspecting API-tracker state or a local work item run. | As a replacement for gateway or manager smokes. State can look fine while chat/tool paths are broken. |
| `POST /api/v1/items` | Can a work item be pushed into the API tracker? | Fast local runtime work-item testing without platform or Linear. | Testing planner-created work items. Planner validation should go through the planner agent and database assertions. |
| `GET /health` on launcher | Is launcher alive and is launcher-side database access healthy? | Fallback curl for launcher health or smoke script debugging. | As a standalone agent proof. Use `smoke:runtime` for the composed check. |
| `GET /api/runtime/manager-status` on launcher | What does launcher know about manager schedulers? | Debugging `smoke:manager` or inspecting manager status for a workspace. | As the only proof that manager handled work. It does not prove a specific decision or tool call. |

### How agents should interpret the baseline

Agents should treat the existing commands as a diagnostic ladder, not a menu:

- **Orientation:** `doctor:runtime`, then `snapshot:runtime`.
- **Base stack proof:** `smoke:runtime`.
- **Browser/chat path proof:** `smoke:gateway`.
- **Manager readiness proof:** `smoke:manager`.
- **Local model/relay proof:** `smoke:local-relay`.
- **Failure investigation:** `logs:runtime`, then raw endpoints only if the
  higher-level command identifies the failing boundary.

The raw endpoints are implementation details and fallback probes. They are
valuable for debugging scripts and verifying assumptions, but they should not be
presented as the preferred way to prove agent behavior.

### Why more targeted harnesses are still needed

The existing commands prove service health and a few broad paths. The remaining
gap is controlled agent behavior: "send this message", "make the model call this
tool", "prove the tool result was observed", "prove the planner persisted the
expected work item", and "prove the manager can dispatch from a due item".

## Principles

- **End-to-end first:** if a check can pass through the gateway, model adapter,
  tool executor, database, and logs, prefer that over testing one module.
- **Deterministic inputs:** test prompts, fake model responses, and work item
  payloads should be explicit files or JSON fixtures.
- **Machine-readable evidence:** every harness should support `--json` and
  include IDs needed for follow-up debugging.
- **No secrets in output:** service role keys, bearer tokens, env values, prompt
  bodies, and raw tool payloads should be redacted by default.
- **Use existing contracts:** extend gateway frames, local relay protocol, and
  existing smoke scripts before adding unrelated test-only protocols.
- **Visible failure causes:** failed runs should report which boundary failed:
  platform, launcher, orchestrator, gateway, model, relay, tool execution,
  database, or persistence.

## Cross-Repo Coordination With Platform

The platform and runtime scopes should not grow two independent smoke suites
that answer the same question differently. Treat them as a layered harness:

1. Platform proves the user-facing path and chooses the agent/workspace context.
2. Runtime proves the lower-level gateway, model, tool, relay, and scheduler
   paths for that same context.
3. Both repos emit enough shared identifiers for a developer or coding agent to
   pivot between the two without manually re-discovering state.

### Combined command ladder

Recommended local flow when both repos are available:

1. Runtime: `pnpm run start:local`
2. Platform: `pnpm run dev`
3. Platform: `pnpm run doctor -- --agent-id <agent-id> --workspace-id <workspace-id>`
4. Runtime: `pnpm run doctor:runtime`
5. Platform: `pnpm run agent:send-message -- --agent-id <agent-id> --workspace-id <workspace-id> --message "..."`
6. Runtime: `pnpm run agent:message -- --agent-id <agent-id> --workspace-id <workspace-id> --message "..."`
7. Platform: `pnpm run smoke:agent-tool-call -- --agent-id <agent-id> --workspace-id <workspace-id> --tool <tool-slug>`
8. Runtime: `pnpm run agent:tool-smoke -- --agent-id <agent-id> --workspace-id <workspace-id> --tool <tool-name>`
9. Platform: `pnpm run trace:agent -- --agent-id <agent-id> --since 10m`
10. Runtime: `pnpm run logs:runtime -- --since 10m --agent-id <agent-id>`

The duplicated message/tool commands are intentional, but they should answer
different questions. Platform commands prove the app-facing contract, auth,
diagnostics, and browser/API behavior. Runtime commands prove the gateway,
runner, model, relay, scheduler, and tool-execution internals after platform
has selected the same agent context.

### Ownership boundaries

| Capability | Platform owns | Runtime owns | Shared contract |
|---|---|---|---|
| Local readiness | Env files, API/web ports, auth, platform diagnostics | Launcher/orchestrator ports, runtime state, manager/local-relay readiness | `agentId`, `workspaceId`, `runnerKind`, `provider`, `model`, `canChat` / blocker summaries |
| Message trigger | API/UI message submission and message persistence checks | Gateway `chat.send`, run lifecycle, model result, terminal state | `requestId`, `sessionKey`, `runId`, `messageId`, terminal status |
| Direct tool invocation | Tool grant checks and platform-facing dev endpoint | Runtime tool registry, argument validation, execution, tool result encoding | tool slug/name mapping, `toolCallId`, sanitized input/result |
| Tool-call loop | Provider-neutral app proof that a tool was called and surfaced | Model-facing tool specs, tool choice, tool loop continuation | timeline events: message, tool call started/completed, final |
| Trace/debug bundle | Cross-layer summary, browser artifacts, API logs | Runtime logs, gateway/relay transcripts, scheduler events | JSON artifact manifest with redaction metadata |
| Scenario fixtures | User-facing scenario names and required agent setup | Runtime-specific fixtures and expected frame/event timelines | scenario id, preconditions, actions, assertions, timeout |

### Shared artifact shape

Every cross-repo smoke should be able to write a JSON summary with these fields:

```json
{
  "scenarioId": "coding-agent-filesystem-read",
  "status": "passed",
  "workspaceId": "<workspace-id>",
  "agentId": "<agent-id>",
  "requestId": "<request-id>",
  "sessionKey": "<session-key>",
  "runId": "<run-id>",
  "messageId": "<message-id>",
  "toolCallId": "<tool-call-id>",
  "startedAt": "2026-05-12T00:00:00.000Z",
  "finishedAt": "2026-05-12T00:00:01.000Z",
  "artifacts": [],
  "nextCommands": []
}
```

Fields can be `null` when a scenario does not exercise that layer, but the keys
should stay stable. Platform and runtime scripts can then consume each other's
output instead of forcing a developer to copy IDs by hand.

### Scenario naming

Use the same scenario IDs in both repos, even when each repo runs a different
implementation of that scenario:

| Scenario ID | Platform proof | Runtime proof |
|---|---|---|
| `plain-message` | API/UI can submit and display a message | Gateway accepts `chat.send` and reaches terminal state |
| `planning-agent-readonly` | Planner agent is configured and visible as read-only | Planner receives read-only tools and cannot execute write tools |
| `planner-work-item-create` | Work item appears through platform APIs/UI | Planner tool call creates the expected runtime/database record |
| `coding-agent-filesystem-read` | Granted shell tool is visible and observed | Runtime executes `shell.exec` and returns a tool result |
| `coding-agent-apply-patch` | Platform observes patch attempt/result | Runtime enforces workspace path safety and patch execution result |
| `manager-due-work-item` | Platform shows due item and manager status | Manager scheduler picks the due item and calls the expected tool |
| `local-relay-tool-round-trip` | Agent routes to local runtime and diagnostics show helper readiness | Relay dispatch, tool request, continuation, and terminal frame succeed |
| `missing-credential-blocker` | Platform reports deterministic blocker | Runtime does not start a model run and reports the same blocker category |

When scenario behavior changes, update both docs and both fixture definitions in
the same PR series rather than letting the names drift.

## 1. Gateway Message Trigger CLI

Add a higher-level CLI for sending a message through the runtime gateway and
waiting for a terminal result.

Suggested command:

```bash
pnpm run agent:message -- \
  --workspace-id <workspace-id> \
  --agent-id <agent-id> \
  --message "Create a one-step plan named CLI smoke" \
  --json
```

Implementation should build on `scripts/gateway-smoke.mjs` and
`scripts/runtime-ws-client.mjs`.

What it proves:

- WebSocket connects to `/ws`.
- Gateway scope and session key are valid.
- `chat.send` is accepted.
- A run ID is emitted.
- The run reaches `final`, `error`, or `aborted`.
- Recent logs can be correlated through request ID, session key, and run ID.

Success criteria:

- A developer can trigger the same runtime path as the browser without opening
  the platform UI.
- The command can accept the JSON output from platform `agent:send-message` or
  `doctor` and reuse its `agentId`, `workspaceId`, and request correlation
  fields.
- The command exits non-zero on gateway errors and model/runtime terminal
  errors.
- JSON output includes `workspace_id`, `agent_id`, `session_key`, `request_id`,
  `run_id`, final state, and next diagnostic commands.

## 2. Tool Call Scenario Harness

Add a CLI that asks an agent to call a named tool and verifies that the tool call
appears, executes, and returns a result.

Suggested command:

```bash
pnpm run agent:tool-smoke -- \
  --workspace-id <workspace-id> \
  --agent-id <agent-id> \
  --tool work_item.create \
  --fixture fixtures/tool-calls/planner-create-work-item.json \
  --json
```

The fixture should define:

- prompt text
- expected tool name
- expected argument subset
- expected result subset
- optional database assertion
- timeout

What it proves:

- Tool specs are visible to the model-facing runner.
- The model selects the expected tool.
- Tool arguments survive normalization.
- Runtime-managed tool execution receives the request.
- Tool results are returned to the agent loop.
- The assistant can finish after the tool result.

Success criteria:

- The harness fails if the agent responds with text but never calls the tool.
- The harness fails if the tool is called with the wrong schema.
- The harness maps runtime tool names back to the platform tool slug when both
  are present, so platform trace commands can find the same tool call.
- The harness produces a compact timeline of `message -> tool_call_started ->
  tool_call_completed -> final`.

Unit test support:

- Add fixture parser tests.
- Add gateway event timeline matcher tests.
- Add redaction tests for tool arguments and results.

## 3. Deterministic Fake Model Endpoint

Add a local fake model server that can return scripted assistant messages and
tool calls while still exercising the real runtime and gateway.

Suggested command:

```bash
pnpm run start:fake-model -- --scenario planner-create-work-item
pnpm run agent:message -- --profile fake-openai-compatible --message "run scenario"
```

The fake model should emulate the OpenAI-compatible contract enough to support:

- normal assistant text
- streaming deltas
- function/tool calls
- malformed tool call payloads
- model errors
- slow responses and timeouts

What it proves:

- Provider request construction is correct.
- Tool specs are sent in provider format.
- Streaming and non-streaming response normalization works.
- Agent loops handle deterministic tool-call responses without spending model
  quota.

Success criteria:

- Tool-call scenarios can run without OpenAI, Ollama, or a local helper.
- The fake model records every request and exposes it at a debug endpoint or
  writes a JSONL transcript.
- The same scenario can be used in `mix test` and CLI smoke tests.

Unit test support:

- Provider adapter tests should assert request shape against captured fake model
  requests.
- Tool-call parser tests should cover malformed or partial fake responses.

## 4. Runtime Tool Execution Endpoint

Add a dev-only endpoint that invokes a runtime tool with supplied arguments
under a real workspace/agent scope.

Suggested endpoint:

```text
POST /api/v1/dev/tools/:tool_name/execute
```

Suggested command:

```bash
pnpm run agent:tool-exec -- \
  --workspace-id <workspace-id> \
  --agent-id <agent-id> \
  --tool work_item.create \
  --args fixtures/tool-args/work-item-create.json \
  --json
```

This endpoint should be disabled unless an explicit local/dev config flag is
set.

What it proves:

- Tool registry lookup works.
- Scope validation works.
- Tool argument validation works.
- Database writes or side effects happen as expected.
- Tool result encoding matches what model loops receive.

Success criteria:

- Developers can debug a tool without forcing a model to choose it.
- The response includes the sanitized tool result and correlation IDs.
- The endpoint refuses to run outside local/dev mode.

Unit test support:

- Route auth/dev-mode guard tests.
- Tool argument validation tests.
- Per-tool execution tests for common planner and manager tools.

## 5. Forced Tool Call Gateway Mode

Add an optional gateway parameter that asks the runtime to force a tool choice
when the selected provider supports it.

Suggested message command:

```bash
pnpm run agent:message -- \
  --workspace-id <workspace-id> \
  --agent-id <agent-id> \
  --message "Use the task creation tool." \
  --force-tool work_item.create \
  --json
```

What it proves:

- Gateway request options reach the model adapter.
- Provider-specific `tool_choice` handling is correct.
- The agent loop can continue after a forced tool call.

Success criteria:

- The command clearly reports `unsupported_provider` when the provider cannot
  force a tool call.
- The harness fails if the provider ignores the forced tool and no matching tool
  event appears.
- No compatibility aliases are introduced for tool names or provider values.

Unit test support:

- Provider request-shape tests for `tool_choice`.
- Gateway option validation tests.

## 6. Planner Work Item End-to-End Smoke

Create a dedicated planner smoke that triggers a planner agent message and then
verifies database state.

Suggested command:

```bash
pnpm run smoke:planner-work-item -- \
  --workspace-id <workspace-id> \
  --agent-id <planner-agent-id> \
  --title "CLI planner smoke <timestamp>" \
  --json
```

What it proves:

- Planner agent receives a gateway message.
- Planner calls the task/work-item creation tool.
- The runtime creates a `work_items` row.
- The legacy `task` table is not written for direct planner task creation.
- The assistant reports IDs that match the database.

Success criteria:

- The command outputs the assistant-reported plan/work item IDs.
- Supabase REST verification confirms the `work_items` row.
- Supabase REST verification confirms the legacy `task` query returns `[]`.
- Output redacts service role keys and raw env.

Unit test support:

- Supabase REST query builder tests.
- Assistant ID extraction tests.
- Work item assertion tests against mocked REST responses.

## 7. Manager Due Work Item End-to-End Smoke

Extend `pnpm run smoke:manager` or add a sibling command that inserts or selects
a due work item, waits for a manager tick, and verifies the manager acted on it.

Suggested command:

```bash
pnpm run smoke:manager-dispatch -- \
  --workspace-id <workspace-id> \
  --agent-id <manager-agent-id> \
  --work-item-fixture fixtures/work-items/manager-dispatch.json \
  --json
```

What it proves:

- Manager scheduler is running for the workspace/agent.
- Due work item query finds the target row.
- Manager prompt includes the work item.
- Manager model call completes.
- Manager calls `dispatch_runner`, `snooze`, or the expected tool.
- The resulting work item state or metadata changes as expected.

Success criteria:

- The smoke can create a disposable work item with a unique title.
- The smoke waits for a fresh `last_tick_at`, not just any old tick.
- The smoke fails when `last_error` is present.
- Output includes the manager agent ID, tick timestamp, chosen action, and
  database assertion result.

Unit test support:

- Due work item fixture mapper tests.
- Manager status freshness tests.
- Tool-action assertion tests.

## 8. Local Relay Conversation Harness

Add a CLI that drives a full local relay conversation with a scripted helper or
real helper, including runtime-managed tool requests.

Suggested command:

```bash
pnpm run smoke:local-relay-conversation -- \
  --workspace-id <workspace-id> \
  --agent-id <agent-id> \
  --runner-kind planner \
  --scenario tool-call-round-trip \
  --json
```

What it proves:

- Helper registers the requested runner kind.
- Capability negotiation includes required runtime-managed tool support.
- Runtime dispatch reaches the helper over the relay socket.
- Helper sends a tool call request.
- Runtime executes or returns the tool result.
- Helper sends terminal completion.

Success criteria:

- The harness can run against a real helper or a scripted in-process helper.
- Failure output identifies whether registration, dispatch, capability
  negotiation, tool request, tool result, or terminal completion failed.
- Scenario transcripts can be saved as JSONL for regression tests.

Unit test support:

- Local relay protocol frame tests.
- Capability negotiation tests.
- Runtime-managed handler tests using saved transcripts.

## 9. Agent Transcript Capture and Replay

Add a redacted transcript format and replay command for gateway and relay runs.

Suggested commands:

```bash
pnpm run agent:message -- --message "..." --record .run-logs/transcripts/run.jsonl
pnpm run agent:replay -- --transcript .run-logs/transcripts/run.jsonl --json
```

Transcript events should include:

- gateway request/response metadata
- model request metadata
- assistant message deltas
- tool call start/completion summaries
- database assertion summaries
- terminal states
- errors with category and code

What it proves:

- A failure can be reproduced without manually collecting several logs.
- Regression tests can replay normalization and event timeline logic.
- Manual debugging has one portable artifact.

Success criteria:

- Transcripts are redacted by default.
- Replays can assert timeline invariants without calling external services.
- CLI output points to the exact failing event index.

Unit test support:

- Redaction tests.
- Transcript schema tests.
- Replay timeline matcher tests.

## 10. End-to-End Scenario Matrix Command

Add a single scenario runner that composes the targeted smokes into a local
manual acceptance suite.

Suggested command:

```bash
pnpm run smoke:agents -- \
  --workspace-id <workspace-id> \
  --planner-agent-id <planner-agent-id> \
  --manager-agent-id <manager-agent-id> \
  --json
```

Initial scenario matrix:

| Scenario | Primary proof |
|---|---|
| Platform preflight | platform `doctor` reports the selected agent can chat |
| Gateway hello | `/ws` connects and returns `hello-ok` |
| Plain message | `chat.send` reaches terminal state |
| Planner tool call | planner creates a `work_items` row |
| Direct tool exec | dev tool endpoint executes expected tool |
| Manager tick | manager status has fresh clean tick |
| Manager dispatch | due work item triggers expected manager action |
| Local relay | helper registration and dispatch work |
| Persistence | expected message/work item rows exist |
| Logs | run IDs can be found in platform and runtime logs |
| Snapshot | final `snapshot:runtime` reports healthy services |

What it proves:

- The local stack works as an agent development environment.
- The gateway, model, tool, database, manager, and local relay paths can all be
  validated from the CLI.
- The runtime evidence can be correlated with the platform API/browser evidence
  for the same `agentId`, `workspaceId`, `requestId`, and `runId`.
- A PR touching agent behavior can include one high-signal command in the
  handoff notes.

Success criteria:

- Each scenario can be run independently or as part of the matrix.
- The matrix reports skipped checks with explicit reasons.
- The final JSON summary includes pass/fail state, scenario durations,
  generated IDs, and next diagnostic commands.

## Suggested Implementation Order

1. Define the shared cross-repo scenario IDs and JSON artifact shape.
2. Gateway message trigger CLI.
3. Planner work item end-to-end smoke.
4. Tool call scenario harness.
5. Runtime tool execution endpoint.
6. Manager due work item end-to-end smoke.
7. Local relay conversation harness.
8. Deterministic fake model endpoint.
9. Forced tool call gateway mode.
10. Transcript capture and replay.
11. Scenario matrix command that can consume platform smoke artifacts.

This order gives the fastest practical value first: sending messages and
proving planner persistence. The shared scenario/artifact work comes first so
the platform and runtime CLIs can compose instead of producing incompatible
debug output. The later items make failures more deterministic and reduce
model/provider dependence.

## Open Questions

- Should dev-only endpoints live in the orchestrator under `/api/v1/dev/*`, or
  should they be exposed only through launcher-local commands?
- Which exact tool names should be first-class in fixtures once planner and
  manager tool names are finalized?
- Should the fake model server live in this repo, the platform repo, or a
  shared testing package?
- Should shared scenario fixtures live in both repos, one repo with generated
  copies, or a small shared package?
- How should scenario fixtures refer to agents without hardcoding local
  workspace IDs?
- Should CI run the full matrix nightly, or keep it local-only until the stack
  has stable seeded test workspaces?
