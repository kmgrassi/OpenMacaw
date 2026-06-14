# Local-relay chat sends the agent's granted tools

## Problem

The production tool-quality battery (`eval:local-tool-calling`) scored a local
model 3/8. The failures all looked like the model picking the wrong tool —
e.g. asked to "use repo.search", it called `git.run` (`git grep`). Tracing the
gateway dispatch showed the real cause: the model was **never offered** the
expected tools.

`chat_runner.ex`'s `local_relay_config` sent a hardcoded
`ToolRegistry.bundle(:universal)` + `git.run` as the model's tool surface —
just `{workspace_settings.manage, snooze_work_item, git.run, ...}`. It did
**not** include the agent's actually-granted tools (`repo.*`, `shell.exec`,
`scheduled_task.*`), which is what the eval (and the agent's
`agent_tool_grant` rows) expect. The code even flagged this: *"the universal
bundle is the default chat tool surface until agent-grant-driven tool filtering
lands."*

## Changes

1. **`chat_runner.ex`** — `local_relay_config` now builds `tool_definitions`
   from the agent's **granted** tools (`ToolRegistry.resolve_for_agent/1`),
   keeping the `git.run` → `execution_kind: helper` marking so it still runs on
   the user's machine. Falls back to the universal bundle + `git.run` for
   agents with no grants (prior behavior preserved).

2. **`tool_registry.ex`** — `resolve_for_agent/1` no longer uses a PostgREST
   embedded join (`tool!inner(slug,enabled)`). That embed requires the
   `agent_tool_grant -> tool` foreign key in PostgREST's schema cache, which is
   **absent in production** (the query 400s with PGRST200), so the resolver was
   failing there. It now does two queries — granted `tool_id`s, then their
   slugs from the `tool` catalog — mirroring the platform's resolver. Verified
   against prod: the eval agent resolves all 11 granted tools.

## Verification

- `mix compile --warnings-as-errors` clean; `tool_registry` suite 15/15.
- Live prod check: `resolve_for_agent("<eval-agent>")` returns
  `repo.read_file/list/search`, `git.run` (marked helper), `shell.exec`,
  `apply_patch`, `scheduled_task.*` — the same 11 the eval resolves.
- Pending after deploy: re-run `eval:local-tool-calling --run` against prod to
  measure the local model's *real* tool-selection score now that it receives
  the right tools.
