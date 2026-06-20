# OpenMacaw vs. OpenClaw vs. Hermes

How OpenMacaw relates to two adjacent agent projects it is often compared
to — **OpenClaw** and **Hermes Agent** (Nous Research). The short version:
OpenClaw and Hermes are both **self-hosted personal AI-assistant runtimes**
that compete with each other; OpenMacaw is a different category — an
**always-on, multi-tenant orchestration platform** that can *run* OpenClaw as
one of many agent backends, and that *borrows* Hermes's learning loop as one
optional, workspace-scoped sidecar rather than as its core.

> Sources: external facts about OpenClaw and Hermes below are drawn from each
> project's GitHub repo and docs (cited inline). OpenMacaw facts cite this
> repository. External project details current as of mid-2026 and will drift —
> treat the architectural relationship as the durable part, not version
> specifics.

---

## What each project is

| | **OpenMacaw** | **OpenClaw** | **Hermes Agent** |
|---|---|---|---|
| Category | Multi-runner agent **orchestration platform** | Self-hosted **personal AI assistant** runtime | Self-improving **personal agent** runtime |
| Maintainer | This repo (`kmgrassi/OpenMacaw`) | Peter Steinberger / OpenClaw Foundation ([`openclaw/openclaw`](https://github.com/openclaw/openclaw)) | Nous Research ([`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent)) |
| Language | TypeScript + Elixir + Go | TypeScript / Node | Python |
| Primary unit | A *workspace* of agents run on a schedule | One personal assistant, one Gateway process | One *user's* agent that learns over time |
| Tenancy | Multi-tenant (workspace + RLS) | Single-user / self-hosted | Single-user / self-hosted |
| Where it runs | Cloud-hosted (always-on) + optional local execution | Local / self-hosted Gateway daemon | Local, Docker, SSH, Daytona, Singularity, or serverless (Modal) |
| Learns across runs? | Optionally, via the workspace learning sidecar | Memory + skills | Yes — a built-in closed learning loop is its whole point |
| License | (this repo) | MIT | MIT |
| Relationship to OpenMacaw | — | **Integrated as a runner kind** | **Inspiration for one sidecar** |

OpenMacaw's own one-liner: *"an open-source platform for coordinating AI
agents across hosted and local runtimes"* ([`README.md:7-9`](../README.md)).
The crucial framing: **OpenClaw and Hermes are competitors to each other** —
Hermes Agent is widely described as "an OpenClaw alternative," and both are
single-user assistants that wire ~20 messaging channels to an agent with
tools, memory, and skills. OpenMacaw is not in that race; it is the layer that
*schedules, routes, credentials, persists, and multiplexes* runtimes for a
team — and OpenClaw can be one of those runtimes.

### Name disambiguation (worth getting right)

- **OpenClaw the AI assistant** ([`openclaw/openclaw`](https://github.com/openclaw/openclaw),
  TypeScript) is distinct from **OpenClaw the game engine**
  (`pjasicek/OpenClaw`, a C++ reimplementation of the 1997 *Captain Claw*
  platformer) — unrelated project, different owner. This doc means the AI
  assistant.
- **Hermes Agent** (the self-improving *runtime*,
  [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent),
  Python) is distinct from the **Hermes LLM series** (Hermes 2 / 3 / 4) —
  Nous Research's open-weight *models*. The agent runtime *uses* models but is
  a separate system. This doc means the agent runtime.

---

## The core goal that sets OpenMacaw apart

**Run agents at all times on cloud infrastructure, while still letting users
bring local models that "just work" against their production deployment.**

Neither OpenClaw nor Hermes targets this. Both are personal assistants you
self-host for yourself; their "always on" is a daemon on your box or a
serverless instance for *you*. OpenMacaw is built so an operator can stand up
a hosted, multi-tenant deployment where:

1. Agents run continuously — triggered by schedules and external work items,
   not just an inbound chat message.
2. A developer can `ollama pull` a model on their laptop and route
   production agent work to it, **without exposing their machine to inbound
   traffic** and without redeploying anything.

The two halves below are the load-bearing differentiators.

### Half 1 — Always-on cloud execution

OpenMacaw runs agents on a continuously-running Elixir orchestrator +
launcher (ports 4000/4100), driven by three trigger sources rather than only
live chat:

- **Scheduled tasks.** The `scheduled_task` framework supports one-time
  (`at`), recurring (`every`), and `cron` schedules with timezone support,
  and can deliver a `scheduled_agent_message` that kicks off an agent run on
  a cadence ([`platform/contracts/scheduled-tasks.ts:32-55`](../platform/contracts/scheduled-tasks.ts)).
  The orchestrator polls this table on a tick — the same mechanism the
  learning sidecar reuses for nightly reflection.
- **External work items.** GitHub and Linear issues/PRs land via verified
  webhooks (`POST /api/webhooks/github`, `POST /api/webhooks/linear`) and
  become canonical `work_item` rows with polling cadence (`nextPollAt`,
  `pollCadenceSeconds`) ([`platform/contracts/work-items.ts`](../platform/contracts/work-items.ts)).
- **Manual / planner-created work.** Manual API ingest and agent-created
  (`planner`) tasks flow through the same `work_item` pipeline.

The result is an agent fleet that wakes up, picks up work, and runs to a
terminal outcome on its own. OpenClaw and Hermes are reactive personal
assistants — they act when a message or trigger arrives for their one user;
they have no workspace-level scheduler/intake layer multiplexing a fleet.

### Half 2 — Local models against a prod deployment (the Ollama story)

This is the part that's genuinely unusual. A user can run a local model and
have **cloud-hosted, production agents dispatch work to it** over an
**outbound-only** relay connection:

1. Install the Go **`local-runtime-helper`** daemon on the local box.
2. Point a runner at the local endpoint — e.g. Ollama:
   `[runner.openai_compatible] endpoint = "http://127.0.0.1:11434/v1", model = "qwen2.5-coder:latest"`
   ([`local-runtime-helper/README.md`](../local-runtime-helper/README.md)).
3. The helper registers the machine (one-time token → `local_runtime_machine`
   / `local_runtime_token`) and opens a **persistent outbound WSS** to the
   cloud orchestrator. No inbound ports, no tunnel.
4. The cloud routes a `local_relay` runner kind to that machine: the Elixir
   `SymphonyElixir.Runner.LocalRelay` looks up the online helper in its
   registry and dispatches the protocol frame to it
   ([`runtime/apps/orchestrator/lib/symphony_elixir/runner/local_relay.ex`](../runtime/apps/orchestrator/lib/symphony_elixir/runner/local_relay.ex)).
5. Binding an agent to the local model is a **routing-rule** change, not a
   redeploy — the production deployment stays up; the agent just starts
   resolving to the local endpoint.

So "pull a local model and have it just work with prod" is a config/routing
operation, with the machine's exposure limited to one outbound socket. That
is OpenMacaw-specific: OpenClaw and Hermes run *their own* local model loop
for *their own* user — neither offers a hosted control plane that routes a
team's production agents down to a contributor's local model.

---

## OpenMacaw and OpenClaw: integration, not competition

OpenClaw is a self-hosted personal assistant: a single **Gateway** daemon
(TypeScript/Node) that serves HTTP + WebSocket on one port and routes
messages from ~20 channels (WhatsApp, Telegram, Slack, Discord, …) into an
**embedded agent runtime** that owns its own tool-calling loop, runs tools in
an optional Docker sandbox, and uses selective skill injection
([`openclaw/openclaw`](https://github.com/openclaw/openclaw),
[docs.openclaw.ai](https://docs.openclaw.ai/concepts/agent)).

In *this* codebase, that runtime is treated as **a runner kind**, not a rival
platform — "OpenClaw running on a local box is one runner kind sitting behind
a generic relay transport"
([`local-openclaw-helper-scope.md`](../platform/docs/active/local-openclaw-helper-scope.md)):

- The helper ships an `openclaw` runner adapter
  (`local-runtime-helper/internal/runner/openclaw/openclaw.go`) alongside the
  `openai_compatible` (Ollama-style) adapter.
- The runner registry defines `openclaw`, `openclaw_ws`, and
  `openclaw_http_sse` kinds with their transports
  ([`platform/contracts/runner-kinds.ts`](../platform/contracts/runner-kinds.ts)),
  and the DB check constraints already permit them.
- OpenClaw "manages its own tool loop internally," so OpenMacaw orchestrates
  *to* it, not *inside* it. (Note: the registry currently classifies the
  `openclaw`, `openclaw_ws`, and `openclaw_http_sse` kinds as
  `toolCalls: "always"` in `runner-kinds.ts`; the scope doc raises switching
  OpenClaw to `tool_calls: never` as an open question, but that is not yet the
  implemented state.)

**Difference in role:** OpenClaw answers "how does *my* assistant run on my
box and reach my chat apps?" OpenMacaw answers "how does a team schedule,
route, credential, persist, and multiplex many agents — one of which might be
an OpenClaw Gateway — across a workspace?"

---

## OpenMacaw and Hermes: borrowed idea, different scope

Hermes Agent (Nous Research) is a self-improving **personal**-agent runtime —
"the agent that grows with you." Its differentiator is a **built-in closed
learning loop**: agent-curated memory with periodic "nudges," **autonomous
skill creation and self-improvement during use**, FTS5 cross-session recall
with LLM summarization, and portable skills via a Skills Hub. Self-improvement
happens at the procedural level — it remembers and restructures procedures,
it does *not* retrain model weights
([`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent),
[hermes-agent docs](https://hermes-agent.nousresearch.com/docs/)).

OpenMacaw adopts the *blueprint* as an optional **learning sidecar**, with
deliberate substitutions
([`learning-sidecar-scope.md`](../platform/docs/superseded/learning-sidecar-scope.md)):

| Dimension | Hermes Agent | OpenMacaw learning sidecar |
|---|---|---|
| What it learns about | A **user** (preferences, history, "grows with you") | A **workspace** (repo conventions, CI quirks, flaky tests, deploy steps) |
| Memory key | the user | `workspace + agent + agent_type` |
| Skill creation | **Autonomous** self-improvement during use | **Advisory** — candidates open as PRs; humans merge |
| Recall | FTS5 + LLM summarization | Existing `memory_items` + `memory_hybrid_search` (FTS + pgvector RRF) |
| Role in the system | The **core** runtime | One **optional sidecar** on an existing orchestrator |

Two boundary calls make the distinction concrete and are stated explicitly in
the scope doc:

- *"A user's personal preferences … are out of scope — that's Hermes's home
  turf, and we don't have a single-user surface to make it useful here."*
- Replacing the agent runner with a Hermes-style runner is *"explicitly not
  the path here"* (the rejected "Option C").

**Difference in stance:** Hermes lets the agent autonomously rewrite its own
skills to get better at serving one person. OpenMacaw keeps a human in the
loop (PR-gated skills) and learns institutional/workspace knowledge that many
agents and many users share.

---

## Other differences surfaced from the codebase

Beyond the always-on + local-model goal, several structural choices separate
OpenMacaw from a single-user assistant like OpenClaw or Hermes:

1. **Multi-runner dispatch under one agent.** A single agent can be routed to
   Codex, Claude Code, OpenClaw, a planner, an LLM-tool runner, computer-use,
   or a local model — chosen per routing rule, not hardcoded
   ([`contracts/runner-kinds.ts` `RUNNER_REGISTRY`](../platform/contracts/runner-kinds.ts);
   "No hardcoded models" rule in [`platform/CLAUDE.md`](../platform/CLAUDE.md)).
   Each runner advertises capabilities (streaming, tool calls, workspace
   write, structured output, interrupt) so routing respects what a backend can
   actually do. OpenClaw and Hermes each *are* a single runtime; OpenMacaw
   treats runtimes as interchangeable backends.

2. **Workspace multi-tenancy with RLS.** Everything is partitioned by
   `workspace_id` and enforced with Postgres row-level security — agents,
   credentials, routing rules, work items, scheduled tasks, memories. OpenClaw
   and Hermes are single-tenant by design.

3. **Centralized, decoupled credential management.** Credentials live in a
   `credential` table (user- or workspace-scoped), referenced by id or by
   friendly **alias** (`credential_alias`), and resolved through the execution
   profile — never hardcoded in runner code
   ([`platform/contracts/credentials.ts`](../platform/contracts/credentials.ts);
   "No hardcoded credentials" rule in [`platform/CLAUDE.md`](../platform/CLAUDE.md)).

4. **Provider-agnostic routing.** Multiple LLM providers (`openai`,
   `anthropic`, `openai_compatible`, …) and runtime-family providers coexist;
   the same agent can change providers via a routing-rule edit while its
   message history (which records the generating model per message) persists.

5. **Outbound-only local trust model.** Local execution never requires inbound
   network access to the user's machine — the helper dials out and holds the
   socket. A platform-level security property, not a per-runtime one.

6. **Pluggable work trackers.** A workspace selects one tracker kind (memory,
   database, github, linear, api); the platform reads/writes the selected
   tracker uniformly ([`platform/contracts/tracker-kinds.ts`](../platform/contracts/tracker-kinds.ts)).

7. **Three-language, three-subsystem architecture.** TypeScript platform
   (Express API + React/Vite web), Elixir runtime (orchestrator/launcher), and
   a Go local helper — combined in one source tree
   ([`README.md`](../README.md)). The split exists precisely to separate
   orchestration, execution, and the local bridge — versus OpenClaw's single
   Node Gateway or Hermes's single Python runtime.

---

## One-paragraph summary

OpenClaw and Hermes Agent are **personal-assistant runtimes** that compete
with each other — self-hosted, single-user, wiring chat channels to an agent
with memory and skills. OpenMacaw is a different category: the **multi-tenant
platform that runs runtimes**. Its reason for existing is keeping a team's
agents working continuously on cloud infrastructure while letting developers
route production work to local models (e.g. an Ollama model) over an
outbound-only relay — a goal neither personal-assistant project pursues.
OpenClaw plugs in as one of OpenMacaw's interchangeable runner kinds, and
Hermes's self-improvement loop is adapted into an optional, workspace-scoped,
PR-gated learning sidecar rather than the system's core.

---

## Sources

- OpenMacaw: this repository (citations inline above).
- OpenClaw: [`github.com/openclaw/openclaw`](https://github.com/openclaw/openclaw),
  [`docs.openclaw.ai`](https://docs.openclaw.ai/concepts/agent). MIT. Distinct
  from the `pjasicek/OpenClaw` game engine.
- Hermes Agent: [`github.com/NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent),
  [`hermes-agent.nousresearch.com/docs`](https://hermes-agent.nousresearch.com/docs/).
  MIT. Distinct from the Hermes LLM series ([nousresearch.com](https://nousresearch.com)).
