# Claude Code Platform PR Plan

This document scopes only the `parallel-agent-platform` work required to make
Claude Code / Claude Agent SDK selectable as a coding backend alongside OpenAI
Codex.

The companion runtime scope lives in `parallel-agent-runtime` PR 181 and owns
the SDK bridge, `Runner.ClaudeCode`, event mapping, and live runtime smoke
harness.

## Goal

Allow users and setup flows to configure a coding agent whose resolved
execution profile uses:

```json
{
  "role": "coding",
  "runnerKind": "claude_code",
  "provider": "anthropic",
  "model": "sonnet",
  "credentialRef": "credential_alias:anthropic/default",
  "toolProfile": "coding"
}
```

Platform owns product configuration, validation, diagnostics, credential
readiness, and browser/API smoke coverage. Runtime owns execution.

## Runtime Dependencies

Platform implementation should wait for, or feature-flag behind, the runtime
contract from these planned runtime PRs:

| Runtime PR | Repository | Contract platform depends on |
|---:|---|---|
| 1 | `parallel-agent-runtime` | `runner_kind: claude_code` is accepted by runtime execution profiles and resolves to a runner module. |
| 3 | `parallel-agent-runtime` | Runtime can launch a Claude Code runner from a workspace-backed coding run. |
| 4 | `parallel-agent-runtime` | Runtime emits normalized events for Claude runner turns, tool calls, failures, and usage. |
| 5 | `parallel-agent-runtime` | Runtime has an opt-in live smoke harness proving a Claude Code coding run mutates a disposable workspace. |

The platform should not consume Claude SDK message shapes directly. It should
continue to consume normalized runtime events through the existing launcher /
gateway paths.

## Current Platform State

Useful existing pieces:

- `docs/execution-profile-contract.md` already separates role, runner,
  provider, model, credential reference, tool profile, and capabilities.
- Setup builder code already creates default agents and execution profile-like
  runtime configuration.
- The API already proxies launcher/runtime diagnostics.
- The web app already displays agent runtime status and chat/session events.
- Credential readiness patterns exist for provider-backed launches.

Missing platform pieces:

- Contract allowlists and validation likely do not include `claude_code`.
- Setup builders do not offer or seed a Claude Code coding backend.
- UI copy and diagnostics do not distinguish Claude Code SDK bridge failures
  from generic runtime startup failures.
- Browser smoke does not cover planning agent -> work item -> Claude Code
  coding agent dispatch.
- Database constraints/types may reject `runnerKind = claude_code` or
  provider/model values, depending on the current schema.

## Platform PR Sequence

The numbers below are platform-local planned PR numbers. GitHub PR numbers will
differ after each PR is opened.

| PR # | Repository | Title | Depends on | Migration? | Scope | Acceptance |
|---:|---|---|---|---|---|---|
| P0 | `parallel-agent-platform` | Scope Claude Code platform support | Runtime PR 0 / 181 | No | This document, linked from the platform docs index. | Reviewers agree on platform/runtime boundary, DB migration decision points, diagnostics, and browser smoke criteria. |
| P1 | `parallel-agent-platform` | Add Claude Code execution profile contract support | Runtime PR 1 | Maybe | Add `claude_code` to platform contract allowlists, setup/API validation, provider validation, and any generated/static runner-kind lists. Preserve Codex defaults. | API tests prove a coding agent/profile can carry `runnerKind: claude_code`, provider `anthropic`, and model alias/full model without being normalized back to Codex. |
| P2 | `parallel-agent-platform` | Seed/setup Claude Code coding backend option | P1 | No, unless seed data is DB-backed | Update setup builders, default/onboarding flows, and admin configuration so a Claude Code coding backend can be selected when an Anthropic credential is available. | Creating or updating a coding agent can choose Claude Code; generated runtime launch config includes `runner_kind: claude_code`, `provider: anthropic`, model, credential ref, and tool profile. |
| P3 | `parallel-agent-platform` | Add Claude Code diagnostics | P1, Runtime PR 3 | No | Extend diagnostic responses/UI to show runner `claude_code`, provider `anthropic`, model, credential readiness, runtime bridge availability when reported, and permission/tool-profile configuration. | Diagnostic endpoint clearly distinguishes missing Anthropic credential, unsupported runtime runner, runtime bridge startup failure, and normal ready state. |
| P4 | `parallel-agent-platform` | Display normalized Claude runner events | P3, Runtime PR 4 | No | Ensure web/API event handling labels Claude Code runs correctly while continuing to use normalized event shapes. Remove Codex-specific assumptions from visible text where the event source may be non-Codex. | Browser can show Claude Code assistant deltas, tool start/completion/failure, turn completion/failure, and usage without provider-specific parsing. Existing Codex event display still works. |
| P5 | `parallel-agent-platform` | Browser smoke for Claude Code coding dispatch | P2, P4, Runtime PR 5 | No | Add manual or automated smoke documentation/tests for creating a plan and work item, dispatching to a Claude Code coding agent, and verifying run completion/diff/logs. | Browser smoke proves Planning Agent can create a work item and Platform can route/launch it through a Claude Code coding agent with visible normalized events. |
| P6 | `harper-server` | Persist Claude Code runner values, if needed | P1 discovery | Conditional | Only required if DB constraints/enums reject `runnerKind: claude_code`, provider `anthropic`, or Claude model names. | DB accepts the new values and generated platform/runtime schema artifacts are synced in follow-up PRs. |
| P7 | `parallel-agent-platform` | Sync platform database types after Harper migration | P6 | No | Regenerate Supabase/database types if P6 changes schema. | Type checks pass with the new runner/provider values and no compatibility aliases. |

