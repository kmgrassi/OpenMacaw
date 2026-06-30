# Dashboard UI Improvement — Scope

Status: proposed (open questions resolved 2026-06-10 — see Decisions)
Owner: TBD
Related: [`../../../docs/open-source-readiness-scope.md`](../../../docs/open-source-readiness-scope.md),
[`../../AGENTS.md`](../../AGENTS.md)

## Problem

The dashboard's core idea is simple: **you talk to one agent, and that agent
federates work out to everything else.** When the happy path works, the user
should see a conversation and (optionally) evidence that delegated work is
happening. Everything else — runtime health, gateway diagnostics, engine
instances, smoke tests, session inspectors — exists to help the user debug
when the happy path *doesn't* work.

After many incremental changes, the UI no longer expresses that hierarchy.
The chat shares vertical space with banners, health widgets, status cards,
and debug panels that appear and disappear based on loosely related flags.
The operator/debug surfaces are scattered across a sidebar toggle, a header
dropdown, conditional dashboard cards, and nine settings sections — with no
consistent pattern for "where do I look when something is broken." And the
layout system underneath has drifted: spacing values disagree between
adjacent containers, widths are hardcoded in ways that break on small
screens, and nothing adapts on large screens.

Concretely:

**Hierarchy / information architecture**

- The dashboard column (`platform/apps/web/src/routes/Dashboard.tsx`) stacks
  `DashboardHeader`, `OnboardingNudgeBanner`, `WorkspaceAgentHealthWidget`,
  error alerts, `ConfigurationStatusCard`, and the chat panel — and with
  debug mode on, additionally `GatewayDebugPanel`, `AgentDashboardPanel`,
  and `RuntimeDebugCard`. The chat — the actual product — is the *last*
  element and shrinks to accommodate everything above it.
- Debug affordances live in four different places with no shared model:
  a sidebar "Debug mode" button (`AppShell.tsx`), a "View details" dropdown
  in `DashboardHeader.tsx` (a 64rem-wide pseudo-modal), conditional inline
  cards on the dashboard, and the diagnostics tabs under `/settings/*`.
- There is no single "is my system healthy?" answer. Health is implied by
  the union of `WorkspaceAgentHealthWidget`, `AgentHealthBanner`,
  `EngineInstanceCard`, and the runtime settings page.

**Spacing and responsiveness**

- Adjacent containers disagree on padding: the dashboard wrapper uses
  `px-4 py-4 sm:px-5` (`Dashboard.tsx:303`), the chat scroll area inside it
  uses `px-3 pt-2 sm:px-4` (`ChatView.tsx:224`), and the settings layout
  uses a third pattern, `p-4 md:p-6` (`Settings.tsx:21`). No page-level
  padding convention exists.
- The mobile sidebar drawer is a fixed `w-72` (288px) (`AppShell.tsx:217`);
  on a 320–375px viewport it covers nearly the whole screen with no
  max-width guard.
- The header "View details" dropdown sizes itself `w-[min(92vw,64rem)]
  max-h-[min(78vh,44rem)]` (`DashboardHeader.tsx:91`) — a modal pretending
  to be a dropdown, anchored `absolute right-0`, which clips and crowds on
  small screens.
- On large screens nothing takes advantage of the space: chat content caps
  at `max-w-4xl` while debug/status cards stretch full width, so wide
  monitors get a narrow conversation lane surrounded by stretched chrome.
- No container queries anywhere; every component assumes viewport-level
  breakpoints even when its real constraint is the panel it sits in.

**Component and token drift**

- Only four semantic color tokens exist (`surface.*`, `border.*` in
  `tailwind.config.js`); text colors (`text-slate-100/300/400/500`) and
  status colors are hardcoded per component, so "muted text" varies by file.
- `Card.tsx` exists but is routinely overridden (`EngineInstanceCard.tsx`
  passes `p-0` plus custom borders) or bypassed entirely (`ChatMessage.tsx`
  builds its own bordered boxes). Same story for badges (`Badge.tsx` vs
  `StatusBadge.tsx` vs inline badge markup) and overlays (no shared
  Modal/Dialog — `DashboardHeader` and `OnboardingModal` each roll their
  own).
- Form primitives (`Input`, `Textarea`, `Select`, `SegmentedControl`) each
  manage their own label/error layout, so settings forms vary visually.
- The drift produces real bugs, not just inconsistency:
  `WorkspaceAgentHealthWidget.tsx` is styled for a light theme (`bg-white`,
  `bg-amber-50`, `text-slate-900`, `border-slate-200`) inside the dark-only
  dashboard — visibly broken today, and exactly what semantic tokens
  prevent.

## Design principles

