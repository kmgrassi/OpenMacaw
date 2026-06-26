# Web UI Component Standardization Scope

Status: active scoping. Created 2026-05-14.

This pass identifies repeated frontend UI patterns that should move into the
shared `apps/web/src/components/ui/` library, plus a few adjacent route and
layout components that should consume those primitives. The goal is to make new
feature work use the standard component library by default instead of copying
Tailwind strings from nearby screens.

The current UI already has `Button`, `Card`, `Badge`, `Input`, and `Select`,
but the survey found broad duplication around navigational buttons, segmented
controls, alerts, empty/loading states, status colors, form controls, and small
surface rows. These are good parallel PR candidates because each one can own a
single primitive and migrate a bounded set of callers.

## Ground Rules

- Keep the PRs behavior-preserving unless a PR explicitly says otherwise. The
  first pass should standardize markup, states, class names, and API shape
  without changing product behavior.
- Prefer composable primitives in `components/ui/` over one-off helpers hidden
  in route folders.
- Do not add compatibility aliases. If a new primitive replaces a local helper,
  update all in-scope callers in the same PR.
- Keep write ownership disjoint. A PR should own its new primitive plus the
  listed migration targets during its assigned wave. If a file appears in more
  than one PR below, the later PR must wait for the earlier wave and rebase
  before editing that file.
- Keep component props typed around product meaning, not raw Tailwind classes,
  while still accepting `className` for local layout adjustments.
- Run the web typecheck and verify touched UI in the browser before marking a
  UI PR complete.

## Current Survey

Examples found during the 2026-05-14 scan:

- `Button` exists, but raw `<button>` still appears about 129 times. Some are
  semantic controls, but many duplicate the shared button and icon-button
  styles.
- `Button` is used about 50 times, so the shared primitive is already accepted
  and worth extending rather than replacing.
- Link-as-button styles are copied in plan and settings routes, such as
  `PlanDetail.tsx` and `AgentDetail.tsx`.
- Segmented controls repeat the same selected/unselected classes in
  `WorkspaceItems.tsx`, `CredentialEditor.tsx`,
  `ManagerAgentDefaults.tsx`, `AgentsSection.tsx`,
  `AgentIdentityEditor.tsx`, and
  `agent-model-policy/LocalCodingRunnerPanel.tsx`.
- Inline alert classes for red, amber, green, emerald, and blue states appear
  across route pages, dashboard panels, settings panels, chat banners, and
  agent settings.
- Dashed empty-state boxes are repeated in work items, tool definitions,
  catalog tools, resolved tools, and run history.
- Textarea, select, checkbox, and form message styles are still hand-authored
  even though `Input` and `Select` exist.

## Proposed Shared Component Inventory

Target `components/ui/` additions and extensions:

- `Button` extensions: link rendering, icon-only size, `asChild` or explicit
  `ButtonLink` wrapper, and standard left/right icon slots.
- `IconButton`: square affordances for collapse, close, add, refresh, and
  disclosure actions.
- `SegmentedControl`: single-select button groups with consistent active,
  disabled, and responsive grid behavior.
- `Alert`: inline and sticky/banner variants for `info`, `success`, `warning`,
  `error`, and `neutral`.
- `EmptyState`: dashed/quiet empty states with optional action.
- `LoadingState`: route-level loading bar and compact inline loading text.
- `StatusBadge` / status tone helpers: shared mapping from status to border,
  background, text, and dot colors.
- `FormField` primitives: `Textarea`, `Checkbox`, `FieldMessage`, and shared
  label/help/error handling.
- `PageHeader`: title, subtitle/metadata, and action slot for route-level
  headers.
- `SurfaceList`: repeated bordered list/row containers for settings and
  dashboard detail rows.

Recent follow-on cleanup: the shared `Alert`, `EmptyState`, and `LoadingState`
primitives now cover a broader slice of settings screens as well, including
`ConfigSection`, `UsageSection`, `SessionsSection`, `ChannelsSection`, and
`AgentDetail`. Continue preferring those primitives over inline state markup in
future settings work.

## PR Sequence

Each PR below is intended to be assignable to a parallel agent within the
execution waves at the end of this document. Some files intentionally appear in
more than one PR because the duplication cuts across primitive boundaries; those
files are ordered by wave, not edited concurrently. Agents should update this
doc if the implementation reveals a better primitive name, scope, or ordering.

