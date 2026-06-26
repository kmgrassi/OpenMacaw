# Frontend Data Refresh and React Query Scope

Status: draft

## Problem

The web UI can show stale data after agent, tool, message, runtime, plan, work
item, credential, or local model updates. The current frontend does not have a
single data cache or invalidation model. Instead, each route or hook owns its
own `useState`, `useEffect`, `load()`, `reload()`, polling timer, optimistic
patch, or Zustand store refresh.

That makes correctness depend on the current screen remembering to call the
right reload function. Updates made by another component, a background runtime
event, a different tab, or a mutation in a sibling surface often do not refresh
all affected UI.

React Query has solved this class of problem well in past projects. It is not
currently installed in `apps/web/package.json`; this scope proposes adding
`@tanstack/react-query` and migrating API reads/mutations behind query keys and
invalidation.

## Goals

- Add one query cache for server state in the web app.
- Keep API boundary shapes camelCase and continue using existing typed
  `apps/web/src/api/*` clients.
- Replace ad hoc `load()`/`reload()` state with query hooks for API-backed
  data.
- Invalidate every affected query after mutations and runtime events.
- Keep Zustand only for local UI/session state, not durable API data.
- Make message, agent, tool, plan, and runtime updates visible without manual
  browser refresh.
- Preserve current browser verification expectations for UI changes.

## Non-goals

- Do not change API response shapes only to fit React Query.
- Do not add backwards-compatibility adapters for old frontend data shapes.
- Do not move Supabase auth out of the frontend in this scope.
- Do not replace the Gateway/WebSocket client; bridge its events into query
  invalidation instead.

## Current Inventory

React Query package state:

- `apps/web/package.json` has React 19, Zustand, React Router, Zod, and
  Supabase client dependencies.
- `@tanstack/react-query` is not installed.

High-impact stale-data areas:

- `apps/web/src/stores/agents.ts` stores the canonical agent list in Zustand and
  manually reloads after create, update, delete, and credential mutations.
- `apps/web/src/hooks/useAgents.ts` separately loads stored agents with local
  component state, duplicating the Zustand store.
- `apps/web/src/routes/Dashboard.tsx` manually fetches setup, health, and
  runtime agent state; stop and refresh actions duplicate the same fetch bundle.
- `apps/web/src/hooks/useAgentDashboard.ts` has a custom dashboard state store,
  run/task aggregation, page state, version polling, and delayed refresh logic.
- `apps/web/src/hooks/useChat.ts` loads message history into local state and
  reloads only the active transcript after final runtime events.
- `apps/web/src/hooks/useSessions.ts` loads orchestrator sessions only when the
  gateway connects and after local reset calls.
- `apps/web/src/hooks/useToolDefinitions.ts` loads tool settings and manually
  reloads after tool/grant/template mutations.
- `apps/web/src/components/agent-settings/ToolDefinitionsPanel/useToolAssignments.ts`
  separately fetches local model readiness.
- `apps/web/src/routes/WorkspaceItems.tsx` owns plan and work-item state
  locally, then patches arrays manually after deletes and work-item updates.
- `apps/web/src/components/settings/LocalModelsSection/useLocalModelsPage.ts`
  owns local model state, polls every two seconds, and separately reloads
  agents for binding state.
- `apps/web/src/components/settings/ManagerAgentSection/useManagerAgentConfig.ts`
  manually loads manager config and plan options, then calls a parent
  `loadStatus()` after mutations.
- `apps/web/src/components/settings/RuntimeSection.tsx` manually loads
  orchestrator sessions, worker sessions, diagnostics, and health.
- Settings surfaces for credentials, scheduled tasks, manager status, model
  catalog, OAuth, smoke tests, and onboarding have one-off fetch state that
  should either move to React Query or stay explicitly action-only.

## Query Key Model

Create one query key module, for example `apps/web/src/api/query-keys.ts`, with
factory functions instead of string literals spread through components.

Initial key families:

