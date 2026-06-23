# Purge Custom Repo Tools Scope

## Goal

Remove the internally-created repository tool calls everywhere they can be
offered, executed, seeded, granted, tested, or reintroduced:

- `repo.list`
- `repo.search`
- `repo.read_file`
- `repo.read_symbols`

These tools should be replaced by existing command-line capability, primarily
`shell.exec`, for local models and local helper-backed agents. After the purge,
new and existing databases must not expose these tool slugs, and application
code must not register or execute them.

## Non-goals

- Do not remove general repository concepts such as repository routing,
  repository credentials, workspace repository settings, repo cache, or work
  item `repository` metadata. Those are domain concepts, not the custom tool
  calls being purged.
- Do not remove `git.run`, `shell.exec`, `apply_patch`, planner database tools,
  scheduled task tools, or agent communication tools.
- Do not preserve a compatibility alias that silently maps `repo.*` requests to
  shell commands. The desired failure mode for stale model output is
  unsupported/unknown tool, so the issue is visible.

## Replacement Behavior

Local filesystem inspection should use `shell.exec`:

- List a directory: `{"argv":["ls","-la","platform/scripts"],"cwd":"/workspace"}`
- Read a file: `{"argv":["sed","-n","1,160p","README.md"],"cwd":"/workspace"}`
- Search: `{"argv":["rg","-n","pattern","."],"cwd":"/workspace"}`
- Symbol-ish inspection: use language tooling, `rg`, `ctags`, `grep`, or
  project-native CLI commands through `shell.exec`.

The purge depends on local-relay manager sessions executing `shell.exec` on the
helper, and on the helper treating `/workspace` as the configured workspace
root. This is covered by PR #280 and should either land first or be folded into
the purge PR.

## Database Migration

Add a forward migration after the current latest migration that:

- Deletes `agent_tool_grant` rows whose `tool_id` references any purged slug.
- Deletes `tool_policy_template_tool` rows for any purged slug.
- Deletes `tool` rows for the purged slugs.
- Deletes or rewrites local tool-call eval rows/assertions that require
  `repo.*` tools.
- Is idempotent and safe when the rows are already absent.
- Includes comments explaining that the tools were intentionally retired in
  favor of command-line access through `shell.exec`.

Historical seed migrations can remain for replayability if a later migration
removes the rows. If we want literal source grep cleanliness across historical
migrations too, that should be a separate explicit decision because editing
already-applied migrations changes migration history.

## Runtime Removal Checklist

- [ ] Remove `SymphonyElixir.Planner.Tools.RepoList`,
  `RepoSearch`, `RepoReadFile`, and `RepoReadSymbols` from
  `ToolRegistry.@planner_tools`.
- [ ] Remove `repo_read_tool_names/0` and stop prepending repo tools to planner
  dynamic tools.
- [ ] Remove or repurpose `repository_tool_specs/0`; no public helper should
  return `repo.*` specs.
- [ ] Delete wrapped Codex modules in
  `runtime/apps/orchestrator/lib/symphony_elixir/tools/codex.ex` for
  `RepoList`, `RepoSearch`, `RepoReadFile`, and `RepoReadSymbols`.
- [ ] Delete planner repo tool modules:
  - `planner/repository_tools.ex`
  - `planner/repository_read_tools.ex`
  - `planner/tools/repository_tool.ex`
  - `planner/tools/repo_list.ex`
  - `planner/tools/repo_search.ex`
  - `planner/tools/repo_read_file.ex`
  - `planner/tools/repo_read_symbols.ex`
- [ ] Remove `SymphonyElixir.Planner.RepositoryIndex` from the application
  supervision tree if it is only used by `repo.read_symbols`.
- [ ] Delete `planner/repository_index.ex` if no non-tool runtime code still
  needs it.
- [ ] Remove repo-tool-specific prompt text from planner/local coding runners.
- [ ] Remove repo-tool workspace-id injection branches from planner/local
  coding tool executors.
- [ ] Remove `repo.*` from local-relay helper tool lists and schema-stripping
  branches in:
  - `gateway/chat_runner.ex`
  - `runner/llm_tool_runner.ex`
- [ ] Keep or add `shell.exec` helper execution for local-relay managers.
- [ ] Ensure stale `repo.*` tool calls normalize to unsupported/unknown tool,
  not fallback execution.

## Local Runtime Helper Checklist

- [ ] Remove `repo.list`, `repo.read_file`, and `repo.search` dispatch cases
  from `local-runtime-helper/internal/tools/local_executor.go`.
- [ ] Delete local helper repo executor implementation if it is only used by
  those dispatch cases.
- [ ] Remove helper tests that exercise repo tool execution.
- [ ] Keep tests for `shell.exec` directory listing, file reading, and search
  commands through the CLI.
- [ ] Keep runtime-managed/tool-call parsing tests generic by using non-repo
  tool examples.

## Platform Checklist