---

## PR1 — Standardize Button Links And Icon Buttons

**Primary files:**

- [apps/web/src/components/ui/Button.tsx](../../apps/web/src/components/ui/Button.tsx)
- New `apps/web/src/components/ui/ButtonLink.tsx` or an equivalent typed link
  rendering path.
- New `apps/web/src/components/ui/IconButton.tsx`.

**Migration targets:**

- [apps/web/src/pages/plans/PlanDetail.tsx](../../apps/web/src/pages/plans/PlanDetail.tsx)
- [apps/web/src/components/settings/AgentDetail.tsx](../../apps/web/src/components/settings/AgentDetail.tsx)
- [apps/web/src/components/AppShell.tsx](../../apps/web/src/components/AppShell.tsx)
- [apps/web/src/components/ChatComposer.tsx](../../apps/web/src/components/ChatComposer.tsx)
- [apps/web/src/components/ChatView.tsx](../../apps/web/src/components/ChatView.tsx)
- [apps/web/src/components/OnboardingModal.tsx](../../apps/web/src/components/OnboardingModal.tsx)

**Scope:**

- Add a standard way to render a router `Link` with button variants and sizes.
- Add `IconButton` for square collapse, close, plus, refresh, menu, retry, and
  dismiss controls.
- Preserve the existing `Button` visual variants, but make raw copied button
  class strings unnecessary for navigational and icon actions.

**Acceptance checks:**

- Existing `Button` callers compile without prop changes unless migrated.
- Plan detail links and settings links look unchanged.
- App shell collapse/add/menu controls remain keyboard focusable and labeled.

**Risk:** Medium. `AppShell` has several navigation-adjacent buttons; keep
route behavior unchanged.

---

## PR2 — Add `SegmentedControl`

**Primary file:** New `apps/web/src/components/ui/SegmentedControl.tsx`.

**Migration targets:**

- [apps/web/src/routes/WorkspaceItems.tsx](../../apps/web/src/routes/WorkspaceItems.tsx)
- [apps/web/src/components/settings/CredentialEditor.tsx](../../apps/web/src/components/settings/CredentialEditor.tsx)
- [apps/web/src/components/settings/ManagerAgentSection/ManagerAgentDefaults.tsx](../../apps/web/src/components/settings/ManagerAgentSection/ManagerAgentDefaults.tsx)
- [apps/web/src/components/settings/AgentsSection.tsx](../../apps/web/src/components/settings/AgentsSection.tsx)
- [apps/web/src/components/settings/AgentDetail/AgentIdentityEditor.tsx](../../apps/web/src/components/settings/AgentDetail/AgentIdentityEditor.tsx)
- [apps/web/src/components/settings/agent-model-policy/LocalCodingRunnerPanel.tsx](../../apps/web/src/components/settings/agent-model-policy/LocalCodingRunnerPanel.tsx)

**Scope:**

- Support generic string values, disabled options, label text, column/grid
  layout, and full-width behavior.
- Replace repeated `grid rounded-md border ... p-1` and `bg-blue-600 text-white`
  selected-state code.
- Add accessible semantics with either radio group behavior or `aria-pressed`
  buttons, applied consistently.

**Acceptance checks:**

- Work item mode switching still works.
- Credential format switching preserves disabled format behavior.
- Agent type, manager credential mode, and local coding mode controls keep their
  previous selected values.

**Risk:** Medium. The credential editor has disabled option behavior that the
primitive must support cleanly.

---

## PR3 — Add `Alert` And Migrate Inline Messages

**Primary file:** New `apps/web/src/components/ui/Alert.tsx`.

**Migration targets:**

- [apps/web/src/routes/WorkspaceItems.tsx](../../apps/web/src/routes/WorkspaceItems.tsx)
- [apps/web/src/routes/Dashboard.tsx](../../apps/web/src/routes/Dashboard.tsx)
- [apps/web/src/pages/plans/NewPlan.tsx](../../apps/web/src/pages/plans/NewPlan.tsx)
- [apps/web/src/components/ApprovalRequiredNotice.tsx](../../apps/web/src/components/ApprovalRequiredNotice.tsx)
- [apps/web/src/components/AgentDashboardPanel.tsx](../../apps/web/src/components/AgentDashboardPanel.tsx)
- [apps/web/src/components/settings/ConfigSection.tsx](../../apps/web/src/components/settings/ConfigSection.tsx)
- [apps/web/src/components/settings/ModelsSection.tsx](../../apps/web/src/components/settings/ModelsSection.tsx)
- [apps/web/src/components/settings/LocalModelsSection.tsx](../../apps/web/src/components/settings/LocalModelsSection.tsx)
- [apps/web/src/components/agent-settings/ToolDefinitionsPanel.tsx](../../apps/web/src/components/agent-settings/ToolDefinitionsPanel.tsx)