- `auth.state()`
- `agents.list(workspaceId)`
- `agents.detail(agentId)`
- `agents.runtimeProfile(agentId, workspaceId)`
- `setup.byAgent(agentId)`
- `agentHealth.detail(agentId)`
- `agentDashboard.latestRun(agentId)`
- `agentDashboard.runHistory(agentId, page)`
- `agentDashboard.tasks(agentId, runIds)`
- `agentDashboard.configState(agentId, workspaceId)`
- `messages.history(agentId, sessionKey)`
- `sessions.orchestrator(scopeKey)`
- `sessions.worker()`
- `tools.agent(agentId, workspaceId)`
- `tools.catalog(workspaceId)`
- `localModels.list(workspaceId)`
- `plans.list(workspaceId)`
- `workItems.list(workspaceId)`
- `manager.status(workspaceId)`
- `manager.config(workspaceId, agentId)`
- `scheduledTasks.list(workspaceId, agentId)`
- `credentials.resolved(scope)`
- `models.catalog(workspaceId)`

Mutation hooks should invalidate by key family, not by component callback.

## PR Plan

### PR1: React Query Foundation

Repository: `parallel-agent-platform`

Add the dependency and app-level provider.

Scope:

- Add `@tanstack/react-query` to `apps/web`.
- Wrap `apps/web/src/main.tsx` with `QueryClientProvider`.
- Define cache defaults for the app:
  - short stale times for runtime/message/dashboard data
  - longer stale times for static catalog/config lists
  - bounded retries for idempotent GETs
  - no retries for auth/permission failures
- Add `query-keys.ts`.
- Add lightweight helpers for invalidating key families from mutations.
- Decide whether React Query Devtools should be dev-only or omitted initially.

Acceptance:

- Existing app routes still render.
- `pnpm exec tsc --noEmit -p apps/web/tsconfig.app.json` passes.
- No API client behavior changes.

### PR2: Agents, Auth Bootstrap, and Setup Queries

Repository: `parallel-agent-platform`

Move agent and setup data reads onto React Query first because stale agents
break navigation, settings, onboarding nudges, dashboard routing, and tool
configuration.

Scope:

- Replace duplicate `useAgents.ts` and `useAgentsStore` server-state ownership
  with `useAgentsQuery()` plus mutation hooks:
  - create agent
  - update agent
  - delete agent
  - save credential/reference
- Keep Zustand only for selected agent id and local UI preferences.
- Convert auth bootstrap reads from `fetchSetupAuthState()` to a query-aware
  flow while preserving Supabase auth session handling in `stores/auth.ts`.
- Add query hooks for:
  - stored agents
  - setup by agent
  - agent health
  - agent runtime profile
- Invalidate `auth.state`, `agents.list`, `setup.byAgent`, and
  `agentHealth.detail` after agent, credential, default-agent assignment, and
  runtime-profile mutations.

Affected areas:

- `apps/web/src/stores/auth.ts`
- `apps/web/src/stores/agents.ts`
- `apps/web/src/hooks/useAgents.ts`
- `apps/web/src/components/AppShell.tsx`
- `apps/web/src/components/settings/AgentsSection.tsx`
- `apps/web/src/components/settings/AgentDetail/**`
- `apps/web/src/components/settings/AgentCredentials.tsx`
- `apps/web/src/components/dashboard/InlineCredentialForm.tsx`

Acceptance:

- Agent create/update/delete immediately updates sidebar, settings list, and
  dashboard setup state.
- Saving credentials updates agent configuration badges without browser
  refresh.
- No component imports `listStoredAgents()` directly outside query hooks or
  mutation hooks.

### PR3: Dashboard, Runtime Health, and Run Data

Repository: `parallel-agent-platform`

Refactor the dashboard and debug run panels to use query composition instead of
manually coordinated local state.

Scope:

- Convert `Dashboard.tsx` setup, health, and runtime-agent reads to queries.
- Convert `useAgentDashboard()` to queries for latest run, run history, tasks,
  gateway config state, and dashboard version.
- Preserve the derived run/task summaries as memoized selectors over query
  results.
- Replace manual refresh buttons with `queryClient.invalidateQueries()`.
- Convert stop-worker-session actions to mutations that invalidate setup,
  health, worker sessions, runtime agents, and dashboard keys.
- Keep dashboard version polling if the API remains version-based, but make it
  invalidate dashboard queries instead of calling a private `load()`.

Affected areas:

- `apps/web/src/routes/Dashboard.tsx`
- `apps/web/src/hooks/useAgentDashboard.ts`
- `apps/web/src/components/AgentDashboardPanel.tsx`
- `apps/web/src/components/AgentDashboardPanel/**`
- `apps/web/src/components/dashboard/EngineInstanceCard.tsx`
- `apps/web/src/components/dashboard/RuntimeDebugCard.tsx`

