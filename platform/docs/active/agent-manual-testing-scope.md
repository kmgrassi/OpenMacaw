# Agent Manual Testing Scope

## Goal

Make local agent development easier to prove end to end from the CLI.

Today, we have useful pieces: `pnpm run doctor`, `pnpm run logs:summary`,
agent diagnostics, agent health, tool definition routes, and a few smoke
endpoints. The gap is that a developer still has to stitch those pieces
together by hand to answer simple questions:

- Can this agent receive a message?
- Did runtime dispatch actually start?
- Were tool definitions resolved for the selected agent?
- Can a tool call be executed and observed?
- Did the web, API, launcher, orchestrator, and runtime all see the same run?

The preference is for end-to-end probes that use real local services and real
contracts. Unit tests are still useful when they lock down parsing,
classification, or safety checks that would make the end-to-end probes flaky.

## Non-Goals

- Do not add compatibility shims for old request or response shapes.
- Do not create fake success paths that bypass the API, launcher, or runtime
  layers being tested.
- Do not hardcode credentials, models, agent ids, or workspace ids.
- Do not mutate production data from a smoke command unless the command name,
  flags, and output make that write explicit.

## Existing Baseline

Useful pieces already exist, but they should not be treated as a flat menu.
They answer different questions at different layers. The runtime companion
scope in
[`parallel-agent-runtime#294`](https://github.com/kmgrassi/parallel-agent-runtime/pull/294)
uses the same framing: start broad, then narrow to the boundary that failed.

### Default command ladder

Use this order unless the failure already points at a specific subsystem:

1. Runtime repo: `pnpm run start:local`.
2. Platform repo: `pnpm run dev`.
3. Platform repo: `pnpm run doctor`.
4. Platform repo: `pnpm run doctor -- --agent-id <agent-id> --workspace-id <workspace-id>`
   when a specific agent is in scope.
5. Runtime repo: `pnpm run doctor:runtime` and
   `pnpm run snapshot:runtime -- --json` when platform diagnostics say the
   runtime, launcher, gateway, manager, or local relay is the likely boundary.
6. Platform repo: `pnpm run logs:summary -- --since 10m --agent-id <agent-id>`
   after a smoke or doctor command fails.
7. Runtime repo: `pnpm run logs:runtime -- --since 10m` after a runtime smoke
   fails.

The main rule: do not start with raw endpoints. Use platform diagnostics first
to prove auth, routing, agent configuration, and tool grants. Use runtime
diagnostics next to prove launcher/orchestrator/gateway/relay execution.

### Existing tools and when to use them

| Surface                                                            | What it answers                                                 | Use it when                                                                                   | Do not use it when                                                                  |
| ------------------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `pnpm run doctor`                                                  | Is the platform API/web/dev environment basically ready?        | First diagnostic step after "the local app does not work."                                    | Proving a chat turn or tool call completed end to end.                              |
| `pnpm run doctor -- --agent-id ... --workspace-id ...`             | Is this agent chat-ready from the platform's point of view?     | Checking auth, routing, agent diagnostics, and high-level runtime reachability for one agent. | Debugging low-level gateway frames or relay registration. Use runtime smokes there. |
| `pnpm run logs:summary`                                            | Which platform log lines explain a failure?                     | A doctor/smoke command failed and you have an agent id, request id, or timestamp.             | Before running a smoke. Logs are evidence after a failure, not the first proof.     |
| `GET /api/diagnostic/agents/:agentId?workspaceId=...`              | Why does the platform think an agent can or cannot chat?        | Building or debugging scoped doctor output.                                                   | As a direct manual first step; the CLI should package this with next actions.       |
| `GET /api/agents/:agentId/health` and `GET /health?agentId=...`    | Is platform-to-runtime health reachable for this agent?         | Diagnosing platform routing or launcher reachability.                                         | As proof that agent behavior works. Health only proves reachability.                |
| `POST /api/agents/:id/messages` and `GET /api/agents/:id/messages` | Can the platform persist and read user-visible messages?        | Verifying message persistence or implementing `agent:send-message`.                           | As proof that runtime dispatch, model calls, or tool calls happened.                |
| Tool settings routes                                               | Are tool templates/grants configured for an agent?              | Preflighting tool-call scenarios or debugging missing tools.                                  | Executing tools. Tool grants are configuration, not execution proof.                |
| Existing smoke route files                                         | Do route contracts and harness-specific assumptions still hold? | Protecting platform contract behavior in tests.                                               | As a substitute for a local full-stack agent run.                                   |
| Browser runbook                                                    | What should a human see in the UI?                              | Verifying UX, auth, rendering, and visible dashboard behavior.                                | Debugging a runtime-only failure without platform/UI involvement.                   |

### Platform and runtime ownership

The two scoping documents should stay aligned, but each repo should own the
proofs closest to its boundary:

| Question                          | Platform-owned proof                                                      | Runtime-owned proof                                                             |
| --------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Can the selected agent chat?      | `doctor -- --agent-id --workspace-id`, diagnostic endpoint, health proxy. | `doctor:runtime` only after platform points at runtime reachability.            |
| Did a user message get accepted?  | `agent:send-message`, message POST/GET, browser smoke.                    | `smoke:gateway -- --message ...` for direct gateway acceptance.                 |
| Were the right tools available?   | Tool settings/grants checks and dispatch dry-run.                         | Provider request/tool-spec capture or fake model request transcript.            |
| Did the model call a tool?        | Platform trace verifier sees tool-call evidence and message updates.      | Runtime tool-call scenario harness sees gateway/model/tool timeline.            |
| Did a planner create work?        | Platform verifies assistant-visible IDs and product DB state.             | Runtime verifies planner tool execution and `work_items` persistence.           |
| Did the manager process due work? | Platform verifies due work item setup and user-visible state changes.     | Runtime verifies scheduler tick, prompt inclusion, and manager tool action.     |
| Did local relay work?             | Platform verifies execution profile routes to local runtime.              | Runtime verifies helper registration, capability negotiation, and relay frames. |

### Shared scenario contract

The biggest synergy is not duplicating commands; it is sharing scenario inputs
and correlation fields. Platform and runtime smokes should consume compatible
fixture metadata:

- `scenario`
- `workspaceId`
- `agentId`
- `runnerKind`
- `provider`
- `expectedTool`
- `expectedDatabaseAssertion`
- `requestId`
- `messageId`
- `runId`
- `toolCallId`

Platform commands should produce IDs that runtime commands can accept, and
runtime commands should produce IDs that platform `trace:agent` can verify. A
failed full-stack run should be debuggable by copying IDs from one repo's JSON
output into the other repo's diagnostic command.

## Ten Improvement Ideas

### 1. `pnpm run agent:send-message`

Add a CLI command that posts a user message to an agent through the platform API
and then watches the observable surfaces that should change.

Suggested command:

```bash
pnpm run agent:send-message -- \
  --agent-id <agent-id> \
  --workspace-id <workspace-id> \
  --message "Say pong and use no tools"
```

End-to-end checks:

- Call agent diagnostics first and fail early if `canChat` is false.
- POST to the same message endpoint the app uses.
- Poll `GET /api/agents/:id/messages` until the message is visible.
- Poll health/runtime state for a turn start, completion, or deterministic
  blocker.
- Print log correlation fields from `logs:summary` when available.

Acceptance:

- Returns non-zero when the message write fails, runtime is unreachable, or the
  agent reports a blocker.
- Supports `--json` with request id, message id, agent id, workspace id, and
  final status.
- Prints the matching runtime follow-up command, such as
  `pnpm run smoke:gateway -- --agent-id ... --workspace-id ... --message ...`,
  when dispatch reaches the runtime boundary but does not complete.
- Never requires browser interaction.

### 2. `POST /api/dev/agents/:agentId/trigger-message`

Add an explicitly dev-scoped API endpoint that drives the same flow as the
frontend send-message path, but packages the response for smoke testing.

Why this differs from the raw message endpoint:

- It can require `NODE_ENV !== "production"` or an explicit dev flag.
- It can run preflight diagnostics, submit the message, wait for first
  observable runtime evidence, and return one compact result.
- It can be the stable target for CLI and Playwright smoke tests.

Suggested response fields:

- `agentId`, `workspaceId`, `messageId`, `requestId`
- `diagnosticBefore`, summarized
- `runtimeObservation`, summarized
- `messagesAfter`, summarized
- `logSummary`, summarized

Acceptance:

- Uses camelCase API fields.
- Shares service code with the normal message path where possible.
- Has route tests for success, auth failure, missing workspace, and
  diagnostic-blocked cases.

### 3. `POST /api/dev/tools/:toolSlug/invoke`

Add a dev-only tool invocation endpoint for proving that one tool can be
resolved, authorized, executed, logged, and surfaced without waiting for a model
to choose it.

Suggested request:

```json
{
  "agentId": "<agent-id>",
  "workspaceId": "<workspace-id>",
  "input": {
    "path": "package.json"
  }
}
```

End-to-end checks:

- Resolve the agent's execution profile and granted tools.
- Verify the target tool is actually granted to the agent.
- Execute through the same executor path the runtime/tool bridge uses.
- Persist or emit the same tool-call observation shape used by dashboards.

Acceptance:

- Refuses ungranted tools.
- Clearly distinguishes `tool_not_found`, `tool_not_granted`,
  `tool_input_invalid`, and `tool_execution_failed`.
- Does not bypass workspace/path safety checks for filesystem or shell tools.

### 4. Tool-Calling Loop Smoke

Add a smoke command that sends a prompt designed to force a harmless tool call,
then verifies the tool call and result are visible through the platform.

Suggested command:

```bash
pnpm run smoke:agent-tool-call -- \
  --agent-id <agent-id> \
  --workspace-id <workspace-id> \
  --tool shell.exec \
  --path package.json
```

End-to-end checks:

- Confirm `shell.exec` is assigned/granted before the run starts.
- Trigger a real agent message.
- Watch for assistant tool-call event, tool-result event, and final assistant
  message.
- Confirm `logs:summary --agent-id` includes the same tool call id or request
  id.

Acceptance:

- Fails when the model returns text without attempting the expected tool.
- Supports provider-neutral result matching, since different runners may phrase
  final text differently.
- Records artifacts under `.run-artifacts/agent-tool-call/<timestamp>/`.
- Implemented by `pnpm run smoke:agent-tool-call`, which preflights tool
  grants, sends through the authenticated gateway WebSocket path, polls the
  platform dashboard for tool-call evidence, and stores run artifacts.

### 5. Runtime Dispatch Dry-Run Plus Live-Run Pair

Split dispatch validation into two commands: a dry-run that shows what would be
sent to runtime, and a live-run that actually dispatches.

Suggested commands:

```bash
pnpm run agent:dispatch:dry-run -- --agent-id <agent-id> --workspace-id <workspace-id>
pnpm run agent:dispatch:live -- --agent-id <agent-id> --workspace-id <workspace-id>
```

End-to-end checks:

- Dry-run resolves execution profile, credentials metadata, tool definitions,
  runner kind, provider, model, and execution target without invoking runtime.
- Live-run calls launcher/runtime and confirms the runtime reports the same
  runner kind/provider/model/tool profile.

Acceptance:

- Dry-run is safe to run repeatedly.
- Live-run prints the runtime target and first observed runtime state.
- Differences between platform-resolved and runtime-reported configuration are
  shown as failures, not warnings.

### 6. Agent Scenario Fixtures

Create committed, non-secret JSON fixtures for common local testing scenarios
that the CLI can run by name.

Potential scenarios:

- `planning-agent-readonly`
- `coding-agent-filesystem-read`
- `coding-agent-apply-patch`
- `manager-agent-due-task`
- `local-runtime-openai-compatible`
- `missing-credential-blocker`

Suggested command:

```bash
pnpm run smoke:agent-scenario -- --scenario coding-agent-filesystem-read
```

Acceptance:

- Fixtures define expected preconditions, actions, and observable outcomes.
- Secret or environment-specific values are supplied by flags or env, not
  committed.
- Fixture metadata is compatible with runtime scenario fixtures so a platform
  scenario can hand off to `agent:message`, `agent:tool-smoke`, or
  `smoke:manager-dispatch` in the runtime repo using the same agent/run IDs.
- Each scenario can run in `--check-only` mode to report missing setup before
  doing writes.

### 7. Cross-Layer Trace Verifier

Add a command that starts from one `requestId`, `messageId`, `toolCallId`, or
`agentId` and verifies that every expected layer emitted evidence.

Suggested command:

```bash
pnpm run trace:agent -- --agent-id <agent-id> --since 10m
```

End-to-end checks:

- API request log exists.
- Launcher/runtime proxy log exists.
- Runtime `snapshot:runtime` or `logs:runtime` can find the same run when a
  runtime run id is present.
- Websocket or dashboard event exists when applicable.
- Message/tool-call row exists when applicable.
- Browser smoke artifact exists when the run used Playwright.

Acceptance:

- Outputs a compact pass/fail table by layer.
- Supports `--json` for agents.
- Uses existing structured logs when present and produces useful gaps when
  fields are missing.

### 8. Browser-Backed CLI Smoke

Add a Playwright smoke that exercises the actual UI but is launched and
interpreted from the CLI.

Suggested command:

```bash
pnpm run smoke:agent-browser -- --agent-id <agent-id> --workspace-id <workspace-id>
```

End-to-end checks:

- Open the app, use the dev credentials button if needed, and land on the
  selected agent.
- Send a test message from the UI.
- Verify message rendering, runtime status, and absence of console errors.
- Export screenshots, console logs, and network summaries.

Acceptance:

- Does not hardcode credentials.
- Fails on auth redirect loops, visible error boundaries, uncaught console
  errors, or missing message updates.
- Saves artifacts under `.run-artifacts/browser-agent/<timestamp>/`.

### 9. Agent State Reset and Seed Helpers

Add safe local helpers for creating or resetting disposable test agents so
end-to-end runs do not depend on a stale manually-created database row.

Suggested commands:

```bash
pnpm run agent:test-seed -- --workspace-id <workspace-id> --kind coding
pnpm run agent:test-reset -- --agent-id <agent-id> --workspace-id <workspace-id>
```

Acceptance:

- Commands are clearly local/dev scoped.
- Reset can clear test messages, tool-call records, runtime session state, and
  grants only for agents marked as disposable/test-owned.
- The seed command prints the resulting `agentId`, `workspaceId`, runner kind,
  provider, model, and granted tools.
- Destructive operations require an explicit `--yes` flag.

### 10. Contract-Level Unit Tests for Probe Stability

Add focused unit tests around the pieces that make the end-to-end probes
trustworthy.

Good unit test targets:

- Diagnostic blocker classification.
- Tool invocation error mapping.
- Log summary grouping by agent/request/tool call.
- Scenario fixture validation.
- Redaction for support artifacts.
- Dry-run dispatch payload construction.

Acceptance:

- Unit tests do not replace live smoke tests.
- Tests use shared Zod contracts for API request/response shapes.
- Error-code assertions are specific enough for CLI commands to make clear
  next-step recommendations.

## Suggested PR Order

1. Add scenario fixture schema, shared probe helpers, and contract-level tests.
2. Add `agent:send-message` and trace verifier using existing endpoints.
3. Add dev-only trigger-message endpoint if the CLI needs an atomic API-level
   smoke target after the raw message flow is proven.
4. Add dev-only tool invocation endpoint and tool-calling loop smoke.
5. Add browser-backed smoke and support artifact export.
6. Add seed/reset helpers once the desired disposable-agent marker is agreed.

Cross-repo sequencing with the runtime scope:

1. Land compatible JSON output fields first: `agentId`, `workspaceId`,
   `requestId`, `messageId`, `runId`, and `toolCallId`.
2. Make platform `agent:send-message` and runtime `agent:message` accept each
   other's IDs so either repo can continue a failed investigation.
3. Align scenario fixture names before adding a large fixture library.
4. Keep dev-only tool execution endpoints separate by ownership: platform
   proves grants/configuration, runtime proves execution.
5. Add a final full-stack scenario only after both repos have stable targeted
   smokes; otherwise the combined smoke will be too noisy to debug.

## Manual Pass Criteria

A local run is considered meaningfully end to end when one command can prove:

1. API, web, launcher, and orchestrator are reachable.
2. The selected agent's diagnostic has `canChat: true`.
3. A user message can be submitted through the platform API or UI.
4. Runtime dispatch starts for that message.
5. At least one message, tool call, or deterministic blocker is observable
   through platform APIs.
6. Logs can be correlated back to the same agent/run.

## Open Questions

- Should dev-only endpoints be compiled into production builds but guarded by
  config, or registered only in local/dev mode?
- What is the canonical disposable-agent marker for reset helpers?
- Which tool should be the default harmless end-to-end tool: `shell.exec` or a
  purpose-built diagnostic tool?
- Should smoke commands write message/tool-call rows in the real Supabase
  project, or should local development use a dedicated test workspace by
  convention?