**Scope:**

- Define tone variants: `neutral`, `info`, `success`, `warning`, `error`.
- Support optional title, actions, monospace detail, and compact density.
- Replace repeated `rounded-md border border-red... bg-red... text-red...`
  classes where the message is a standard inline alert.

**Acceptance checks:**

- Error, warning, and success messages remain visible with comparable contrast.
- `ApprovalRequiredNotice` keeps its approval button and command detail.
- Tool definition validation messages keep their relative order.

**Risk:** Low-medium. Most migrations are visual, but alerts often sit inside
forms and must not alter submit behavior.

---

## PR4 — Standardize Chat And Sticky Banners

**Primary files:**

- New `apps/web/src/components/ui/Alert.tsx` banner support, or new
  `apps/web/src/components/ui/StatusBanner.tsx` if PR3 keeps alerts inline
  only.

**Migration targets:**

- [apps/web/src/components/ChatView.tsx](../../apps/web/src/components/ChatView.tsx)
- [apps/web/src/components/Layout.tsx](../../apps/web/src/components/Layout.tsx)
- [apps/web/src/components/dashboard/OnboardingNudgeBanner.tsx](../../apps/web/src/components/dashboard/OnboardingNudgeBanner.tsx)
- [apps/web/src/components/dashboard/LauncherConfigErrorBanner.tsx](../../apps/web/src/components/dashboard/LauncherConfigErrorBanner.tsx)

**Scope:**

- Normalize bottom/top banner tone colors and action placement.
- Keep sticky/backdrop behavior configurable so chat banners can remain attached
  to the transcript/composer area.
- Reuse the same tone vocabulary as `Alert`.

**Acceptance checks:**

- Chat credential, loading, manager read-only, runtime, and error banners still
  appear in the same conditions.
- Gateway warning in legacy `Layout` remains visible.
- Dashboard onboarding/config banners still preserve their actions.

**Risk:** Medium. Chat banners are stateful and user-facing; verify in browser.

---

## PR5 — Add Shared Empty And Loading States

**Primary files:**

- New `apps/web/src/components/ui/EmptyState.tsx`.
- New `apps/web/src/components/ui/LoadingState.tsx`.

**Migration targets:**

- [apps/web/src/App.tsx](../../apps/web/src/App.tsx)
- [apps/web/src/routes/WorkspaceItems/utils.tsx](../../apps/web/src/routes/WorkspaceItems/utils.tsx)
- [apps/web/src/components/agent-settings/ToolDefinitionList.tsx](../../apps/web/src/components/agent-settings/ToolDefinitionList.tsx)
- [apps/web/src/components/agent-settings/ToolDefinitionsPanel/ToolCatalog.tsx](../../apps/web/src/components/agent-settings/ToolDefinitionsPanel/ToolCatalog.tsx)
- [apps/web/src/components/agent-settings/ToolDefinitionsPanel/ResolvedToolsSection.tsx](../../apps/web/src/components/agent-settings/ToolDefinitionsPanel/ResolvedToolsSection.tsx)
- [apps/web/src/components/AgentDashboardPanel/RunHistoryCard.tsx](../../apps/web/src/components/AgentDashboardPanel/RunHistoryCard.tsx)
- [apps/web/src/components/ChatView.tsx](../../apps/web/src/components/ChatView.tsx)

**Scope:**

- Replace repeated dashed empty boxes with one component supporting label,
  description, density, and optional action.
- Replace the duplicated route loading progress bar in `App.tsx` with
  `LoadingState`.
- Keep compact text-only loading use cases available for lists and panels.

**Acceptance checks:**

- Route fallback, session check, and history loading states still show.
- Work item, tool, catalog, resolved tools, and run-history empty states keep
  their existing copy.
- No layout jump is introduced around the app route fallback.

**Risk:** Low.

---

## PR6 — Centralize Status Tone Classes

