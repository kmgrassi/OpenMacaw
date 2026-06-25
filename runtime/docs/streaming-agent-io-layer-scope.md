# Streaming agent I/O layer — scoping

> **Status:** Proposed. Build an Omnigent-style I/O transport over Codex and
> Claude Code: a clean **message-in / stream-out / interrupt** API backed by a
> **persistent streaming session** we own — so a third-party service can drive a
> running coding agent over HTTP/WS instead of janky workarounds (GitHub
> comments, restart-per-turn).
>
> Foundation under: [unified-coding-runner-scope](./unified-coding-runner-scope.md)
> (PR #295) and the `can_use_tool` spike (PR #296). **All three converge on one
> change** — a persistent streaming session in the bridge.

## The reframe

There is no vendor API to "message a running Codex/Claude session." The clean
API is something you **build** by owning the agent process and driving its
streaming I/O, then re-exposing it as your own HTTP/WS surface. Omnigent does
exactly this; we want the same.

## The convergence insight

A persistent streaming session unlocks, in one move:

- **I/O** — inject a message mid-session, stream output live, `interrupt()`.
- **Governance** — the SDK's `can_use_tool` callback (only fires in streaming mode).
- **Visibility** — the same stream is where `ToolActivity` comes from (#295).
- **Control** — `getContextUsage()`, `setModel()`, `setPermissionMode()` (all
  streaming-input only).

So this scope is the substrate; #295 (abstraction + visibility + governance)
sits on top of it.

## Current state (precise)

- **Claude Code** (`apps/orchestrator/priv/claude_agent_bridge/bridge.js`):
  one-shot **`query()`** per turn, with `resume: sdkSessionId` so multi-turn
  context is preserved. But each turn runs to completion — **no mid-turn inject,
  no `interrupt()`, no persistent client / control methods.**
- **Codex** (`apps/orchestrator/lib/symphony_elixir/codex/app_server.ex`):
  JSON-RPC app-server holding a **thread** (`initialize` → `thread/start` →
  `turn/start`). This is **already a persistent streaming protocol** — successive
  `turn/start`s reuse the thread. Codex is therefore *much* closer to the target.
- **Driving today** is turn-/work-item-granular: to say something else you start
  a new turn. There is no external "send this running session a message" API.

## Target architecture (map Omnigent → OpenMacaw)

| Omnigent | OpenMacaw target |
|---|---|
| Persistent `ClaudeSDKClient` + `client.query(prompt, session_id)` + `client.interrupt()` | Claude `bridge.js` → persistent `ClaudeSDKClient` (replace per-turn `query()`); Codex app-server thread already supports it |
| `ExecutorAdapter.run_turn` (inbound `CreateResponseRequest` → executor) | Orchestrator **session layer** that holds the live session and maps inbound API → bridge/app-server |
| Harness `POST …/events` (message / start-turn / tool-result / cancel) + SSE `/stream` | Platform API: send-message + interrupt endpoints + a live WS/SSE stream |
| Native `tmux send-keys` for the real TUI | Out of scope for now (we drive the SDK/app-server, not a TUI) |

### Proposed external API surface

- `POST /api/agents/:id/messages` — inject a user message into the running session.
- `POST /api/agents/:id/interrupt` — stop the current turn.
- `GET|WS /api/agents/:id/stream` — live output (text deltas, `ToolActivity`,
  usage, turn boundaries). Reuse the existing agent WS gateway if it fits.

## Phasing

**Phase A — Persistent streaming session in the runner.**
- *Codex first* (lowest friction — app-server already persistent): expose
  "send message to the running thread" + "cancel current turn" through the
  orchestrator. Delivers an end-to-end "message a running session via API" demo
  **without** the bridge rewrite.
- *Claude*: migrate `bridge.js` from one-shot `query()` to a persistent
  `ClaudeSDKClient` (`connect()`, `query()` to inject, `interrupt()`), streaming
  events out continuously. Gated on the spike (#296), which tells us streaming
  mode is required anyway.

**Phase B — Orchestrator session layer.**
- Hold the live session; map inbound `send_message` / `interrupt` and a
  continuous outbound event stream (not just per-turn request/response). Emit the
  normalized event/`ToolActivity` shape from #295.

**Phase C — Platform API + contracts.**
- The three endpoints above, Zod contracts, auth, and the WS/SSE plumbing from
  platform API → orchestrator → runner.

**Phase D — Converge with the shared `CodingRunner` abstraction (#295).**
- Both runners implement one session/IO contract; a new vendor is a thin adapter.

## Local testing

Extend the coding smoke: start a session on a fixture repo, then via the new API
**send a follow-up message mid-session** and assert it's received + output
streams; `interrupt` and assert the turn stops; confirm the stream carries
`ToolActivity`. All local (`pnpm run start:local` + `pnpm run dev`).

## Open questions

- Semantics: inject **into an in-flight turn** vs **queue as the next turn**?
  (Omnigent's persistent client preserves context across turns; in-flight
  injection is `interrupt()` + new message.)
- Does the Codex app-server expose a clean **cancel/interrupt**? Confirm.
- Reuse the existing agent **WS gateway** for the output stream vs a new channel.
- Ordering/backpressure when messages arrive faster than the agent consumes.

## References

- Omnigent: `omnigent/inner/claude_sdk_executor.py` (`ClaudeSDKClient`,
  `client.query` :1520, `interrupt` :1482, persistent client :1070),
  `omnigent/runtime/harnesses/_executor_adapter.py` (`run_turn`, inbound events),
  `omnigent/claude_native_bridge.py` (tmux send-keys, for reference only).
- Ours: `apps/orchestrator/priv/claude_agent_bridge/bridge.js` (per-turn
  `query()` + `resume`); `apps/orchestrator/lib/symphony_elixir/codex/app_server.ex`
  (JSON-RPC thread); `…/claude_code/bridge.ex`.
