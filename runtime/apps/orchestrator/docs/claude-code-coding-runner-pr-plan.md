# Claude Code Coding Runner PR Plan

This document scopes the cross-repo work needed to let coding agents switch
between OpenAI Codex and Anthropic Claude Code / Claude Agent SDK.

The goal is:

```text
coding work item
  -> resolved execution profile
  -> runner_kind: codex | claude_code
  -> provider-specific coding runner
  -> normalized runtime events and broker logs
```

Codex remains the default coding backend. Claude Code is added as another
coding runner behind the same `SymphonyElixir.Runner` behavior and execution
profile resolver.

## External Interface Notes

Anthropic's current programmatic interface is the Claude Agent SDK. The docs
describe it as the same agent loop, tools, and context management that power
Claude Code, exposed through TypeScript and Python.

Key facts this plan relies on:

- TypeScript install: `npm install @anthropic-ai/claude-agent-sdk`.
- Python install: `pip install claude-agent-sdk`.
- TypeScript SDK bundles a native Claude Code binary, so a separate global
  `claude` install is not required for SDK-based execution.
- Authentication for product integrations should use `ANTHROPIC_API_KEY`, or
  provider-specific env such as Bedrock / Vertex / Azure flags, not a
  forwarded claude.ai user login.
- Claude Code CLI can be used for prototyping with:

  ```bash
  claude -p --output-format stream-json --model sonnet "fix this bug"
  ```

- SDK streaming input mode is the better production fit because it supports a
  long-lived session, real-time events, permissions, hooks, MCP, and
  interruption semantics.

References:

- `https://code.claude.com/docs/en/agent-sdk/overview`
- `https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode`
- `https://code.claude.com/docs/en/agent-sdk/permissions`
- `https://code.claude.com/docs/en/cli-reference`

## Current Runtime State

Useful existing runtime pieces:

- `SymphonyElixir.ExecutionProfile` already resolves coding work items into
  `runner_kind`, `provider`, `model`, `credential_ref`, `tool_profile`, and
  `adapter_config`.
- `SymphonyElixir.AgentRunner` is already runner-agnostic. It calls
  `start_session/2`, `run_turn/3`, and `stop_session/1`.
- `SymphonyElixir.Runner.Codex` is a narrow adapter around
  `SymphonyElixir.Codex.AppServer`.
- Broker logging, token accumulation, workspace creation, before/after hooks,
  retry handling, and normalized runtime logs already sit above the runner
  boundary.
- The platform already displays runtime stream events that are currently named
  Codex-oriented but can be fed by normalized runner events.

Missing pieces:

- `runner_kind: claude_code` is not allowed or mapped to a runner module.
- No Claude Code runner exists.
- No SDK bridge process exists for Elixir to call.
- No normalized event mapper exists from Claude SDK messages to our runtime
  event shape.
- No platform setup/UI path exists for choosing Claude Code as the coding
  backend.
- No smoke harness proves a planning-created work item can be executed by
  Claude Code.

## Target Architecture

```text
Platform
  resolves execution profile
  runner_kind: claude_code
  provider: anthropic
  model: sonnet | claude-sonnet-...
  credential_ref: ...
        |
        v
Runtime AgentRunner
  creates workspace/worktree
  starts Runner.ClaudeCode
        |
        v
Node SDK Bridge
  imports @anthropic-ai/claude-agent-sdk
  calls query({ prompt, options })
  streams SDK messages over JSON lines
        |
        v
Runtime Event Mapper
  assistant deltas
  tool start/end/failure
  usage/cost
  turn completion/failure
        |
        v
Broker logs + dashboard gateway
```

## Execution Profile Shape

Example profile:

```json
{
  "role": "coding",
  "runner_kind": "claude_code",
  "provider": "anthropic",
  "model": "sonnet",
  "credential_ref": "credential_alias:anthropic/default",
  "tool_profile": "coding",
  "capabilities": {
    "workspace_write": true,
    "shell": true
  },
  "adapter_config": {
    "permission_mode": "acceptEdits",
    "tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    "allowed_tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    "max_turns": 20
  }
}
```

Important permission rule: Claude `allowedTools` pre-approves tools; it does
not remove unlisted tools from context. To restrict available built-in tools,
set `tools`. To deny calls regardless of mode, set `disallowedTools`. For a
locked-down profile, pair explicit tools with `permissionMode: "dontAsk"`.

## PR Sequence

The numbers below are the planned PR sequence. GitHub PR numbers will differ
after each PR is opened.