**Primary files:**

- New `apps/web/src/components/ui/status-tones.ts`.
- Optional new `apps/web/src/components/ui/StatusBadge.tsx`.

**Migration targets:**

- [apps/web/src/components/RuntimeEventTimeline.tsx](../../apps/web/src/components/RuntimeEventTimeline.tsx)
- [apps/web/src/routes/WorkspaceItems/utils.tsx](../../apps/web/src/routes/WorkspaceItems/utils.tsx)
- [apps/web/src/components/settings/RuntimeSection.tsx](../../apps/web/src/components/settings/RuntimeSection.tsx)
- [apps/web/src/components/dashboard/ConfigurationStatusCard.tsx](../../apps/web/src/components/dashboard/ConfigurationStatusCard.tsx)
- [apps/web/src/components/AgentList.tsx](../../apps/web/src/components/AgentList.tsx)
- [apps/web/src/components/AppShell.tsx](../../apps/web/src/components/AppShell.tsx)

**Scope:**

- Define a small status-tone map for `success`, `error`, `warning`, `info`,
  `running`, `idle`, and `neutral`.
- Provide helpers for pill, bordered panel, dot, and text-only styling.
- Replace local `statusClass`, `dotClass`, and nested ternaries where they are
  purely visual mappings.

**Acceptance checks:**

- Runtime event status colors remain recognizable.
- Agent and connection health dots retain active/inactive meaning.
- Work item status labels keep the same statuses and copy.

**Risk:** Medium. Avoid changing domain status values; this PR should only
standardize presentation.

---

## PR7 — Fill Out Form Primitives

**Primary files:**

- New `apps/web/src/components/ui/Textarea.tsx`.
- New `apps/web/src/components/ui/Checkbox.tsx`.
- New `apps/web/src/components/ui/FieldMessage.tsx`.
- Optional shared form class constants in `apps/web/src/components/ui/form-styles.ts`.

**Migration targets:**

- [apps/web/src/pages/plans/NewPlan.tsx](../../apps/web/src/pages/plans/NewPlan.tsx)
- [apps/web/src/components/ChatComposer.tsx](../../apps/web/src/components/ChatComposer.tsx)
- [apps/web/src/components/agent-settings/ToolDefinitionsPanel/ToolCatalog.tsx](../../apps/web/src/components/agent-settings/ToolDefinitionsPanel/ToolCatalog.tsx)
- [apps/web/src/components/settings/ConfigSection.tsx](../../apps/web/src/components/settings/ConfigSection.tsx)
- [apps/web/src/components/settings/ManagerAgentSection/ManagerAgentOverrides.tsx](../../apps/web/src/components/settings/ManagerAgentSection/ManagerAgentOverrides.tsx)
- [apps/web/src/components/settings/LocalModelsSection/BindingPanel.tsx](../../apps/web/src/components/settings/LocalModelsSection/BindingPanel.tsx)
- [apps/web/src/components/settings/AgentCredentials.tsx](../../apps/web/src/components/settings/AgentCredentials.tsx)

**Scope:**

- Mirror `Input` and `Select` label/error APIs for `Textarea`.
- Provide a consistent checkbox label row for agent/tool selection cards.
- Replace repeated `text-xs text-red-400`, `text-xs text-green-400`, and
  `text-xs text-amber-400` field messages with `FieldMessage`.

**Acceptance checks:**

- New plan form validation and draft import fields still work.
- Chat composer still submits on the same keyboard/mouse actions.
- Tool definition JSON textarea keeps monospace and error styling.
- Manager overrides and local model binding controls still save selections.

**Risk:** Medium. Textareas and checkboxes carry form state; migrate in small
file groups inside this PR.

---

## PR8 — Add `PageHeader`

**Primary file:** New `apps/web/src/components/ui/PageHeader.tsx`.

**Migration targets:**

- [apps/web/src/routes/WorkspaceItems.tsx](../../apps/web/src/routes/WorkspaceItems.tsx)
- [apps/web/src/components/settings/ConfigSection.tsx](../../apps/web/src/components/settings/ConfigSection.tsx)
- [apps/web/src/components/settings/ModelsSection.tsx](../../apps/web/src/components/settings/ModelsSection.tsx)
- [apps/web/src/components/settings/RuntimeSection.tsx](../../apps/web/src/components/settings/RuntimeSection.tsx)
- [apps/web/src/components/settings/UsageSection.tsx](../../apps/web/src/components/settings/UsageSection.tsx)
- [apps/web/src/components/settings/SessionsSection.tsx](../../apps/web/src/components/settings/SessionsSection.tsx)
- [apps/web/src/components/dashboard/DashboardHeader.tsx](../../apps/web/src/components/dashboard/DashboardHeader.tsx)

