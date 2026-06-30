# OpenMacaw Runtime

Elixir/OTP runtime that launches and supervises agent work for OpenMacaw. It
reads routable work items, runs manager/planner flows, dispatches to hosted
and local runners, and exposes the launcher/worker bridge APIs the platform
calls.

## Layout

```
apps/orchestrator/   — main Elixir application (orchestrator + web endpoint)
apps/launcher/       — launcher for managing orchestrator instances
docs/                — runtime-level scoping documents and runbooks
scripts/             — start scripts, smoke tests, schema sync tooling
workers/             — worker bridge assets
```

## Running

The normal way to run the runtime is as part of the full stack, from the
repository root:

```sh
./openmacaw run
```

To run just the runtime (launcher on port 4100, orchestrator on port 4000):

```sh
pnpm install
pnpm run start:local
```

### Environment

The start scripts load env from `apps/orchestrator/.env` or `.env` in this
directory. Create one from the example and fill in the same Supabase values
used by `platform/.env`:

```sh
cp .env.example .env
```

Without `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, the services boot but
database-backed behavior (work items, manager/planner flows, message log)
fails at first use.

### Health checks

```sh
curl http://127.0.0.1:4000/api/v1/health   # orchestrator
curl http://127.0.0.1:4100/health          # launcher
```

## Validation

For script or Node-level changes:

```sh
pnpm run doctor:runtime
```

For Elixir changes:

```sh
cd apps/orchestrator
mix compile --warnings-as-errors
mix test
```

For production live agent I/O checks, use the HTTP/SSE smoke against a local
or production orchestrator:

```sh
SUPABASE_SERVICE_ROLE_KEY=... pnpm run smoke:agent-live-io -- \
  --workspace-id <workspace-id> \
  --codex-agent-id <codex-agent-id> \
  --claude-agent-id <claude-agent-id>
```

Add `--base-url https://...` to target prod. The smoke opens `/stream`, posts
input, verifies streamed events, then starts another turn and verifies
`/interrupt` emits `turn_interrupted` for Codex and Claude Code coding agents.

## More documentation

- [`docs/`](docs/) — runtime runbooks and scoping docs
- [`apps/orchestrator/docs/`](apps/orchestrator/docs/) — orchestrator, relay,
  and scheduling docs, including the
  [local relay protocol](apps/orchestrator/docs/local-relay-protocol.md) used
  by the local runtime helper
- Database schema artifacts are generated — see the repo-level
  [Supabase guide](../docs/supabase/README.md) and regenerate with
  `pnpm run supabase:schema:sync` after migrations
