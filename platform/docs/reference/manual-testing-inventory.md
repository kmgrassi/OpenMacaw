# Manual Testing Inventory

This is the starting inventory of manual QA flows for OpenMacaw. It is broader
than the local smoke runbook: the goal is to list the app surfaces a human
tester should exercise when validating that the product works in full.

Use this alongside:

- [Testing strategy](./testing-strategy.md) for the canonical "app is working"
  story and automation gaps.
- [End-to-end local runbook](./end-to-end-local-runbook.md) for exact local
  boot, login, and first-message setup.
- The runtime and local-helper guides when validating relay, scheduler, or
  local model behavior.

## Test Matrix

Run the critical path in every environment under test:

| Area | Local full stack | Hosted/staging | Production smoke |
| --- | --- | --- | --- |
| Process health | Required | Required | Required |
| Auth and onboarding | Required | Required | Required |
| Agent dashboard and chat | Required | Required | Required |
| Settings read/write | Required | Required | Sampled |
| Plans and work items | Required | Required | Sampled |
| Manager scheduled work | Required when changed | Required when changed | Smoke only |
| Local runtime helper | Required when changed | N/A unless relay target exists | N/A |
| Deployment checks | N/A | Required | Required |

For browser passes, test desktop and a narrow viewport. Verify there are no
console errors, no request loops, no blank screens, and no overlapping or
truncated controls.

## Baseline Environment And Health

### Local stack startup

Setup:

- Supabase is configured and migrated.
- `platform/.env`, `runtime/.env`, and any local helper config are populated.
- No unrelated service is occupying the OpenMacaw ports.

Steps:

1. Run `./openmacaw doctor`.
2. Start the stack with `./openmacaw run`.
3. Open the web app at `http://127.0.0.1:5173`.
4. Check process health:
   - `http://127.0.0.1:3100/livez`
   - `http://127.0.0.1:4000/api/v1/health`
   - `http://127.0.0.1:4100/health`
5. Run `./openmacaw status`.
6. Stop the stack with `./openmacaw stop`, then confirm status reports stopped
   services.

Pass criteria:

- Doctor calls out only real missing prerequisites or config.
- The stack boots without crash loops.
- Health endpoints return success while running.
- Stop/status behave consistently.

### Hosted environment smoke

Steps:

1. Open the deployed web URL in a clean browser profile.
2. Confirm the API liveness endpoint for the environment responds.
3. Confirm the app loads without mixed-content, CORS, or CSP failures.
4. Confirm authenticated routes redirect unauthenticated users to login.
5. Compare the deployed image SHA with the expected application commit SHA.

Pass criteria:

- The deployed app matches the intended commit.
- Login, API calls, and websocket upgrade paths work from the deployed origin.

## Authentication And First Run

### Login

Steps:

1. Open `/login` signed out.
2. Sign in with valid credentials.
3. If dev credentials are configured locally, use the "Use dev credentials"
   button.
4. Reload the page.
5. Sign out, then revisit an authenticated route such as `/settings/agents`.
6. Try invalid credentials.

Pass criteria:

- Valid credentials enter the app and preserve session state after reload.
- Invalid credentials show a useful error.
- Signed-out users cannot access authenticated app routes.
- The app does not get stuck in a redirect loop.

### Sign-up

Steps:

1. Open `/signup`.
2. Create a user in an environment where test sign-up is allowed.
3. Validate both Supabase auth modes if relevant:
   - immediate session when email confirmation is disabled
   - confirmation message when email confirmation is enabled
4. Try duplicate email and invalid email/password input.

Pass criteria:

- The UI matches the configured auth behavior.
- Errors are readable and do not expose secrets.

### First-run onboarding

Steps:

1. Use a fresh test user or reset the user's default-agent onboarding state.
2. Open `/` and confirm routing to `/onboarding`.
3. Choose the cloud model path.
4. Add or select a cloud provider credential.
5. Continue to launch and open the dashboard.
6. Repeat with the local model path:
   - view helper instructions
   - continue when a helper is available
   - skip when no helper is available

Pass criteria:

- Onboarding creates or resolves the planning, coding, and manager agents.
- Required configuration is written once and reflected on reload.
- Cloud and local paths both have clear progress, back, continue, and error
  states.
- Completed onboarding routes the user to `/dashboard/:agentId`.

## App Navigation And Shell

Steps:

1. Open `/`, `/app`, `/work`, `/settings`, `/settings/agents`, and a known
   `/dashboard/:agentId`.
2. Use the left navigation, agent switcher, and settings section links.
3. Exercise unknown routes and stale IDs.
4. Resize to mobile width and repeat key navigation.

Pass criteria:

- Routes land on the expected screens.
- Unknown routes recover to a useful default route.
- Active nav state and agent selection are correct.
- Mobile navigation remains usable.

## Agent Dashboard And Chat

### Dashboard load and status

Steps:

1. Open `/dashboard/:agentId` for each default agent type:
   - planning
   - coding
   - manager
   - any custom agent
2. Check configuration status, engine/runtime status, health widget, and setup
   requirements.