**Scope:**

- Provide consistent title, subtitle/metadata, description, and action slots.
- Support route-level bottom border and compact panel-section mode.
- Remove repeated `flex ... border-b border-border pb-*` header code where
  screens have the same structure.

**Acceptance checks:**

- Workspace, settings, runtime, usage, sessions, and dashboard headers keep
  their existing text and action buttons.
- Header actions wrap correctly on narrow screens.

**Risk:** Low-medium. This touches multiple visible screens but should be
mostly mechanical.

---

## PR9 — Add `SurfaceList` / Detail Row Primitives

**Primary files:**

- New `apps/web/src/components/ui/SurfaceList.tsx`.
- Optional `apps/web/src/components/ui/KeyValueGrid.tsx`.

**Migration targets:**

- [apps/web/src/components/settings/RuntimeSection.tsx](../../apps/web/src/components/settings/RuntimeSection.tsx)
- [apps/web/src/components/settings/ClaudeCodeSmokePanel.tsx](../../apps/web/src/components/settings/ClaudeCodeSmokePanel.tsx)
- [apps/web/src/components/settings/LocalModelCodingSmokePanel.tsx](../../apps/web/src/components/settings/LocalModelCodingSmokePanel.tsx)
- [apps/web/src/components/settings/LocalModelsSection/RegisteredLocalModelsList.tsx](../../apps/web/src/components/settings/LocalModelsSection/RegisteredLocalModelsList.tsx)
- [apps/web/src/components/settings/AgentCredentials.tsx](../../apps/web/src/components/settings/AgentCredentials.tsx)
- [apps/web/src/components/agent-settings/ToolDefinitionsPanel/ChipGroup.tsx](../../apps/web/src/components/agent-settings/ToolDefinitionsPanel/ChipGroup.tsx)
- [apps/web/src/components/agent-settings/ToolDefinitionsPanel/SchemaPreview.tsx](../../apps/web/src/components/agent-settings/ToolDefinitionsPanel/SchemaPreview.tsx)

**Scope:**

- Standardize `rounded-md border border-border bg-surface px-3 py-*` repeated
  row/card surfaces used inside settings panels.
- Provide row/list structure with optional label, description, metadata, and
  trailing action slots.
- Keep `Card` for larger panels; use `SurfaceList` for repeated compact rows.

**Acceptance checks:**

- Runtime session rows, smoke result blocks, credential rows, chip groups, and
  schema preview containers keep their previous hierarchy.
- No cards are nested inside cards where a simple row primitive is enough.

**Risk:** Medium. This is a broad visual cleanup; keep the migration targets
bounded to the listed files.

---

## PR10 — Extract App Navigation Primitives From `AppShell`

**Primary files:**

- [apps/web/src/components/AppShell.tsx](../../apps/web/src/components/AppShell.tsx)
- New `apps/web/src/components/navigation/*`.

**Proposed split:**

- `navigation/NavItem.tsx` — shared nav link behavior.
- `navigation/NavSection.tsx` — collapsible section header and children.
- `navigation/AgentNavItem.tsx` — agent row with metadata and warning dot.
- `navigation/nav-formatters.ts` — agent metadata and missing-configuration
  labels.
- `navigation/settings-sections.ts` — settings route manifest.

**Scope:**

- Move navigation-specific functionality out of `AppShell`.
- Reuse `IconButton`, status tones, and link/button primitives from prior PRs.
- Keep `AppShell` responsible for layout, mobile drawer state, and route shell
  composition only.

**Acceptance checks:**

- Desktop collapse/expand still works.
- Mobile drawer still opens, navigates, and closes.
- Agent rows route to dashboard or settings based on current route as before.
- Missing configuration warnings still show in collapsed and expanded modes.

**Risk:** Medium-high. This should run after PR1 and PR6 if possible.

---

## PR11 — Retire Legacy `Layout` Or Align It With `AppShell`