1. **The conversation is the product.** The default dashboard view is the
   chat with the manager agent, full-height, with at most one slim status
   strip. Everything else earns its way onto the screen only when it is
   actionable *right now* (e.g. "runtime is down, click to fix").
2. **Progressive disclosure for operator surfaces.** Healthy systems show a
   green dot, not a panel. Debug helpers are one consistent gesture away
   (an inspector drawer), never interleaved with the conversation. Settings
   are for *configuration*; the inspector is for *live state*; the chat is
   for *work*. No surface does two of these jobs.
3. **One layout system, defined once.** Page padding, panel gaps, content
   max-widths, and breakpoint behavior are decided in one place (shell-level
   layout components + a documented spacing scale) and inherited — never
   re-chosen per route.
4. **Semantic tokens over raw palette values.** Components reference
   `text-primary`/`text-muted`/`status-ok`-style tokens; only the theme file
   knows they map to slate/green/etc. This is also what makes a future
   light theme or brand pass cheap.
5. **Status communicates in one vocabulary.** One health model
   (ok / degraded / down / unconfigured), one set of status colors and
   badge shapes, used identically by the sidebar dot, the inspector, and
   settings diagnostics.

## Proposed end state

A three-layer dashboard:

```
┌────────────┬──────────────────────────────────────────────┬───────────┐
│  Sidebar   │  Conversation (the page)                     │ Inspector │
│            │                                              │ (drawer,  │
│  agents    │  ┌ slim status strip (only when actionable) ┐│  closed   │
│  nav       │  │ messages …                               ││  by       │
│  health ●  │  │ delegated-work timeline inline           ││  default) │
│            │  └ composer ─────────────────────────────────┘│           │
└────────────┴──────────────────────────────────────────────┴───────────┘
```

- **Conversation layer** (always visible): chat messages, the
  `RuntimeEventTimeline` showing federated/delegated activity inline, and
  the composer. This is the whole page on the happy path.
- **Status layer** (conditional, slim): a single strip above the chat that
  collapses onboarding nudges, workspace health, configuration status, and
  errors into *one* prioritized slot — show the most important item, badge
  the rest ("2 more issues"), link into the inspector. Replaces today's
  stack of `OnboardingNudgeBanner` + `WorkspaceAgentHealthWidget` +
  `Alert` + `ConfigurationStatusCard`.
- **Inspector layer** (on demand): a right-side drawer (full-screen
  takeover on mobile) that absorbs everything debug mode currently injects
  inline —
  gateway/connection state (`GatewayDebugPanel`), engine instance + logs
  (`EngineInstanceCard`), run history (`AgentDashboardPanel`), registered
  agents (`RuntimeDebugCard`) — as tabs or accordion sections, plus the
  "Copy diagnostics JSON" export. The sidebar health dot and the status
  strip both open it. "Debug mode" stops being a layout mutation and
  becomes "the inspector is open."

Settings keep deep configuration and destructive operations
(`/settings/runtime`, smoke tests, session management). The inspector
*links into* the relevant settings section rather than duplicating it.

## Workstreams

### WS1 — Layout shell and spacing normalization

The mechanical fixes; do these first since every later workstream builds on
them.

- Introduce a `PageLayout` (or extend `AppShell`) that owns page padding and
  vertical rhythm. Pick one convention — recommendation:
  `px-4 py-4 sm:px-6 sm:py-5 lg:px-8` for full pages, and *zero* additional
  horizontal padding inside (children align to the page edge by default).
  Migrate `Dashboard.tsx`, `Settings.tsx`, `WorkspaceItems.tsx`, plan pages.
- Align the chat scroll area's gutters with the page convention so message
  bubbles, composer, and header share a left edge (today: `px-3` vs `px-4`
  vs `px-5` within one screen).
- Fix the mobile drawer: `w-72` → `w-[min(18rem,85vw)]` (or equivalent),
  and audit every fixed width in `AppShell` for the 320px case.
- Replace the `DashboardHeader` "View details" dropdown with the shared
  Dialog from WS3 (interim: give it proper small-screen behavior — full
  width sheet under `sm`).
- Large screens: define a content strategy — recommendation: chat column
  `max-w-3xl`–`4xl` centered, with the freed space going to the inspector
  drawer (which can pin open ≥ `2xl`) instead of stretching cards.
- Adopt container queries (`@container`) for components that live in both
  the main column and the inspector/settings (status cards, run history),
  so they stack/condense based on their panel, not the viewport. Tailwind
  3.4 supports this via the official plugin.

Acceptance: a screenshot pass at 320 / 375 / 768 / 1280 / 1920 px shows no
horizontal overflow, aligned gutters on every page, and no component
visually identical-but-misaligned across pages.

### WS2 — Design tokens

