<p align="center">
  <img src="docs/assets/openmacaw-logo.png" alt="OpenMacaw logo" width="180">
</p>

# OpenMacaw

OpenMacaw is an open-source platform for orchestrating your own models —
run them locally or self-hosted in your own cloud — alongside frontier
models, all from one control plane. It is built for teams that want to bring
their own models and coordinate AI agents across those runtimes instead of
depending on a single hosted provider. This repository combines the web/API
platform, the runtime orchestrator, and the installable local helper into one
source tree.

> OpenMacaw is pre-release. It works for local development and self-hosting
> experiments, but naming, docs, and packaging are still being cleaned up for
> a polished public launch — see [Project status](#project-status).

## Quick start

### Prerequisites

| Tool | Used by | Notes |
| --- | --- | --- |
| Git | everything | |
| Node.js 20+ and [pnpm](https://pnpm.io/) 9+ | platform, runtime scripts | `npm install -g pnpm` |
| Elixir 1.16+ / Erlang OTP 26+ (`elixir`, `mix`) | runtime | `brew install elixir` or [mise](https://mise.jdx.dev/) |
| `curl`, `lsof`, `shasum` | dev scripts | preinstalled on macOS; standard packages on Linux |
| Docker + [Supabase CLI](https://supabase.com/docs/guides/local-development) | local database | needed for login and database-backed workflows |
| Go 1.23+ | local runtime helper | only if you build the optional helper daemon |

Verify the command-line tools with:

```sh
./openmacaw doctor
```

### 1. Run the local stack

From the repository root:

```sh
./openmacaw run
```

That command installs missing JavaScript and Elixir dependencies, checks
whether Supabase is configured, then starts the platform API, platform web app,
runtime launcher, and runtime orchestrator together:

- Web: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:3100`
- Runtime orchestrator: `http://127.0.0.1:4000`
- Runtime launcher: `http://127.0.0.1:4100`
- Supabase Studio, after local Supabase is started: `http://127.0.0.1:54323`

Press `Ctrl+C` to stop the OpenMacaw processes.

If Supabase is not configured yet, `./openmacaw run` continues and prints a
setup note. The shell/UI can load, but login and database-backed agent workflows
need Supabase. For the local database path:

```sh
cd platform
supabase start
supabase migration up --local
supabase status -o env
```

Copy the local API URL, anon key, and service_role key into `platform/.env`
and the API URL plus service_role key into `runtime/.env`. You can create both
files from the examples:

```sh
cp platform/.env.example platform/.env
cp runtime/.env.example runtime/.env
```

If you want to use a hosted Supabase project instead, create
`platform/.env` and `runtime/.env` from the example files before running the
stack, then fill in the Required sections with your hosted project URL, anon
key, and service role key. See
[docs/supabase/README.md](docs/supabase/README.md) for hosted setup and
migration details. Set `OPENMACAW_AUTO_SUPABASE=1` to let `./openmacaw run`
start local Supabase and fill the local env files automatically.

### 2. Log in and verify

Create a user, then sign in at `http://127.0.0.1:5173`:

- **Local Supabase:** open Supabase Studio (`http://127.0.0.1:54323`),
  go to **Authentication → Users → Add user**, and create an email/password
  user.
- **Hosted Supabase:** create the user from the project dashboard's
  Authentication page.

Optionally set `VITE_DEV_LOGIN_EMAIL` / `VITE_DEV_LOGIN_PASSWORD` in
`platform/.env` to get a one-click "Use dev credentials" button on the login
page (development builds only).

For a step-by-step first-run checklist — login, onboarding, sending a first
agent message — follow the
[end-to-end local runbook](platform/docs/reference/end-to-end-local-runbook.md).

### Everyday commands

```sh
./openmacaw doctor   # check prerequisites and env configuration
./openmacaw status   # show local service health
./openmacaw stop     # stop a stack started by ./openmacaw run
```

Linked git worktrees automatically use an offset port range so multiple agents
can run OpenMacaw side by side. Override ports with `API_PORT`, `WEB_PORT`,
`ORCHESTRATOR_PORT`, `LAUNCHER_PORT`, or `LAUNCHER_START_PORT` when needed.

## What is in this repo

- `platform/` contains the web app, API gateway, shared contracts, platform
  scripts, and generated Supabase types.
- `runtime/` contains the Elixir runtime/orchestrator, launcher, relay-facing
  runtime behavior, worker bridge, smoke tools, and generated runtime schema
  artifacts.
- `local-runtime-helper/` contains the Go daemon that connects a user's machine
  to supported local runners and the runtime relay.
- `docs/` contains OpenMacaw-level planning and reference material that applies
  across the imported subsystems.

## How the pieces fit together

At a high level:

1. The platform provides the browser UI, API surface, shared contracts, and
   database-backed coordination layer.
2. The runtime launches and supervises agent work, reads routable work items,
   runs manager/planner flows, and exposes launcher/worker bridge APIs.
3. The local runtime helper runs on a user's machine, opens an outbound relay
   connection, advertises configured local runners, and can execute supported
   local workflows without requiring inbound network access.

The local runtime helper is how you bring your own models to the platform: a
separate daemon for workflows that need local model or local tool execution
(Ollama, OpenClaw, and other local runners). It lets a model running on your
own machine — or in your own cloud — serve agent work alongside frontier
models, without opening inbound network access. Set it up from
[`local-runtime-helper/`](local-runtime-helper/README.md) after the core stack
is running.

## Project status

OpenMacaw was imported from separate internal projects and is being prepared
for a public launch. Some subsystem docs still carry pre-import naming and
internal references; treat those as cleanup targets, not the final public
position. See
[docs/open-source-readiness-scope.md](docs/open-source-readiness-scope.md) for
the readiness plan and remaining work.

## Documentation

- [docs/README.md](docs/README.md) — repository-level documentation index
- [docs/supabase/README.md](docs/supabase/README.md) — database setup and
  migration workflow
- [End-to-end local runbook](platform/docs/reference/end-to-end-local-runbook.md)
  — first-run verification checklist
- [CONTRIBUTING.md](CONTRIBUTING.md) — contributor workflow and validation
  commands
- Subsystem guides: [platform](platform/README.md),
  [runtime](runtime/README.md),
  [local runtime helper](local-runtime-helper/README.md)

## License

OpenMacaw is licensed under the [Apache License 2.0](LICENSE).
