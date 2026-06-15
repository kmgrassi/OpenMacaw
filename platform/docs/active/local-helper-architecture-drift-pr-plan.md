# Local Helper Architecture Drift - Remaining Platform PR Plan

Repo: `parallel-agent-platform`.

This plan only covers platform work that is not implemented yet. The platform
already has local runtime machine registration, `local_model_coding` contracts,
runtime dispatch plumbing, local coding execution target checks, and UI for
registered local runtime helpers. The remaining drift is the old direct
`/local-chat` path and its `localhost:17654` HTTP helper default.

## Implemented Baseline

- Coding agents with local provider can resolve to `runner_kind =
local_model_coding`.
- Platform can register and list local runtime helper machines.
- Runtime dispatch tests cover `local_model_coding`.
- Local coding tools require a local runtime helper execution target.
- The Go helper architecture is relay-based, not an inbound HTTP daemon.

## Remaining Problem

The platform still contains a legacy direct-local-chat concept:

- `/api/agents/:agentId/local-chat` proxies directly to an OpenAI-compatible
  endpoint such as Ollama.
- `apps/api/src/config.ts` defaults `LOCAL_TOOL_HELPER_URL` /
  `HELPER_DAEMON_URL` to `http://localhost:17654`.
- `executeToolCall` can still fall back to posting unsupported tools to
  `${toolHelperBaseUrl}/tools/execute`.
- `LocalModelChat` still uses `/local-chat`, including for agent profiles that
  can be `local_model_coding`.

That path is useful as a dev-only direct model harness, but it is not the
Coding Agent local model tool path. Restarting the Go helper will not make a
daemon appear on `17654`.

## PR1 - Quarantine legacy HTTP helper config

**Branch:** `codex/quarantine-legacy-local-chat-helper`

**Goal:** Make the `17654` helper URL explicitly legacy/dev-only and prevent it
from being interpreted as the Go local-runtime-helper endpoint.

**Files:**

| File                                             | Remaining change                                                                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/config.ts`                         | Rename or document `toolHelperBaseUrl` as `legacyLocalChatToolHelperBaseUrl`, or add equivalent metadata/comments that scope it to direct `/local-chat` only.           |
| `apps/api/src/config.test.ts`                    | Update tests so the `17654` default is asserted as legacy compatibility, not as a current Local Helper endpoint.                                                        |
| `apps/api/src/services/tool-execution-client.ts` | Add comments/type names that make the HTTP fallback legacy-only. If possible, require callers to opt into the legacy HTTP helper instead of silently using the default. |

**Acceptance criteria:**

- `LOCAL_TOOL_HELPER_URL` and `HELPER_DAEMON_URL` remain available only for
  direct `/local-chat` development compatibility.
- No config field name or test description suggests that `17654` is the Go
  helper.
- The compatibility default is intentional and documented.

## PR2 - Stop direct /local-chat from executing local_model_coding tools

**Branch:** `codex/guard-legacy-local-chat-tools`

**Goal:** Keep `/local-chat` as a direct model harness while preventing it from
pretending to be the runtime relay Coding Agent path.

**Files:**

| File                                                   | Remaining change                                                                                                                                                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/routes/local-model-proxy.ts`             | If the resolved profile is `local_model_coding` and tools are requested, return a clear error directing the caller to runtime dispatch. Allow no-tool direct chat only if still needed as a dev harness. |
| `apps/api/src/services/local-chat-agent-tools.ts`      | Filter or reject tools whose `runnerKind` is `local_model_coding` for direct `/local-chat`, unless an explicit legacy HTTP helper mode is enabled.                                                       |
| `apps/api/src/services/local-chat-agent-tools.test.ts` | Add coverage that local coding tools are not returned for direct local-chat execution.                                                                                                                   |
| `apps/api/src/routes/local-model-proxy.test.ts`        | Add coverage for the local coding plus tools guard and the no-tool direct harness path.                                                                                                                  |

**Acceptance criteria:**

- `/local-chat` cannot execute `shell.exec`, `apply_patch`, or other
  `local_model_coding` tools through the legacy HTTP helper fallback.
- The error says Coding Agent local model tools run through runtime relay and
  registered local-runtime-helper.
- Direct local model chat without tools remains available only as a dev harness.

## PR3 - Move Coding Agent local model UI away from /local-chat

**Branch:** `codex/coding-agent-runtime-relay-ui`

**Goal:** Ensure the normal Coding Agent local model test/workflow in the UI
uses runtime dispatch once runtime `local_model_coding` relay routing is ready.

**Files:**

| File                                                              | Remaining change                                                                                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/components/dashboard/LocalModelChat.tsx`            | Hide or relabel this component as a direct model harness for local non-tool chat. Do not present it as the Coding Agent tool execution path.                             |
| `apps/web/src/routes/Dashboard.tsx`                               | Route `local_model_coding` agents to the runtime-backed interaction path instead of `LocalModelChat`, or show a clear disabled/coming-soon state until runtime PR lands. |
| `apps/api/src/routes/proxy-runtime-dispatch.ts`                   | Verify no missing API affordance blocks the UI from dispatching `local_model_coding` work through runtime.                                                               |
| `apps/web/src/components/settings/LocalModelCodingSmokePanel.tsx` | Ensure smoke/test labels say runtime relay helper, not direct local-chat helper.                                                                                         |

**Acceptance criteria:**

- The user-facing Coding Agent local model path dispatches through runtime with
  `runnerKind: "local_model_coding"` after the runtime relay PR is available.
- `/local-chat` is visually and textually scoped to direct dev harness use.
- No Coding Agent setup path references port `17654`.

## PR4 - Docs and diagnostics cleanup for the remaining stale references

**Branch:** `codex/local-helper-docs-diagnostics-cleanup`

**Goal:** Align platform docs and diagnostics with the two concepts:
legacy direct-local-chat HTTP helper versus Go relay helper.

**Files:**

| File                                                                                                               | Remaining change                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/active/universal-tool-calling-plan.md`                                                                       | Mark direct local-chat HTTP helper execution as legacy/dev-only and not the Coding Agent path.                                                     |
| `apps/api/src/routes/agent-diagnostic.ts`                                                                          | Confirm local coding diagnostics report registered relay helper state separately from local model endpoint state. Update wording only where stale. |
| `apps/api/src/routes/agent-diagnostic.test.ts`                                                                     | Assert local coding diagnostic output does not mention `17654`.                                                                                    |
| `apps/web/src/components/settings/AgentDetail.tsx` and `apps/web/src/components/settings/LocalRuntimesSection.tsx` | Tighten any ambiguous "Local Helper" copy so it means registered relay helper.                                                                     |

**Acceptance criteria:**

- `rg "17654|LOCAL_TOOL_HELPER_URL|HELPER_DAEMON_URL" apps/web docs scripts`
  returns only explicit legacy direct-local-chat references.
- Diagnostics distinguish missing registered relay helper from unavailable local
  model endpoint.
- Docs do not recommend restarting the Go helper to fix the legacy HTTP helper
  port.

## Cross-Repo Sequencing

1. Platform PR1 and PR2 can land immediately; they clarify and guard the
   legacy path.
2. Runtime must route `local_model_coding` through the relay helper before
   Platform PR3 can fully switch the normal UI workflow.
3. Platform PR4 can land in parallel with helper documentation cleanup.

## Non-Goals

- Do not remove `/local-chat` entirely in this sequence.
- Do not add a compatibility HTTP server to the Go helper.
- Do not make the platform call Ollama directly for Coding Agent tool loops.
