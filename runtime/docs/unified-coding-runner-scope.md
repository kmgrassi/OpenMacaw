# Unified coding-runner abstraction + tool visibility — scoping

> **Status:** Proposed. Captures a direction prompted by comparing OpenMacaw's
> coding-agent integration to the Omnigent project's "meta-harness." Goal: one
> shared abstraction for coding runners (Claude Code, Codex, future vendors),
> expose OpenMacaw tools to Claude Code, and make every coding run's tool
> activity **visible and locally testable** ("what is Claude Code / Codex doing
> right now?").
>
> Related: cross-subsystem credential/governance discussion in
> [`platform/docs/active/secretless-credential-proxy-scope.md`](../../platform/docs/active/secretless-credential-proxy-scope.md).

## Why

Today our two coding-agent integrations are **bespoke and inconsistent**, and
one of them is opaque:

- **Claude Code** (`apps/orchestrator/priv/claude_agent_bridge/bridge.js`) calls
  the high-level `query()` from `@anthropic-ai/claude-agent-sdk` and streams
  text back. It passes `permissionMode` + `allowedTools`/`disallowedTools` but
  **does not** wire the SDK's `can_use_tool` permission callback or any
  `mcpServers`. Result: the SDK runs its own tools (`Bash`, `Edit`, …) inside
  its process; OpenMacaw **cannot see or gate individual tool calls**, and
  **cannot expose its own tools** (`git.run`, `scheduled_task.*`) to Claude Code.
- **Codex** (`apps/orchestrator/lib/symphony_elixir/codex/app_server.ex`) speaks
  JSON-RPC; Codex emits `dynamic/tool` and our `ToolRegistry` executes the tool
  under an allowlist. Here we *are* in the tool loop — different transport,
  different tool model, different governance from Claude Code.

So adding a coding agent is a fresh bespoke runner, governance differs per
vendor, and Claude Code activity is invisible. Omnigent instead wraps every
vendor in one `Executor` contract (maps native events → a common event stream;
routes the vendor's permission/tool surface through one policy+dispatch layer),
which is why it supports ~30 harnesses with uniform governance. We want that
shape for our (smaller) set.

## Goals

1. **A shared coding-runner contract** — a normalized event/tool stream and a
   `can_use_tool`-style gate that both Claude Code and Codex implement, so the
   streaming + governance code is written once and a new vendor is a thin adapter.
2. **Expose OpenMacaw tools to Claude Code** — so Claude Code can call
   `git.run` / `scheduled_task.*` / etc. under our governance, not only the
   SDK's built-ins.
3. **Visibility + local tests** — "see what Claude Code and Codex are running
   right now," and a local harness that launches a coding agent and asserts the
   tool stream.

## The keystone: one normalized tool-activity event

Define a single event shape every coding run emits, e.g.:

```
ToolActivity {
  run_id, agent_id, workspace_id,
  vendor: "claude_code" | "codex",
  tool_name, input_summary,
  decision: "allowed" | "denied" | "asked",
  phase: "request" | "result",
  ts, tool_use_id, duration_ms?
}
```

Both runners feed it:

- **Claude Code:** wire the SDK's **`can_use_tool`** callback in `bridge.js`
  (and surface it over the bridge protocol) → the SDK pauses before each tool
  call; the orchestrator records a `ToolActivity{phase: request}`, applies the
  governance decision, and returns allow/deny. (Mirrors Omnigent's
  `claude_sdk_executor._can_use_tool_for_permission`.)
- **Codex:** already routes `dynamic/tool` through `ToolRegistry`; emit the same
  `ToolActivity` from that path.

This one event is simultaneously (a) the governance hook, (b) the visibility
feed, and (c) what the local tests assert against. It is also the seed of the
shared abstraction.

## Phasing

**Phase 0 — Tool visibility (keystone, bounded).**
- Wire `can_use_tool` for Claude Code in `bridge.js` + bridge protocol; emit
  `ToolActivity` from both Claude Code and the existing Codex path.
- Persist/stream it; expose a read API (see Testing below). Default decision =
  allow (no behavior change yet) — this phase is *observe*, not *gate*.
- **Delivers the user-visible "see what Claude Code & Codex are running."**

**Phase 1 — Expose OpenMacaw tools to Claude Code.**
- Pass `mcpServers` to the SDK in `bridge.js` advertising OpenMacaw tools
  (`git.run`, `scheduled_task.*`, …); route their calls back to `ToolRegistry`,
  emitting `ToolActivity` like Codex. Now both runners share a tool model.

**Phase 2 — Govern.**
- Turn the Phase 0 hook from observe → enforce: `can_use_tool` / `dynamic/tool`
  consult the tool policy (allow / deny / **ask**), reusing tool grants. Uniform
  governance across both runners.

**Phase 3 — Refactor behind a shared `CodingRunner` behaviour.**
- Generalize the contract into one Elixir behaviour (events in, `ToolActivity`
  + text out, a gate callback). Collapse `claude_code` and `codex` onto it so a
  third vendor is a thin adapter. (Largest piece; informed by 0–2.)

Phases 0–1 each ship independent value; 3 is the cleanup that makes breadth cheap.

## Local testing & observability ("see what it's running")

Yes — fully local, no cloud needed:

1. **Bring up the stack:** `pnpm run start:local` (runtime) + `pnpm run dev`
   (platform). Provide `ANTHROPIC_API_KEY` (Claude Code) / OpenAI auth (Codex)
   and a small **fixture repo** as the agent workspace.
2. **See what's running:** a read endpoint backed by `ToolActivity`, e.g.
   `GET /api/diagnostic/agents/:id/activity` (extend the existing diagnostic at
   `/api/diagnostic/agents/:id`) returning the live/last-N tool calls for a run.
   Optionally surface it in the run view.
3. **Drive a smoke test:** a script / test that launches a coding agent
   (Claude Code or Codex) on the fixture repo with a trivial task (e.g. "create
   `hello.txt`" or, after Phase 1, "run `git.run gh pr list --repo …`"), then
   **asserts the `ToolActivity` stream** contains the expected tool calls and a
   final result. This is the "test the hookup, then ask the agent to run the
   calls" loop. Model it on the existing smokes
   (`platform/docs/shipped/claude-code-browser-smoke.md`,
   `local-model-coding-smoke.md`).

The same endpoint that answers "what is it running right now?" is what the test
asserts on — visibility and testability are the same feature.

## Open questions

- Persistence of `ToolActivity` — reuse the messages/run tables, or a dedicated
  table? Retention?
- Does the bridge protocol need a request/response round-trip for
  `can_use_tool` (it must block the SDK until OpenMacaw answers)? Confirm the
  bridge is full-duplex enough; today it is mostly one-way streaming.
- Codex tool model vs Claude Code MCP tool model — reconcile names/inputs in the
  normalized event.
- Where the shared behaviour lives and how it coexists with the broader `Runner`
  behaviour during the Phase 3 refactor.

## References

- Ours: `apps/orchestrator/priv/claude_agent_bridge/bridge.js` (uses `query()`,
  no `can_use_tool`/`mcpServers`); `apps/orchestrator/lib/symphony_elixir/codex/app_server.ex`
  (`dynamic/tool` → `ToolRegistry`); `…/lib/symphony_elixir/tool_registry.ex`.
- Omnigent: `omnigent/inner/claude_sdk_executor.py` (`_can_use_tool_for_permission`,
  `ClaudeSDKClient`, `options.can_use_tool`); `omnigent/runtime/harnesses/_executor_adapter.py`
  (shared adapter + `dispatch_tool`).