- [ ] Remove `repo.*` from `platform/apps/api/src/services/tool-bundles.ts`.
- [ ] Remove default grants/policies in
  `platform/apps/api/src/services/setup/builders/tool-policy.ts`.
- [ ] Delete or replace `local-repo-tool-executor.ts`; no dev endpoint should
  execute `repo.*`.
- [ ] Remove `repo.*` routing from `dev-tool-invocation.ts`.
- [ ] Update `platform/contracts/local-model-coding.ts` to remove repo tool
  discriminated union members and schemas.
- [ ] Update smoke scripts and manual eval defaults to use `shell.exec`:
  - `platform/scripts/smoke-agent-tool-call.mjs`
  - `platform/apps/api/scripts/agent-test-state.ts`
  - local tool-call eval catalog rows
- [ ] Update agent/default-tool tests so manager/coding/planner defaults do not
  include `repo.*`.
- [ ] Update UI examples/placeholders that mention `repo.read_file`.

## Test Cleanup Checklist

Remove or rewrite tests whose purpose is now invalid:

- [ ] `runtime/apps/orchestrator/test/symphony_elixir/planner/repository_tools_test.exs`
- [ ] `runtime/apps/orchestrator/test/symphony_elixir/planner/repository_read_tools_test.exs`
- [ ] `runtime/apps/orchestrator/test/symphony_elixir/planner/repository_index_test.exs`
- [ ] `runtime/apps/orchestrator/test/symphony_elixir/tool_registry_planner_test.exs`
- [ ] `runtime/apps/orchestrator/test/symphony_elixir/tool_registry_local_model_coding_test.exs`
- [ ] `runtime/apps/orchestrator/test/symphony_elixir/local_model_coding_tool_contract_test.exs`
- [ ] `runtime/apps/orchestrator/test/symphony_elixir/dynamic_tool_test.exs`
- [ ] `runtime/apps/orchestrator/test/symphony_elixir/runner/planner/session_test.exs`
- [ ] `runtime/apps/orchestrator/test/symphony_elixir/runner/planner/responses_api_test.exs`
- [ ] `platform/apps/api/src/services/local-repo-tool-executor.test.ts`
- [ ] `local-runtime-helper/internal/tools/local_executor_test.go` repo-tool cases

Rewrite generic parser/provider tests that currently use repo tools as sample
names, but do not actually test repository behavior:

- [ ] `tool_adapter_test.exs`
- [ ] `provider/openai_compatible_test.exs`
- [ ] `tool-call-parser.test.ts`
- [ ] `tool-spec-translator.test.ts`
- [ ] `dispatch_runtime_managed_test.go`
- [ ] `dispatch_helper_managed_test.go`

## Documentation Checklist

- [ ] Update active docs that instruct users/agents to call `repo.*`.
- [ ] Move repo-tool architecture docs to superseded or update them with a
  retirement note.
- [ ] Update local model/manual testing docs to show `shell.exec` examples.
- [ ] Keep historical context only where clearly marked superseded.

## Verification Plan

- [ ] `rg -n "repo\\.(list|search|read_file|read_symbols)|repo_list|repo_search|repo_read_file|repo_read_symbols" runtime/apps/orchestrator/lib runtime/apps/orchestrator/test platform/apps platform/contracts platform/scripts local-runtime-helper/internal`
  returns no active implementation or test expectation references.
- [ ] Runtime focused tests pass:
  - `mix test test/symphony_elixir/runner/manager/local_relay_test.exs`
  - `mix test test/symphony_elixir/runner/local_model_coding_test.exs`
  - `mix test test/symphony_elixir/tool_registry_test.exs`
- [ ] Platform focused tests pass:
  - `pnpm -C platform test -- --run` or targeted service/contract tests if the
    full suite is too large for the turn.
- [ ] Helper tests pass:
  - `go test ./...` in `local-runtime-helper`
- [ ] Local live manual test passes:
  - Manager attached to local model uses `shell.exec` to list a directory.
  - Manager uses `shell.exec` + `rg` to search files.
  - No `repo.*` tool appears in resolved/advertised tool definitions.
- [ ] Migration verification:
  - Existing DB after migration has zero `tool.slug` rows for purged slugs.
  - Existing DB after migration has zero grants/templates referencing purged
    tool ids.
  - Fresh DB replay also ends with zero purged tool rows.

## Open Decisions

- Should the purge PR edit historical migrations for grep cleanliness, or rely
  on a later migration to remove rows after replay? Default recommendation:
  do not edit historical migrations; add a purge migration and add tests that
  assert final state.
- Should `repo.read_symbols` retirement also remove the repository index worker
  entirely, or is there another non-tool consumer worth preserving? Current
  inventory suggests it can be removed if no hidden consumer exists.
- Should local tool-call eval rows be deleted or replaced with `shell.exec`
  cases? Default recommendation: replace them so the eval suite continues to
  prove the intended CLI-based workflow.