- Extend `tailwind.config.js` with semantic tokens:
  - Text: `text-primary`, `text-secondary`, `text-muted`, `text-faint`
    (mapping to today's slate-100/300/400/500 usage).
  - Status: `status-ok`, `status-warn`, `status-error`, `status-info`,
    `status-neutral` — each with text/bg/border variants.
  - Interactive: `accent` (today's blue-500/600) with hover/focus states.
- Implement as CSS variables under the hood (`:root` in
  `styles/index.css`) so theming stays a one-file change; move the
  scrollbar `rgba()` literals onto the same variables.
- Document the scale in `platform/AGENTS.md`/`CLAUDE.md` (allowed spacing
  steps, when to use which text token) so agents and humans stop
  free-handing values.
- Mechanical migration: codemod/grep pass replacing raw `text-slate-*` and
  ad-hoc status colors with tokens. No visual change expected — this is a
  refactor, verified by before/after screenshots. Exception:
  `WorkspaceAgentHealthWidget`'s light-theme styling is a bug; migrating it
  to tokens intentionally changes how it looks.

### WS3 — Component consolidation

- **Dialog/Drawer/Sheet**: one overlay primitive (focus trap, escape,
  backdrop, z-index scale, mobile full-screen variant). Consumers:
  `DashboardHeader` details, `OnboardingModal`, the WS4 inspector.
  **Decided: build on Radix UI** (headless, Tailwind-friendly, React 19
  compatible) rather than hand-rolling on native `<dialog>` — the drawer
  isn't a native-dialog shape, so going dependency-free would mean owning
  focus-trap, scroll-lock, and nested-overlay edge cases in-house.
- **Card**: make `Card.tsx` the only card. Add the variants the overriders
  actually need (`padding="none" | "sm" | "md"`, `tone="default" |
  "raised" | "info"`) and migrate `EngineInstanceCard`, `ChatMessage` tool
  boxes, and settings cards onto it.
- **Badge/Status**: merge `Badge` and `StatusBadge` into one component
  driven by the WS2 status tokens; replace inline badge markup in
  `ChatMessage.tsx` and settings sections.
- **FormField**: a wrapper owning label/description/error layout, with
  `Input`/`Textarea`/`Select`/`SegmentedControl` as children. Settings
  forms migrate opportunistically (per-section, not big-bang).

### WS4 — Status strip, inspector, and federation visibility (the IA change)

The user-visible payoff; depends on WS1 (layout) and WS3 (Drawer). Ships as
a straight swap — no feature flag. Gating it would mean maintaining two
dashboard layouts, two `ui`-store shapes, and the dead debug-mode paths for
the flag's lifetime; the user base is small enough that a clean cutover is
cheaper.

- **Status strip**: a single component above the chat that takes today's
  banner/widget/alert inputs and renders the highest-priority one
  (priority: blocking error > unconfigured > degraded health > onboarding
  nudge), with a count chip for the rest. Nothing else renders above the
  chat. Healthy + configured ⇒ the strip doesn't render at all.
  `WorkspaceAgentHealthWidget` splits along this line: its *summary*
  ("Orchestrator unreachable", "N agents need attention") is strip-tier;
  the per-agent diagnostic list with error codes/details moves to the
  inspector; the all-healthy card disappears entirely.
- **Inspector drawer**: right-side drawer hosting Connection (gateway
  debug + export), Engine (instance card, logs, health), Runs (agent
  dashboard panel), and Agents (runtime debug card) sections. Open via
  sidebar health dot, status strip links, or keyboard shortcut. Persist
  open/closed + last tab in the existing `ui` Zustand store (replacing
  `debugMode`). Starts closed for everyone — the old `debugMode` flag is
  dropped, not migrated; former debug-mode users re-open the inspector once
  and the preference persists from there. On mobile the inspector is a
  full-screen takeover, not a bottom sheet.
- **One health model**: a `useSystemHealth()` selector that reduces
  gateway/launcher/engine/agent signals into ok/degraded/down/unconfigured
  + a list of issues. Sidebar dot, status strip, and inspector header all
  consume it — they can no longer disagree.
- **Federation visibility**: the happy path isn't just a working chat —
  it's *watching the agent federate*. Upgrade the delegated-work rendering
  (today: raw `RuntimeEventTimeline` events inline) into a first-class
  view of fan-out: which sub-agents/runners are active, what each is
  working on, live status, and completion — inline in the conversation
  where the delegation happened, with the inspector's Runs section as the
  detailed history. This is the part of the original product premise the
  rest of the scope only protects; WS4 is where it gets delivered. Needs a
  short design pass at WS4 kickoff (what the runtime events can actually
  support rendering).
- **Unconfigured empty state**: when the agent/workspace isn't configured,
  the chat message area renders a setup checklist (the steps, with links
  into the relevant settings sections) and the composer is disabled. One
  layout for all states — no separate setup page, no redirect to
  onboarding; the strip's "unconfigured" line and the checklist are the
  same signal at two altitudes. Replaces `ConfigurationStatusCard`.
- Remove the now-dead inline debug rendering paths from `Dashboard.tsx`;
  the dashboard becomes header + (strip?) + chat, nothing else.

### WS5 — Settings coherence (follow-on, lighter touch)

- Reorganize the nine settings sections around user intent. Working
  proposal: **Setup** (agents, models, channels, workspace), **Runtime**
  (runtime, local-runtimes, sessions), **Account** (usage, config, memory).
  The three-group direction is agreed; the exact assignment of sections
  (e.g. whether memory/config are "account" things) gets decided at WS5
  kickoff. Pure nav grouping — no route changes required initially.
- Move "live state" panels (worker sessions list, debug snapshot) toward
  inspector-style presentation; settings pages keep configuration and
  actions (smoke tests stay in settings — they're operations, not state).
- Apply WS1–WS3 conventions as each section is touched; no dedicated
  big-bang restyle.

## Sequencing and effort

| Phase | Workstreams | Why this order | Rough size |
|-------|-------------|----------------|------------|
| 1 | WS1 + WS2 | Mechanical, low-risk, unblocks everything; tokens and layout migrate together since both are find-and-replace heavy | ~1 week |
| 2 | WS3 | Needs tokens; Drawer is a hard prerequisite for WS4 | ~1 week |
| 3 | WS4 | The actual UX change; ships as a straight swap (no flag). Includes the federation-visibility design pass | ~2–2.5 weeks |
| 4 | WS5 | Opportunistic, can trail indefinitely | ongoing |

Each phase should end with a viewport screenshot pass (320/768/1280/1920)
checked against the previous phase — the spacing regressions this doc
complains about crept in precisely because nothing verified layout at
multiple widths.

## Out of scope

- Light theme / theming beyond tokens (WS2 makes it cheap later; not now).
- The marketing `Landing.tsx` page.
- Chat *functionality* (streaming, tool-call rendering semantics, composer
  features) — only its layout and spacing. Exception: delegated-work /
  federation visibility is explicitly *in* scope (WS4); the exclusion
  covers message rendering and composer behavior, not how fan-out is
  surfaced.
- Runtime/orchestrator API changes; everything here is presentational or
  client-state-level (`ui` store, selectors).

## Decisions (resolved 2026-06-10)

Originally open questions; resolved with the project owner. The workstream
text above already reflects these.

1. **Inspector on mobile: full-screen takeover.** Simplest to build, best
   for reading logs, and debugging from a phone is a rare path — losing
   chat context behind the takeover is a cheap trade. No drag gestures.
2. **Inspector starts closed for everyone.** The old `debugMode` preference
   is dropped, not migrated to a pinned-open default on large screens.
   Former debug-mode users re-open the inspector once; open/closed state
   persists in the `ui` store from there.
3. **Overlay primitive builds on Radix UI.** Native `<dialog>` covers
   centered modals but not the drawer/sheet shape, so dependency-free would
   mean hand-rolling focus trap, scroll lock, and nested-overlay behavior.
   One dependency buys both the Dialog and the Drawer.
4. **`WorkspaceAgentHealthWidget` splits across tiers.** Content audit
   (`platform/apps/web/src/components/dashboard/WorkspaceAgentHealthWidget.tsx`):
   its summary states ("Orchestrator unreachable", "N agents need
   attention") are blocking/actionable and belong in the status strip; the
   per-agent diagnostic list (error codes, `ERROR_EXPLANATIONS`, raw
   details) is inspector-tier; the all-healthy card stops rendering
   entirely. The audit also surfaced the light-theme styling bug noted
   under Component and token drift.
5. **Federation visibility is in scope, inside WS4.** Watching the agent
   fan out is part of the product premise, not a chat-rendering detail —
   WS4 includes upgrading the delegated-work timeline into a first-class
   view of sub-agent activity, with a design pass at WS4 kickoff.
6. **Unconfigured state renders a setup checklist in the chat area** with
   the composer disabled — one layout for all states, replacing
   `ConfigurationStatusCard`. No redirect to onboarding.
7. **Settings regrouping is directionally agreed, details deferred.** Three
   intent groups (Setup / Runtime / Account); exact section assignment
   decided at WS5 kickoff.
8. **WS4 ships as a straight swap, no feature flag.** A flag would mean
   maintaining two dashboard layouts and two `ui`-store shapes; the clean
   cutover is cheaper for this user base.