**Primary file:** [apps/web/src/components/Layout.tsx](../../apps/web/src/components/Layout.tsx)

**Scope:**

- The initial scan found no active TSX callers for `Layout`. Confirm with
  `rg "from \"./Layout\"|from \"../components/Layout\"|<Layout"` and delete
  it if that remains true.
- If a caller reappears before this PR lands, align its sidebar controls,
  gateway banner, sign-out action, agent list, and session list with the shared
  primitives from PR1, PR4, PR5, and PR6 instead of keeping a divergent shell.
- Do not keep two divergent app shells for active product routes.

**Acceptance checks:**

- `rg "from \"./Layout\"|from \"../components/Layout\"|<Layout"` shows either
  no active callers after deletion or callers using the aligned component.
- Main authenticated routes still render through `AppShell`.

**Risk:** Medium. This PR may become a deletion PR if the component is unused;
verify imports before editing.

## File Ownership And Ordering

The PRs are parallelizable by wave, not as one global batch. Within a wave, no
listed migration target should be edited by more than one PR. Files that appear
in multiple PRs have explicit locks:

| File                                                                          | Owner order                                                |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `apps/web/src/components/ChatView.tsx`                                        | PR1, then PR4, then PR5                                    |
| `apps/web/src/components/AppShell.tsx`                                        | PR1, then PR6, then PR10                                   |
| `apps/web/src/routes/WorkspaceItems.tsx`                                      | PR2, then PR3, then PR8                                    |
| `apps/web/src/routes/WorkspaceItems/utils.tsx`                                | PR5 waits for PR6 if both touch status/empty-state helpers |
| `apps/web/src/pages/plans/NewPlan.tsx`                                        | PR3, then PR7                                              |
| `apps/web/src/components/ChatComposer.tsx`                                    | PR1, then PR7                                              |
| `apps/web/src/components/settings/ConfigSection.tsx`                          | PR3, then PR8                                              |
| `apps/web/src/components/settings/ModelsSection.tsx`                          | PR3, then PR8                                              |
| `apps/web/src/components/settings/RuntimeSection.tsx`                         | PR9, then PR6, then PR8                                    |
| `apps/web/src/components/settings/AgentCredentials.tsx`                       | PR9, then PR7                                              |
| `apps/web/src/components/agent-settings/ToolDefinitionsPanel/ToolCatalog.tsx` | PR5, then PR7                                              |
| `apps/web/src/components/Layout.tsx`                                          | PR4, then PR11 if PR4 leaves it in place                   |

If a PR is assigned outside this order, its agent should either narrow the
migration targets to files it uniquely owns or update this doc before editing.

## Suggested Parallelization

Recommended wave 1:

- PR1 (`ButtonLink` / `IconButton`)
- PR2 (`SegmentedControl`)
- PR9 (`SurfaceList` / detail rows)

Recommended wave 2:

- PR3 (`Alert`) after PR2 for `WorkspaceItems.tsx`.
- PR4 (`StatusBanner`) after PR1 for `ChatView.tsx`.
- PR6 (`StatusBadge` / status tones) after PR1 for `AppShell.tsx` and after
  PR9 for `RuntimeSection.tsx`.

Recommended wave 3:

- PR5 (`EmptyState` / `LoadingState`) after PR4 for `ChatView.tsx` and after
  PR6 for `WorkspaceItems/utils.tsx`.
- PR8 (`PageHeader`) after PR3 for `WorkspaceItems.tsx`, `ConfigSection.tsx`,
  and `ModelsSection.tsx`, and after PR6/PR9 for `RuntimeSection.tsx`.

Recommended wave 4:

- PR7 (`Textarea` / `Checkbox` / `FieldMessage`) after PR1, PR3, PR5, and PR9
  for its overlapping form and catalog files.
- PR10 (`AppShell` navigation extraction) after PR1 and PR6.
- PR11 (`Layout` retirement) after PR4 confirms whether `Layout` still needs a
  banner migration.

## Validation

Run from repo root before each PR is marked complete:

```bash
pnpm exec tsc --noEmit -p apps/web/tsconfig.app.json
```

For every PR that affects visible UI, also run:

```bash
pnpm run dev
```

Then open `http://localhost:5173`, sign in with the dev credentials button,
exercise the touched screen, and check the browser console for errors.

For PRs that touch shared primitives, verify at least one migrated caller for
each variant or state introduced by the primitive.