## Validation And Contract Details

### Execution Profile

Platform should pass snake_case to Runtime where the runtime contract expects
it, while preserving existing camelCase in browser/API DTOs if that is already
the platform convention.

Runtime-facing shape:

```json
{
  "role": "coding",
  "runner_kind": "claude_code",
  "provider": "anthropic",
  "model": "sonnet",
  "credential_ref": "credential_alias:anthropic/default",
  "tool_profile": "coding",
  "adapter_config": {
    "permission_mode": "acceptEdits",
    "tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    "allowed_tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
  }
}
```

### Credentials

Platform should validate that an Anthropic credential reference exists before
presenting the backend as launch-ready. It must not send secret material to the
browser or embed it in persisted execution profiles.

Supported provider options for this platform slice:

- `anthropic` with `ANTHROPIC_API_KEY`-backed runtime credential resolution.

Out of scope for this first platform slice:

- claude.ai login forwarding;
- user subscription/rate-limit reuse;
- Bedrock / Vertex / Azure Claude routing, unless already supported by the
  credential system through generic adapter config.

### Tool And Permission UI

Do not expose Claude `bypassPermissions` as the default. Suggested initial
platform presets:

| Preset | Runtime adapter config |
|---|---|
| Standard coding | `permission_mode: "acceptEdits"` plus `tools` for `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep` |
| Locked down | `permission_mode: "dontAsk"` plus explicit `tools` / `allowed_tools` |
| Planning only | not a coding backend; keep this as a planning runner/tool policy concern |

Important Claude behavior: `allowedTools` auto-approves matching tools but does
not remove unlisted tools from Claude's context. Use `tools` to restrict
available built-ins.

## Browser Smoke

Manual smoke after P5:

1. Start platform and runtime from branches containing the Claude Code support.
2. Log into `http://127.0.0.1:5173`.
3. Create or select a coding agent configured with:
   - runner: `claude_code`
   - provider: `anthropic`
   - model: `sonnet` or a configured Claude model
   - valid Anthropic credential ref
4. Use the Planning Agent to create a plan and one work item.
5. Dispatch the work item to the Claude Code coding agent.
6. Confirm the runtime dashboard shows:
   - runner `claude_code`
   - provider `anthropic`
   - streamed assistant/tool events
   - completed broker run
7. Confirm the workspace has the expected diff or command output from the
   coding run.

The platform-side deterministic fixture and live manual checklist are tracked in
[`docs/claude-code-browser-smoke.md`](./claude-code-browser-smoke.md). The
fixture is exposed in the browser under Settings -> Agents -> Claude Code
Dispatch Smoke and through `/api/smoke/claude-code-dispatch`.

## Open Questions For Platform Review

- Should the platform expose `sonnet` / `opus` aliases or require full Claude
  model names?
- Should setup create a separate "Claude Code Coding Agent" or let users switch
  the existing Coding Agent backend?
- Should diagnostics check only credential/routing readiness, or also ask
  Runtime for SDK bridge availability before showing "ready"?
- If DB constraints currently reject `claude_code`, should that migration be
  grouped with platform contract support or handled first in `harper-server`?
- Should the web UI rename Codex-specific labels to "Runtime events" before or
  during Claude Code support?

## Suggested First Platform Slice

Start with P1. It should be small and reviewable:

1. Add `claude_code` to contract/validation allowlists.
2. Add provider/model validation for Anthropic coding profiles.
3. Prove the platform can produce the runtime-facing profile without changing
   any default agents or UI.

P2 can then wire it into setup/onboarding once the contract is stable.