Acceptance:

- Stopping or refreshing an engine updates setup, health, runtime debug, latest
  run, and run history consistently.
- Dashboard polling no longer maintains a separate copy of dashboard state.
- Run history pagination remains stable.

### PR4: Messages, Sessions, and Gateway-Driven Invalidation

Repository: `parallel-agent-platform`

Make message history and session lists first-class cached data, then bridge
runtime events into cache invalidation.

Scope:

- Add `useMessagesQuery(agentId, sessionKey)` for transcript history.
- Add `useSendMessageMutation()` and `useAbortMessageMutation()`.
- Keep streaming deltas local to `useChat()` because they are ephemeral UI
  state, but merge them with cached message history in the hook return value.
- On `chat.send`, optimistically append the user message to the message-history
  query.
- On final, abort, provider error, or runtime error events, invalidate:
  - `messages.history(agentId, sessionKey)`
  - `sessions.orchestrator(...)`
  - `agentDashboard.*(agentId)`
  - `setup.byAgent(agentId)` when runtime readiness can change
- Convert `useSessions()` to React Query.
- Add a small Gateway invalidation bridge near `GatewayProvider` so background
  runtime events refresh the relevant cached data even if the current component
  is not the one that initiated the action.

Affected areas:

- `apps/web/src/hooks/useChat.ts`
- `apps/web/src/hooks/useSessions.ts`
- `apps/web/src/context/GatewayContext.tsx`
- `apps/web/src/context/GatewayContext/**`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/SessionList.tsx`
- `apps/web/src/components/RuntimeEventTimeline.tsx`

Acceptance:

- Sending a message shows the optimistic user message, streamed assistant text,
  and final persisted assistant message without duplicate rows.
- Switching away and back to a transcript shows final persisted messages.
- Session list ordering/counts refresh after message activity and reset.
- Runtime/tool events refresh dashboard run data without manual reload.

### PR5: Tool Definitions, Grants, Templates, and Local Execution Readiness

Repository: `parallel-agent-platform`

Tool updates are one of the most visible stale-data failures. Migrate the whole
agent-tool settings surface together so grants, catalogs, templates, and local
execution readiness share invalidation.

Scope:

- Convert `useToolDefinitions()` to a query for `listAgentTools`.
- Add mutations for:
  - create tool
  - update tool
  - delete tool
  - include/exclude/delete grant
  - apply template
  - reorder tools
- Invalidate `tools.agent`, `tools.catalog`, `agents.list`, `setup.byAgent`,
  and `agentDashboard.configState` after tool/grant mutations.
- Move `listLocalModels()` readiness read in `useToolAssignments()` onto the
  shared `localModels.list(workspaceId)` query.
- Preserve local draft assignment state as component state.

Affected areas:

- `apps/web/src/hooks/useToolDefinitions.ts`
- `apps/web/src/components/agent-settings/ToolDefinitionsPanel.tsx`
- `apps/web/src/components/agent-settings/ToolDefinitionsPanel/**`

Acceptance:

- Creating, editing, deleting, assigning, unassigning, templating, or
  reordering tools refreshes the agent tool list and any setup/config status
  that depends on it.
- Local execution readiness updates from the same local-model cache used by the
  local models settings page.

### PR6: Plans, Work Items, Manager Config, and Scheduled Work

Repository: `parallel-agent-platform`

Plans, work items, and manager config are linked: manager due-task config reads
plans, work items can be snoozed/woken, and manager status depends on scheduled
work.

Scope:

- Convert `WorkspaceItems.tsx` to `plans.list` and `workItems.list` queries.
- Add mutations for create/delete plan, delete work item, snooze, and wake.
- Invalidate plan and work-item keys after every plan/work-item mutation.
- Convert manager config plan-option reads to `plans.list`.
- Convert manager status/config and scheduled tasks to queries and mutations.
- Invalidate manager status/config and scheduled-task keys after manager config
  changes.

Affected areas:

- `apps/web/src/routes/WorkspaceItems.tsx`
- `apps/web/src/pages/plans/NewPlan.tsx`
- `apps/web/src/routes/WorkspaceItems/**`
- `apps/web/src/components/work-items/**`
- `apps/web/src/components/settings/ManagerAgentSection/**`
- `apps/web/src/api/scheduled-tasks.ts`

Acceptance:

- Creating or deleting a plan updates plan lists, work-item counts, and manager
  plan selectors.
- Snoozing or waking a work item updates all visible work-item lists.
- Manager config changes refresh manager status without parent callback chains.

### PR7: Local Models, Credentials, Catalogs, and Onboarding Surfaces

Repository: `parallel-agent-platform`

Migrate the remaining settings/onboarding data surfaces that influence agent
readiness.

Scope:

- Convert local model list/config/probe/assignment/rotation/remove flows to
  query hooks and mutations.
- Convert resolved credentials, credential editor, OAuth status, and credential
  picker reads to query hooks where they display persisted server state.
- Convert model catalog/provider reads to queries with longer stale times.
- Convert onboarding cards that call setup/auth/local-helper endpoints to
  query/mutation hooks where the response affects app state.
- Invalidate agents, auth state, setup, local models, credentials, and model
  catalog keys according to mutation impact.

Affected areas:

- `apps/web/src/components/settings/LocalModelsSection/**`
- `apps/web/src/hooks/useResolvedCredentials.ts`
- `apps/web/src/components/settings/CredentialEditor.tsx`
- `apps/web/src/components/settings/CredentialPicker.tsx`
- `apps/web/src/components/settings/ModelsSection.tsx`
- `apps/web/src/components/OnboardingCards/**`
- `apps/web/src/stores/onboarding.ts`

Acceptance:

- Local model registration, removal, token rotation, and agent binding update
  local-model, agent, and setup views immediately.
- Credential changes update all readiness surfaces that depend on them.
- Static model/provider catalogs are cached instead of reloaded per component.

### PR8: Runtime Diagnostics and Debug Surfaces

Repository: `parallel-agent-platform`

Migrate lower-frequency diagnostic reads after user-facing data paths are
stable.

Scope:

- Convert `RuntimeSection.tsx` reads to queries:
  - orchestrator session summary
  - worker sessions and details
  - agent diagnostics
  - agent health
- Convert worker stop actions to mutations with worker-session, runtime, setup,
  and health invalidation.
- Convert diagnostic export prerequisites to query reads where appropriate.
- Keep explicit manual refresh buttons, but implement them as invalidations.

Affected areas:

- `apps/web/src/components/settings/RuntimeSection.tsx`
- `apps/web/src/components/DiagnosticsExportButton.tsx`
- `apps/web/src/api/agent-diagnostic.ts`
- `apps/web/src/api/worker-bridge.ts`
- `apps/web/src/api/orchestrator-sessions.ts`

Acceptance:

- Runtime diagnostics update after gateway reconnect, worker stop, and manual
  refresh.
- Debug-only queries are disabled when debug mode is off.

### PR9: Freshness Policy, Event Map, and Cleanup

Repository: `parallel-agent-platform`

After the main migrations, harden the data-refresh model and remove obsolete
patterns.

Scope:

- Define freshness policies by data class:
  - message/runtime/dashboard: short stale time and event invalidation
  - setup/agents/tools/work-items: invalidation-driven, modest stale time
  - catalogs/templates/static config: longer stale time
- Add a typed Gateway event-to-query invalidation map.
- Add production cross-tab cache invalidation so updates in one browser tab
  refresh relevant cached API data in other open tabs or windows.
- Audit all direct component calls to `apiFetch`, `brokerFetch`, and API client
  functions. Either move them behind query/mutation hooks or document why they
  are action-only.
- Remove duplicate `load()`/`reload()` patterns that now wrap queries.
- Add focused tests for query-key factories and invalidation helper behavior.
- Add docs for how new frontend data reads and mutations should be written.

Acceptance:

- No API-backed screen owns duplicate durable server state with `useState`
  unless explicitly documented.
- Query keys and invalidation helpers cover every mutation that can change
  visible UI data.
- Agent, tool, credential, setup, plan, work-item, and local-model updates in
  one browser tab refresh matching cached UI in other tabs without a full page
  reload.
- Gateway event invalidation is scoped by event type, workspace id, agent id,
  session key, run id, and entity ids where available.
- Manual refresh buttons remain useful but are no longer required for normal
  correctness.

## Cross-cutting Implementation Rules

- Keep existing typed API functions in `apps/web/src/api/*`; React Query hooks
  should call those functions instead of building URLs in components.
- Do not move API casing conversion into the web layer.
- Prefer exact invalidation over global cache clearing.
- Treat the Gateway as the source of live runtime events. Runtime-driven UI
  updates should be triggered by Gateway events, then refetch persisted data
  from API query functions as needed.
- Runtime events that materially change persisted application data should
  invalidate the corresponding API-backed queries in a targeted way. Runtime
  invalidation must be idempotent and must not create loops where a refetch
  result emits another invalidation event.
- Treat the API as the source of static and persisted application data,
  including agents, tools, credentials, setup, plans, work items, local models,
  manager config, and scheduled tasks.
- Use optimistic updates only when the mutation result is predictable. Prefer
  invalidation for setup, health, runtime, and dashboard state.
- Use `enabled` guards instead of returning fake data when required ids are
  missing.
- Keep streaming text, selected rows, open panels, forms, filters, and draft
  tool assignments in local component state.
- Keep Supabase auth session lifecycle in the auth store; use React Query for
  server-derived auth/setup state after the broker session exists.
- This is production product behavior, not a dev-only feature. Do not gate the
  React Query provider, query hooks, invalidation bridge, or migrated data paths
  behind `import.meta.env.DEV`.

## Verification

Each PR that affects UI behavior must follow the repo UI verification process:

1. Run `pnpm exec tsc --noEmit -p apps/web/tsconfig.app.json`.
2. Start `pnpm run dev`.
3. Open `http://localhost:5173`.
4. Log in with the dev credentials button if routed to `/login`.
5. Verify the changed screens visually and check the browser console.
6. Test both the initial load and a mutation/update path that should refresh
   other visible data.

For API-touching PRs, also run:

```bash
pnpm -C apps/api run validate
```

## Decisions

- Gateway events are the primary signal for live runtime changes. They should
  trigger invalidation for runtime-derived data such as message history,
  sessions, run history, task rows, dashboard state, and runtime health.
- API queries are the source for static and persisted application data. Agent,
  tool, credential, setup, plan, work-item, local-model, manager-config, and
  scheduled-task updates should be fetched from API endpoints and invalidated
  after API mutations.
- React Query itself and the data-refresh migration are production scope. Do
  not hide the new data layer behind development flags.
- Do not add React Query Devtools as part of the initial production rollout.
  If debugging tools are needed later, scope them separately from the product
  data-refresh implementation.
- Cross-tab invalidation is required production behavior. If a user updates an
  agent, tool, credential, setup value, plan, work item, local model binding, or
  manager config in one tab, other open tabs should refresh affected menus,
  dashboards, settings panels, and lists without a browser refresh.
- Runtime events that change persisted state should trigger smart, scoped
  invalidations for affected API data. Use event payload ids and versions where
  possible to avoid broad refreshes and infinite invalidation loops.

## Clarifications

### Cross-tab invalidation

Cross-tab invalidation means keeping React Query caches synchronized across
multiple browser tabs or windows. Example: a user opens the agent settings in
one tab and the dashboard in another tab. If they update an agent in the
settings tab, the dashboard tab will not automatically know unless we add a
cross-tab mechanism such as `broadcastQueryClient`, browser storage events, or
another shared signal. This is required for this refactor: persisted API data
that affects menus, dashboards, settings panels, and lists should refresh
across tabs when it changes.

### Runtime events invalidating work items

Runtime events invalidating work items means deciding whether a Gateway event
from an agent run should cause plan or work-item API queries to refetch. For
example, a future manager-agent run might create a work item, move a work item
to another state, snooze or wake one, attach a plan review, or mark work as
ready for review. If those changes happen as part of runtime execution, the
Gateway event should tell the web app enough to invalidate `plans.list` and/or
`workItems.list`. If the runtime event only represents chat token streaming,
worker logs, tool-call progress, or run status, it should refresh message,
session, dashboard, and runtime queries, but not plan/work-item lists.

The event-to-query map should avoid infinite loops by making invalidation a
one-way reaction to Gateway events and API mutations. A React Query refetch
should update cached data, but it should not emit a new Gateway-style
invalidation event. Where the Gateway supplies event ids, run ids, entity ids,
or versions, the invalidation bridge should use them to dedupe repeated events
and only refresh affected query families.