3. Toggle focus/debug modes where available.
4. Refresh the runtime status and stop an active worker bridge session when
   one exists.

Pass criteria:

- Configured agents show a ready or running state.
- Unconfigured agents show exact missing requirements.
- Health and diagnostic panels do not contradict each other.
- Stop/refresh mutations update the screen without reload.

### Runtime chat

Steps:

1. Send a short message.
2. Send a multi-paragraph message.
3. Send a message that should use a tool, such as creating a simple plan with
   one work item.
4. Interrupt by navigating away and back.
5. Reload after a response.
6. Test provider/config failure states by using a test agent with missing or
   invalid credentials.

Pass criteria:

- The websocket connects and streams a response or deterministic error.
- User and assistant messages render in order.
- Tool call progress and failures are visible enough to diagnose.
- Reload does not corrupt state or duplicate sends.
- Missing credentials and runtime failures are actionable.

### Agent run history and observability

Steps:

1. Generate at least one agent turn with tool events.
2. Inspect latest run and run history panels.
3. Check tool event rows for status, timing, and error details.
4. Verify the same activity appears in API/runtime logs with traceable IDs.

Pass criteria:

- Recent runs appear without manual DB inspection.
- Failed runs preserve useful failure details.
- User-facing logs do not leak secret values.

## Settings

### Agents

Steps:

1. Open `/settings/agents`.
2. Create a custom agent from `/settings/agents/new`.
3. Edit agent identity fields.
4. Open an existing agent by ID.
5. Change provider, model, model tier floor, and fallback chain.
6. Save with and without required credentials.
7. Configure a local runtime target.
8. Set or validate workspace path / execution target.
9. Delete a disposable custom agent.

Pass criteria:

- The list, detail route, and new-agent route stay in sync.
- Dirty/saved state is accurate.
- Invalid configuration is blocked with specific errors.
- Default agents cannot be damaged by custom-agent-only destructive actions.

### Credentials and providers

Steps:

1. Open `/settings/models`.
2. Add credentials for each supported provider available in the test
   environment.
3. Validate a credential.
4. Replace a credential.
5. Remove or disconnect a disposable credential.
6. Connect ChatGPT/Codex OAuth if enabled for the environment.

Pass criteria:

- Secret values are never echoed after save.
- Validation distinguishes invalid key, missing model, and provider outage.
- Agents using a credential update their resolved runtime profile correctly.

### Manager agent

Steps:

1. Open `/settings/manager`.
2. Activate/deactivate the manager agent if controls are available.
3. Edit default behavior and overrides.
4. Add, edit, pause, resume, run-now, and delete a scheduled task.
5. Confirm manager runtime status updates after scheduler ticks.

Pass criteria:

- Manager settings save and survive reload.
- Scheduled tasks have predictable next-run and last-run state.
- Run-now creates observable work or a deterministic failure.

### Local runtimes

Steps:

1. Open `/settings/local-runtimes`.
2. Register a local runtime machine.
3. Start `local-runtime-helper` with a test config.
4. Confirm helper presence, advertised runners, and binding status.
5. Bind an agent to an `openai_compatible` local runner.
6. Run doctor/probe checks.
7. Stop the helper and confirm the UI reports offline.
8. Restart helper and confirm it reconnects without duplicate machine rows.

Pass criteria:

- Registration instructions and tokens work without manual DB edits.
- Online/offline state updates within a reasonable polling interval.
- Binding writes the expected routing metadata.
- Offline helper failures are explicit and recoverable.

### Runtime, sessions, usage, config, memory, channels, workspace

Steps:

1. Open `/settings/runtime` and inspect connection, sessions, capabilities,
   resolved scope, diagnostics, and debug snapshot cards.
2. Open `/settings/sessions` and verify active/previous sessions are listed.
3. Open `/settings/usage` and confirm learning/cost data loads or shows an
   empty state.
4. Open `/settings/config` and verify configuration JSON or validation issues.
5. Open `/settings/memory`; create, inspect, and delete a disposable memory
   item if controls are present.
6. Open `/settings/channels` and verify channel setup or empty state.
7. Open `/settings/workspace` and verify workspace identity/settings.

Pass criteria:

- Each section loads without console or API errors.
- Empty states distinguish "no data" from "failed to load".
- Mutations update React Query-backed views without stale data.

## Plans And Work Items

### Plans list

Steps:

1. Open `/work`.
2. Toggle between Plans and Work items.
3. Refresh.
4. Select a plan to open the details panel.
5. Delete a disposable plan and confirm work item behavior.

Pass criteria:

- Counts, lists, and details panel agree.
- Deletes require confirmation and remove the item from the UI.
- Empty, loading, and error states are clear.

### Plan creation

Steps:

1. Open `/plans/new`.
2. Enter a natural-language request and draft a plan.
3. Edit title, intent, default runner, default model, and tasks.
4. Add and remove tasks.
5. Add dependencies between tasks if supported by the task editor.
6. Try approving invalid drafts.
7. Approve a valid draft.
8. Open the created plan detail page and return to `/work`.

