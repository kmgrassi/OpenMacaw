# OpenMacaw vs. Omnigent

How OpenMacaw relates to **Omnigent** ([`omnigent-ai/omnigent`](https://github.com/omnigent-ai/omnigent)),
another open-source project that sits *above* individual coding agents and
gives you one control plane. The short version: both are orchestration layers
over agents like Claude Code and Codex, but they aim at different users.
**Omnigent** is a **meta-harness for interactive, multi-device, collaborative
agent sessions** — you (and teammates) drive agents live across terminal,
browser, phone, and a native desktop app, with strong sandboxing and policy
governance. **OpenMacaw** is a **multi-tenant, always-on orchestration
platform** — cloud agents triggered by schedules, webhooks, and planners, with
a signature ability to route production work to *local* models on your own
machine over an outbound-only relay.

> Sources: external facts about Omnigent are drawn from its GitHub repo and
> README (cited inline). OpenMacaw facts cite this repository. External project
> details are current as of mid-2026 and will drift — treat the architectural
> relationship as the durable part, not version specifics.

---

## The one-sentence difference

- **OpenMacaw** optimizes for **autonomous, scheduled, server-side execution**:
  agents triggered by cron/webhook/planner, running to completion on cloud
  infrastructure, optionally offloading to local models.
- **Omnigent** optimizes for **human-in-the-loop, real-time, multi-surface
  collaboration**: people driving agents together, live, across devices, inside
  sandboxes with policy guardrails.

Neither really has the other's most distinctive capability — OpenMacaw's
**cloud→local model relay** vs. Omnigent's **collaboration + sandboxing +
policy stack**.

---

## What each project is

| | **OpenMacaw** | **Omnigent** |
|---|---|---|
| Category | Multi-tenant agent **orchestration platform** | **Meta-harness** for interactive agent sessions |
| Maintainer | This repo | [`omnigent-ai/omnigent`](https://github.com/omnigent-ai/omnigent) |
| Languages | TypeScript + Elixir/OTP + Go | Python (~83%) + TypeScript + Swift |
| Primary unit | A *workspace* of agents run on a schedule | A *session* you drive across devices |
| Optimizes for | Autonomous, scheduled, server-side runs | Real-time, collaborative, multi-surface use |
| Native app | Web only | Web UI **+ native macOS desktop app** |
| Tenancy | Multi-tenant (workspace + Postgres RLS) | Optional multi-user (invite-only, OIDC SSO) |

OpenMacaw's one-liner: *"an open-source platform for coordinating AI agents
across hosted and local runtimes"* ([`README.md`](../README.md)). Omnigent's:
*"an open-source meta-harness that gives you a common orchestration layer"*
across multiple AI coding agents.

---

## Architecture & stack

| | **OpenMacaw** | **Omnigent** |
|---|---|---|
| Languages | TypeScript + **Elixir/OTP** + **Go** | **Python** (83%) + TypeScript + Swift |
| Control plane | Express API + React/Vite, Supabase (Postgres + RLS) | Python local server + Web UI |
| Orchestrator | Elixir/Phoenix orchestrator + launcher | Python harness layer |
| Local bridge | Go daemon (outbound WSS relay) | — |
| Native app | — | macOS desktop app (Swift) |

The structural contrast: OpenMacaw is a **three-language, three-subsystem**
system — orchestration in Elixir, control plane in TypeScript, local bridge in
Go (see [`platform/`](../platform), [`runtime/`](../runtime),
[`local-runtime-helper/`](../local-runtime-helper)). Omnigent is **Python-first**
with a unified harness abstraction plus a Swift desktop client.

---

## Supported agents & models — roughly comparable

- **OpenMacaw runners:** Codex, Claude Code, OpenClaw, Planner, generic LLM
  tool runner, computer-use, local-model coding. Models: Anthropic, OpenAI,
  xAI, Google, Mistral, Groq, OpenRouter, Together, Perplexity, Ollama.
- **Omnigent agents:** Claude Code, Codex, **Cursor, OpenCode**, Hermes, Pi,
  custom YAML agents. Models: first-party keys, **subscriptions (Claude
  Pro/Max, ChatGPT plans)**, OpenRouter/Ollama/LiteLLM/Azure, **Databricks**.

Both are extensible registries. Omnigent supports a couple more named harnesses
(Cursor, OpenCode) and subscription-based auth; OpenMacaw covers a broad model
provider list and adds the local-model coding runner.

---

## Features Omnigent has that OpenMacaw doesn't

1. **Multi-device session sync** — the same session (messages, sub-agents,
   terminals, files) stays live across terminal, browser, phone, and a native
   desktop app. OpenMacaw has persistent sessions + WebSocket streaming, but
   it's a single web UI, not a sync-across-surfaces experience.
2. **Real-time human collaboration** — live session sharing, co-driving (shared
   keyboard control), and forking conversations for independent continuity.
   OpenMacaw has no collaborative/multi-presence layer.
3. **Native macOS desktop app** with OS notifications. OpenMacaw is web-only.
4. **Built-in governance/policy engine** — server-, agent-, and session-level
   policies: shell approval gates, tool-call limits, spend caps with
   thresholds. OpenMacaw has tool *grants* (per-agent access control) but not a
   configurable policy/approval/budget system.
5. **Disposable sandbox deployment** — runs agents in Modal, E2B, Databricks,
   Kubernetes, or CoreWeave, or in local OS sandboxes (`bwrap` on Linux,
   `seatbelt` on macOS). OpenMacaw runs agents on its own cloud launcher (and
   local relay) but doesn't have this pluggable disposable-sandbox model or
   OS-level isolation.
6. **MCP (Model Context Protocol) servers** as a first-class tool source.
   OpenMacaw uses its own DB-backed tool/grant model.
7. **Subscription-based auth** — use a Claude Max / ChatGPT plan instead of API
   keys.
8. **OIDC SSO** (Google, GitHub, Okta, Microsoft) for multi-user login.
9. **YAML agent definitions** — declarative agent specs (prompt + executor
   harness + tool declarations).

---

## Features OpenMacaw has that Omnigent doesn't

- **Outbound-only local-model relay** — production cloud agents can route work
  to local models (Ollama, etc.) on your machine with no inbound ports. This is
  OpenMacaw's signature capability; Omnigent's local story is local *sandboxes*,
  not a cloud→local model relay.
- **Always-on, trigger-driven autonomy** — scheduled tasks (cron/at/every),
  GitHub/Linear webhook ingestion, and planner agents that create work items.
  Omnigent reads as more session/interaction-driven.
- **Config-driven multi-runtime routing** — one agent routes to different
  backends/models per rule without redeploy or losing message history.
- **Workspace learning sidecar** — a nightly reflection agent that observes
  transcripts and proposes skills as PRs (human-in-the-loop).
- **Multi-tenant from the ground up** — Postgres RLS workspace isolation as a
  core primitive, not an optional add-on.

---

## Bottom line

If you want **teams driving agents together in real time across devices, with
sandboxed execution and policy guardrails**, Omnigent is the richer fit. If you
want a **server-side, always-on orchestration backbone that schedules
autonomous agents and can offload to local models**, OpenMacaw is the more
specialized tool. The most interesting non-overlapping capabilities are
**OpenMacaw's cloud→local relay** vs. **Omnigent's collaboration + sandboxing +
policy stack** — neither really has the other's.