| PR # | Repository | Title | Depends on | Migration? | Scope | Acceptance |
|---:|---|---|---|---|---|---|
| 0 | `parallel-agent-runtime` | Scope Claude Code coding runner | None | No | This document. | Reviewers agree on repo ownership, sequence, runner contract, and smoke criteria. |
| 1 | `parallel-agent-runtime` | Add `claude_code` execution profile support | PR 0 | No | Add `claude_code` to supported runner kinds, provider logging, runner resolution, config docs, and tests proving routing from work item metadata / agent config. | `ExecutionProfile.resolve_coding/3` accepts `runner_kind: claude_code`; `AgentRunner` resolves `Runner.ClaudeCode`; existing Codex defaults are unchanged. |
| 2 | `parallel-agent-runtime` | Add Claude Agent SDK bridge package and protocol | PR 1 | No | Add Node bridge under runtime-owned scripts/priv, add `@anthropic-ai/claude-agent-sdk`, define JSON-lines protocol for session start, turn start, SDK message stream, errors, and stop. | Bridge can run a one-shot mocked query in tests and reports deterministic JSON events; no secret values are logged. |
| 3 | `parallel-agent-runtime` | Implement `Runner.ClaudeCode` | PR 2 | No | Add Elixir runner that validates workspace, starts the Node bridge locally or through existing worker host SSH path, passes model/permission/tool config, and implements `start_session/2`, `run_turn/3`, `stop_session/1`, and `ping/1`. | Fake bridge tests prove session lifecycle, turn success, startup failure, turn failure, cancellation/stop, and workspace cwd enforcement. |
| 4 | `parallel-agent-runtime` | Normalize Claude SDK events into runtime events | PR 3 | No | Map SDK messages into assistant deltas, tool started/completed/failed, usage updates, turn completed/failed, approval/input-required, and broker token snapshots. | Dashboard/gateway tests can consume Claude runner events without a provider-specific UI path; token accounting is best-effort and never crashes on missing usage. |
| 5 | `parallel-agent-runtime` | Claude Code live smoke harness | PR 4 | No | Add opt-in live smoke using `ANTHROPIC_API_KEY` that creates a disposable workspace, asks Claude to edit a small file, runs a test command, and verifies diff/final result. | `mix test` excludes live smoke by default; `SYMPHONY_RUN_CLAUDE_CODE_SMOKE=1` proves end-to-end workspace mutation on a developer machine or CI secret environment. |
| 6 | `parallel-agent-platform` | Expose Claude Code as a coding execution backend | Runtime PR 1 contract | Maybe | Update setup builders, agent/profile forms, API validation, diagnostics, and seed/default config so a coding agent can choose `runner_kind: claude_code`, provider `anthropic`, and model aliases. | Platform can create/update a coding agent with Claude Code profile and send runtime launch config without falling back to Codex. Existing Codex agents remain unchanged. |
| 7 | `parallel-agent-platform` | Add Claude Code diagnostics and smoke UI affordances | PR 6, Runtime PR 4 | No | Show resolved runner/provider/model, credential readiness, SDK/CLI availability, and permission-mode/tool-profile details in diagnostics. Add smoke instructions or UI copy for Claude Code backend. | Diagnostic endpoint clearly distinguishes missing credential, unsupported runner, missing bridge dependency, and runtime startup errors. |
| 8 | `harper-server` | Persist Claude Code runner config, if schema constraints require it | Runtime PR 1, Platform PR 6 | Conditional | Only needed if DB constraints/enums/checks currently reject `runner_kind: claude_code`, provider `anthropic`, or Claude model names. Add migrations and seed data if required. | DB accepts Claude Code execution profile values; generated runtime/platform schema artifacts are synced after migration. |
| 9 | `parallel-agent-runtime` | Sync DB schema artifacts after Harper migration | PR 8 | No | Run schema sync and update generated PostgREST/TypeScript artifacts if PR 8 changes database schema. | Runtime generated schema matches deployed DB; no startup/schema bridge regressions. |
| 10 | `parallel-agent-platform` | Sync platform DB types after Harper migration | PR 8 | No | Regenerate platform Supabase/database types if PR 8 changes schema. | Type checks pass with new runner/provider values and no local compatibility aliases. |
| 11 | `local-runtime-helper` | No-op for initial Claude Code SDK runner | Runtime PR 5 | No | No change expected for the initial SDK bridge because runtime owns the Node bridge directly. Revisit only if we want Claude execution delegated through the local relay/helper daemon. | Decision recorded: helper remains out of the first implementation path. |

## Runtime Runner Contract

`Runner.ClaudeCode` should behave like a normal coding runner:

