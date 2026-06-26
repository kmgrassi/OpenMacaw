# Streaming agent I/O — production PR plan

> **Status:** Proposed. Turns the merged-but-orphaned streaming session layer
> (PR #299) into a working, production-grade live bidirectional I/O interface for
> **Codex** and **Claude Code**, sliced into independently-shippable PRs.
>
> Context: [streaming-agent-io-layer-scope](./streaming-agent-io-layer-scope.md),
> [unified-coding-runner-scope](./unified-coding-runner-scope.md), `can_use_tool`
> spike (PR #296). Each merge to `main` auto-deploys to KG production.

## Where we are (gap summary)

**Done (foundation):**
- `SymphonyElixir.AgentIO.Session` — persistent GenServer per session: multi-
  subscriber broadcast, turn serialization, real interrupt, idle-timeout teardown.
- Full HTTP surface: orchestrator `/api/v1/agents/:id/{input,interrupt,stream}`
  and `/api/v1/codex/sessions/*`, **plus** a platform-API proxy
  (`platform/apps/api/.../agent-live-io.ts`, `/api/agents/:id/*`) with auth +
  contracts. Reachable by external clients today.
- Codex backend: `codex/session_registry.ex` holds a persistent app-server
  thread; `/input` sends a turn into the running thread; `/interrupt` is a real
  RPC cancel; `turn_event_dispatcher.ex` emits tool-call events.

**The core gap — three disconnected paths, plus Claude not built:**
1. `/api/v1/agents/:id/input` routes through the **old `ChatGateway`**, *not*
   `AgentIO.Session`.
2. `AgentIO.Session` (the new layer) accepts any `CodingRunner` but **nothing
   routes to it** — built and orphaned.
3. Codex's `/api/v1/codex/sessions` path **bypasses `AgentIO.Session`** and has
   **no external event pub/sub** — events buffer in memory, so `/stream` gets no
   live Codex output.
4. **Claude Code is still one-shot** — `bridge.js` uses `query()`; `interrupt`
   returns `:interrupt_not_supported`; `can_use_tool` not wired.
5. Only fake-runner tests exist — no real Codex/Claude round-trip.

## Target state

**One path:** `POST /api/agents/:id/input` → platform proxy → orchestrator →
`AgentIO.Session` → (`CodingRunner`: Codex thread | Claude streaming client) →
normalized events → `GET /stream`. `interrupt` + idle lifecycle uniform. The
standalone `/api/v1/codex/sessions` controller becomes redundant.

## Cross-cutting production concern (gate before prod rollout)

**Session affinity across orchestrator instances.** `AgentIO.Session` is a
GenServer living on **one** orchestrator node. If the runtime ECS service runs
>1 task, a client's `/input` and `/stream` can land on a different node than the
one holding the session and fail. **Before PR1 reaches prod traffic**, confirm
one of: (a) the runtime orchestrator is single-instance, or (b) add a
distributed session registry / sticky routing (Horde / `:pg` / a session→node
lookup). Treated as a gating investigation in PR1 and, if (b), its own PR.

Also cross-cutting: a **concurrency cap** on live sessions, **metrics/logs** for
session lifecycle, and **gradual rollout** (per-workspace flag) so the
ChatGateway→AgentIO switch can be dialed in.

## PR plan

### PR1 — Route coding-runner agents through `AgentIO.Session` (Codex live I/O)
- **Goal:** `/api/v1/agents/:id/{input,interrupt,stream}` drives a Codex-backed
  agent through `AgentIO.Session` — live input, live `/stream`, real interrupt —
  on the unified agent path.
- **Changes:** in `agent_live_io.ex` dispatch **by runner kind** — coding runners
  (Codex) → `AgentIO` (`post_message`/`subscribe`/`interrupt`); non-coding →
  existing `ChatGateway` (unchanged). The Codex `CodingRunner` adapter
  (`runner/codex.ex`) drives `SessionRegistry` under the session, passing the
  session's `on_message` so `turn_event_dispatcher` events broadcast to `/stream`.
- **Map internal events to the public stream contract.** `AgentIO.Session`
  broadcasts internal names (e.g. `:turn_ended_with_error` on interrupt); the
  external `/stream` must emit only `AgentLiveStreamEventSchema` types
  (`platform/contracts/agent-live-io.ts`): `text_delta`, `turn_started`,
  `turn_completed`, `turn_interrupted`, `error` (and `tool_activity`, added in
  PR2). PR1 owns the turn/text/error mapping (`:turn_ended_with_error` → either
  `turn_interrupted` for an interrupt or `error` for a failure) so public streams
  validate against the contract — this can't wait for PR2. Add a contract field
  if a needed event has no home rather than leaking internal names.
- **Acceptance:** fake-Codex test — `/input` then a `/stream` subscriber receives
  contract-valid events (`turn_started` → `text_delta` → `turn_completed`);
  `/interrupt` → a `turn_interrupted` event (validated against
  `AgentLiveStreamEventSchema`). No regression for ChatGateway (planner/manager)
  agents.
- **Also:** the session-affinity investigation above.
- **Deps:** none (builds on #299). **Risk:** medium (live routing) — mitigated by
  the runner-kind branch + tests + per-workspace flag.

### PR2 — Normalized tool activity on the stream
- **Goal:** emit a consistent `tool_activity` event (vendor, tool_name, input
  summary, phase `request|result`, decision) on `/stream`, derived from Codex's
  `turn_event_dispatcher` tool events. The "what is it running" feed + the seam
  for later governance.
- **Changes:** a normalizer (extend `agent_io/session.ex` `Contract.normalize_event`
  or a new module); platform stream-event contract.
- **Acceptance:** `/stream` carries normalized `tool_activity` for a Codex run.
- **Deps:** PR1.

### PR3 — Claude Code persistent streaming bridge (no agent wiring yet)
- **Goal:** migrate `priv/claude_agent_bridge/bridge.js` from one-shot `query()`
  to a persistent `ClaudeSDKClient` (`connect` / `query` to inject / `interrupt`),
  streaming events continuously; extend `claude_code/bridge.ex` for a persistent
  session + interrupt + a `can_use_tool` request/response round-trip.
- **Gated on:** spike #296 (does `can_use_tool` fire with our prompt form / is
  streaming-input required). Parallelizable with PR1/PR2 (different files).
- **Acceptance:** the bridge holds a live session across turns and streams; a
  node/Elixir test drives connect→query→stream→interrupt against a recorded SDK;
  `ClaudeCode.interrupt/2` no longer returns `:interrupt_not_supported`.
- **Deps:** spike #296.

### PR4 — Wire Claude Code into `AgentIO.Session` (Claude live I/O)
- **Goal:** `claude_code` runner-kind agents route through `AgentIO.Session`
  (like Codex in PR1) using the persistent bridge from PR3 — live input/stream,
  real interrupt — on the same unified path.
- **Changes:** `runner/claude_code.ex` `CodingRunner` adapter drives the
  persistent bridge; `agent_live_io.ex` dispatch adds `claude_code → AgentIO`.
- **Acceptance:** `/api/agents/:id/{input,stream,interrupt}` work for a
  Claude-backed agent (recorded-bridge test).
- **Deps:** PR1 (dispatch), PR3 (bridge).

### PR5 — `can_use_tool` → tool activity (Claude visibility, observe-only)
- **Goal:** wire `bridge.js` `can_use_tool` → orchestrator → emit normalized
  `tool_activity` (PR2 shape) for Claude; **default-allow** (observe-only). Sets
  up the later governance flip (allow/deny/ask).
- **Changes:** `bridge.js`, `bridge.ex`, `event_mapper.ex`, the PR2 normalizer.
- **Acceptance:** a Claude run's tool calls appear as `tool_activity` on `/stream`.
- **Deps:** PR2, PR3, PR4.

### PR6 — Production hardening, real-process tests, smoke, cleanup
- **Goal:** make it safe + verifiable in prod.
- **Changes:**
  - Session concurrency cap + lifecycle metrics/logs; finalize the affinity
    decision from PR1.
  - **Real-process tests:** real Codex binary + real Claude bridge round-trips
    (beyond the fakes).
  - A runnable **CLI smoke**: `create → input → stream → interrupt` for both
    Codex and Claude, against local (`pnpm run start:local`) and prod.
  - Retire the now-redundant standalone `/api/v1/codex/sessions` agent path (or
    keep it internal-only).
- **Deps:** PR1–PR5.

## Dependency graph

```
PR1 ─► PR2 ─────────────► PR5 ─► PR6
  │                        ▲
  └─► PR4 ◄── PR3(#296) ───┘
        ▲
        └── PR1 (dispatch)
```
- **Parallel:** PR3 (Claude bridge) runs alongside PR1/PR2.
- **Critical path to "Codex live in prod":** PR1 (+ affinity gate).
- **Critical path to "Claude live in prod":** spike #296 → PR3 → PR4.

## Open questions

- **Backpressure:** today concurrent `/input` returns `:turn_already_active`
  (no queue). Queue-and-drain, or keep reject-while-busy? (PR1/PR6.)
- **Session affinity** across orchestrator instances (above) — single-instance
  vs distributed registry.
- Idle-timeout default (5 min) and concurrency cap values for prod.
- Should `/api/v1/codex/sessions` be removed or kept as a lower-level escape hatch?

## References

- Foundation: `runner/coding_runner.ex`, `agent_io.ex`, `agent_io/session.ex`,
  `agent_live_io.ex`, web controllers `agent_live_io_controller.ex` /
  `codex_session_controller.ex`, `codex/{session_registry,turn_event_dispatcher,app_server}.ex`,
  `runner/{codex,claude_code}.ex`, `claude_code/{bridge.ex,event_mapper.ex}`,
  `priv/claude_agent_bridge/bridge.js`, `symphony_elixir_web/router.ex`.
- Platform proxy: `platform/apps/api/src/routes/agent-live-io.ts`,
  `platform/contracts/agent-live-io.ts`.