Pass criteria:

- Draft generation either returns an editable plan or a useful planner error.
- Validation blocks malformed plans.
- Approved plans create plan and work item rows in the current workspace.

### Work item lifecycle

Steps:

1. Open the Work items tab.
2. Change status/state for a disposable work item where controls exist.
3. Snooze and unsnooze if available.
4. Inspect provider cutover indicators when a work item has fallback history.
5. Delete a disposable work item.

Pass criteria:

- State changes persist and remain scoped to the workspace.
- Snoozed work sorts after active work.
- Cutover history is visible without breaking the list.

## Tool Calling And Execution

Run these with a disposable workspace and agent.

Steps:

1. Ask a planning agent to create a plan with one work item.
2. Ask a coding agent to inspect a repository file it is allowed to read.
3. Ask a coding agent to attempt a disallowed resource access.
4. Ask an agent to use a database-backed CRUD tool, such as scheduled task or
   memory item creation, when granted.
5. Repeat with missing tool grant.

Pass criteria:

- Granted tools execute and show tool events.
- Denied tools fail with an authorization/configuration error.
- Created resources are visible in the relevant UI.
- Tool input validation failures are shown without crashing the chat.

## Local Model And Helper Workflows

Setup:

- Ollama is running.
- A supported local model is pulled.
- Runtime and platform are running.
- `local-runtime-helper/dev-runtime.toml` points at the local stack.

Steps:

1. Start the helper with debug logging.
2. Confirm it registers with the runtime relay.
3. Confirm `curl http://localhost:11434/api/tags` succeeds.
4. Run the platform diagnostic endpoint for a local-routed agent.
5. Send a dashboard chat message through the local-routed agent.
6. Exercise local filesystem or shell-backed tools only in a disposable repo.
7. Stop Ollama mid-run and confirm failure handling.
8. Stop helper mid-run and confirm relay failure handling.

Pass criteria:

- Helper registration and local runner routing are visible in UI diagnostics.
- Local model responses stream through the normal dashboard path.
- Tool execution happens on the helper side, not in the cloud runtime.
- Mid-run failures are recoverable and do not leave duplicate active sessions.

## API And Diagnostic Manual Checks

Use a valid access token for authenticated routes.

Steps:

1. Call `/api/auth/state` from the browser network tab after login.
2. Call `/health?agentId=<agent-id>`.
3. Call `/api/agents/<agent-id>`.
4. Call `/api/diagnostic/agents/<agent-id>?workspaceId=<workspace-id>`.
5. Exercise relevant route groups after UI mutations:
   - stored agents
   - credentials
   - local runtime
   - plans and work items
   - scheduled tasks
   - memory and learning
   - provider failures/cutovers
6. Check `.run-logs/api.log`, runtime logs, and helper logs for errors.

Pass criteria:

- API responses use camelCase at the HTTP boundary.
- 4xx errors are specific and user-fixable.
- 5xx errors are logged with enough detail for diagnosis.
- Logs redact credentials and tokens.

## Error And Recovery Scenarios

Run these intentionally after at least one happy-path pass.

Steps:

1. Start web without API.
2. Start API without runtime.
3. Start platform with missing Supabase service role key.
4. Use expired or malformed auth tokens.
5. Use an agent with no routing rule.
6. Use an agent with missing credentials.
7. Configure a provider model that is unsupported or unavailable.
8. Kill the orchestrator during chat.
9. Reload during streaming.
10. Simulate slow network and retry failed mutations.

Pass criteria:

- The app reports specific failures instead of blank screens.
- Retrying after dependency recovery works.
- Failed mutations do not leave visibly inconsistent local state.

## Accessibility And Usability Sweep

Steps:

1. Navigate core flows with keyboard only.
2. Confirm focus states and modal/dialog focus traps.
3. Check form labels and error messages.
4. Confirm color contrast for badges, alerts, and disabled controls.
5. Use browser zoom at 125% and 200%.
6. Test narrow viewport layout for dashboard, settings, onboarding, and work
   items.

Pass criteria:

- Interactive controls are reachable and named.
- Text does not overlap or get clipped.
- Error and success states are perceivable without color alone.

## Release Candidate Pass

Before a release or important demo, run at minimum:

1. Local full-stack startup and health.
2. Login and first-run onboarding.
3. Dashboard chat against a cloud-routed agent.
4. Dashboard chat against a local-routed agent when local runtime work changed.
5. Agent settings save for model/provider/credential.
6. Plan creation and work item inspection.
7. Manager scheduled task run-now when scheduler work changed.
8. Production/staging deployed SHA and browser smoke.

Record:

- environment
- commit SHA
- tester
- date/time
- browser and OS
- pass/fail per section
- links to logs, screenshots, or bugs for failures

## Known Inventory Gaps

This first inventory is route- and feature-surface based. It still needs:

- Exact seeded test data for each environment.
- Per-provider credential validation cases.
- Per-runner expected diagnostics.
- Detailed acceptance criteria for every settings sub-card.
- A formal browser matrix.
- A mapping from each manual flow to future Playwright coverage.