- `requires_workspace?/0` returns `true`.
- `ping/1` verifies Node bridge availability and Anthropic credential
  readiness without leaking the key.
- `start_session/2` starts bridge state, not a full task.
- `run_turn/3` sends one prompt and waits for a normalized completion/failure.
- `stop_session/1` terminates the bridge process.
- Errors must be classified as retryable/fatal where possible.

The runner should not special-case planning agents or manager agents. It is a
coding runner selected by execution profile.

## Bridge Protocol Sketch

Runtime -> bridge:

```json
{"id":"1","method":"session/start","params":{"cwd":"/workspace","model":"sonnet","permissionMode":"acceptEdits","tools":["Read","Edit","Write","Bash","Glob","Grep"]}}
{"id":"2","method":"turn/start","params":{"prompt":"...","workItem":{"id":"...","title":"..."}}}
{"id":"3","method":"session/stop","params":{}}
```

Bridge -> runtime:

```json
{"id":"1","result":{"sessionId":"..."}}
{"method":"message/delta","params":{"textDelta":"..."}}
{"method":"tool/started","params":{"tool":"Bash","toolUseId":"...","input":{}}}
{"method":"tool/completed","params":{"tool":"Bash","toolUseId":"...","output":{}}}
{"method":"usage/updated","params":{"inputTokens":1,"outputTokens":2,"totalTokens":3}}
{"method":"turn/completed","params":{"result":"...","sessionId":"..."}}
{"method":"turn/failed","params":{"reason":"...","retryable":false}}
```

Keep the bridge protocol provider-specific internally but runtime-normalized at
the runner boundary. The platform should not consume Claude SDK message shapes
directly.

## Security Requirements

- Use API-key or provider credential refs resolved by runtime. Do not persist
  secret values in execution profiles, workflow files, logs, or bridge events.
- Default `disallowedTools` should block `.env`, `.env.*`, and `secrets/**`.
- Do not use `bypassPermissions` for shared/local developer runs unless the
  workspace is isolated and the profile explicitly opts in.
- Prefer `permissionMode: "acceptEdits"` for normal coding work and
  `permissionMode: "dontAsk"` plus explicit `tools` for locked-down modes.
- Preserve existing workspace root and symlink/path safety checks before
  launching the bridge.
- If remote worker execution is used, launch the bridge on the worker host with
  the same workspace cwd that Codex would receive.

## Testing Strategy

Unit tests:

- execution profile allowlist accepts `claude_code`;
- unsupported runner values still fail;
- runner config maps `adapter_config` into bridge options;
- bridge stdout JSON parsing handles partial lines, non-JSON stderr, and exit
  statuses;
- event mapper handles assistant text, tool use, tool result, usage, success,
  failure, and unknown message types.

Integration tests with fake bridge:

- start session -> run turn -> stop session;
- turn failure produces typed runtime failure;
- startup failure is surfaced through launch diagnostics;
- token accumulator records usage deltas from Claude events;
- broker logs are written with runner/provider/model metadata.

Live smoke:

- requires `ANTHROPIC_API_KEY`;
- creates a disposable workspace;
- asks Claude Code to modify one file;
- verifies the file changed;
- asks Claude to run a harmless test command;
- verifies final response and normalized runtime events.

Browser smoke after platform PRs:

- create or select a coding agent with `runner_kind: claude_code`;
- create a plan and work item from the Planning Agent;
- dispatch the work item to the Claude Code coding agent;
- verify the dashboard shows runner `claude_code`, provider `anthropic`, and
  streamed assistant/tool events;
- verify the resulting workspace diff exists and broker run status completes.

## Open Questions

- Should the first Claude runner require the TypeScript SDK bridge, or should
  we also support a raw CLI bridge for developers who already have `claude`
  installed?
- Should platform expose model aliases such as `sonnet` and `opus`, or only
  full model names?
- Should Claude Code subagents be disabled initially by omitting the `Agent`
  tool, or allowed only through explicit profile capability flags?
- Should `permissionMode: "auto"` be allowed in production profiles before we
  have enough observability for model-classified approvals?
- Should bridge dependencies live in the runtime root package or under a
  dedicated `apps/orchestrator/priv/claude_agent_bridge/package.json`?

## Suggested First Review Slice

Start with PR 1 and PR 2 in runtime. They establish the stable contract without
touching platform UI or database migrations:

1. `runner_kind: claude_code` is a recognized coding backend.
2. The bridge protocol is testable without live Anthropic calls.
3. Later PRs can focus on runner behavior and UI wiring independently.
