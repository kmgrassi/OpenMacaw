# Local Tool-Calling Evals

OpenMacaw includes a database-backed evaluation battery for validating tool
calling against locally running models. The built-in catalog is seeded by:

```text
platform/supabase/migrations/20260604161000_seed_local_tool_call_eval_catalog.sql
```

The migration creates a global, system-managed `agent_eval_suite` with slug
`local-tool-calling`, plus `agent_eval_case` and
`agent_eval_case_assertion` rows for the individual tests. The runner loads the
suite from those tables and only uses the legacy JSON battery for the older
manager smoke command.

## What It Covers

Enabled-by-default cases are read-only or intentionally harmless:

- local helper tools: `git.run`, `shell.exec`
- database read tool: `scheduled_task.list`
- negative cases where the model should not call any tool

Mutation cases such as `apply_patch` and `scheduled_task.create` are present but
disabled by default. Run them only when you intend to allow local or database
state changes.

## Dry Run

From `platform/`, inspect the selected cases and the tools granted to the target
agent:

```sh
pnpm run eval:local-tool-calling
```

This command requires the `agent_eval_*` migrations to be applied to the target
Supabase project and needs `SUPABASE_URL` plus `SUPABASE_SERVICE_ROLE_KEY` in
the local platform environment so it can read the eval catalog and persisted
tool-call evidence.

The runner needs the same local environment as the platform API. It reads env
from `platform/.env`, `platform/apps/api/.env`, `platform/apps/web/.env`, and
`platform/apps/web/.env.local`.

Set the target agent and workspace with either CLI flags or environment
variables:

```sh
OPENMACAW_AGENT_ID=<agent-id> \
OPENMACAW_WORKSPACE_ID=<workspace-id> \
pnpm run eval:local-tool-calling
```

For a disposable local-model coding agent, seed one first:

```sh
pnpm run agent:test-seed -- \
  --workspace-id <workspace-id> \
  --kind coding \
  --provider <provider> \
  --model <model> \
  --runner-kind local_model_coding \
  --json
```

Use the returned `agentId` with the eval runner.

## Live Run

Start the local platform API, web app, runtime, and local model first. Then run:

```sh
OPENMACAW_AGENT_ID=<agent-id> \
OPENMACAW_WORKSPACE_ID=<workspace-id> \
pnpm run eval:local-tool-calling -- --run
```

To run one case:

```sh
pnpm run eval:local-tool-calling -- --run --case repo-read-file-readme
```

To include disabled mutation cases:

```sh
pnpm run eval:local-tool-calling -- --run --include-disabled
```

Each live run writes sanitized artifacts under:

```text
platform/.run-artifacts/manager-tool-call-battery/
```

## Assertions

The runner currently supports deterministic tool-call assertions:

- `tool_call_observed`: at least one matching persisted tool call must appear.
- `no_tool_call`: no persisted tool calls may appear.

Assertions may include `argumentHints` for lightweight checks that the model
emitted the expected argument content. These hints are diagnostic guardrails, not
a replacement for typed argument validation.
