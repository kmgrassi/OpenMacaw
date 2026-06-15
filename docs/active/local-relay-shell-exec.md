# Local-relay agents run shell.exec on the helper

Follow-up to #164. The production tool-quality battery scored 6/8 once the
local model was handed its granted tools; the remaining real gap was
`shell.exec`, which #164 deliberately **excluded** because it requires the
user's `workspace_root` and the helper executor only ran `git.run`. This adds
helper execution for `shell.exec` so a local-model agent can run CLI commands
on the user's machine.

## Changes

1. **Helper** (`internal/tools/local_executor.go`): `gitRun`'s exec body is
   extracted into a shared `runCommand`, and a new `shell.exec` case runs the
   model's `argv` through it. `shell.exec` applies **no command allowlist**
   (it's a general CLI tool, unlike `git.run`) but shares the same
   workspace-root cwd confinement, timeout, and output caps. The orchestrator's
   `sandbox_policy` is **not** enforced on the helper: it runs as the user on
   the user's own machine, which is the intent of a local-model agent.

2. **Runtime** (`gateway/chat_runner.ex`): `shell.exec` moves from
   `@local_relay_unsupported_tools` to `@local_helper_cli_tools`, so it is
   offered to local-relay agents and marked `execution_kind: helper` (delegated
   to the helper) instead of being omitted. `apply_patch` stays excluded (its
   structured-patch format still needs a helper implementation — the remaining
   follow-up).

## Verification

- Helper: `go build/vet/test ./...` green; new tests assert `shell.exec` runs
  `argv` in the workspace and that a cwd outside the workspace root is rejected.
- Runtime: `mix compile --warnings-as-errors` clean. Live prod check: the eval
  agent now resolves to 10 tools, with `shell.exec` offered and marked
  `helper`, `apply_patch` still omitted.
- After deploy: re-run `eval:local-tool-calling --run` — `shell-echo-safe`
  should now pass (the model can call `shell.exec` and the helper runs it).
