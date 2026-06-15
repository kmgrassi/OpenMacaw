# Parallel Agent Platform — Docs Index

Docs are organized by **status**, not topic. Pick the bucket based on what you
need:

| Bucket                                   | What's in it                               | When to read                                                                     |
| ---------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------- |
| [`active/`](active/)                     | In-flight scoping docs and PR plans        | Starting work on a PR — find the scoping doc and treat it as the source of truth |
| [`reference/`](reference/)               | Durable design docs, conventions, runbooks | Looking up how something is designed, named, or run                              |
| [`shipped/`](shipped/)                   | PR plans whose work has merged             | Historical context only — these may be stale                                     |
| [`superseded/`](superseded/)             | Replaced by a newer doc                    | Don't act on these; follow the pointer at the top                                |
| [`decision-records/`](decision-records/) | ADRs for code organization                 | Numbered, append-only                                                            |
| [`open-questions/`](open-questions/)     | Open product/architecture questions        | When a decision is still being framed                                            |

## Workflow

1. Starting a PR? Check `active/` first. If a scoping doc exists, **address it
   in your PR** — update the doc as the design clarifies, and link it from the
   PR description.
2. No doc exists for a non-trivial change? Write a short one in `active/`
   before opening the PR.
3. PR(s) merged? Move the doc to `shipped/` (`git mv docs/active/foo.md
docs/shipped/`) and remove its bullet from the **Active** section below.
4. Replacing an older doc? Move the older one to `superseded/` and add a
   one-line pointer to its replacement at the top.

## Active

In-flight work. Each entry should map to one or more open PRs.

- [active/agent-config-error-ux-plan.md](active/agent-config-error-ux-plan.md)
  — Error UX for agent configuration; per-PR slices.
- [active/agent-config-unification-scope.md](active/agent-config-unification-scope.md)
  — Collapse the five agent-settings cards into one model-first "Model &
  Runtime" card; phased UI consolidation, inline credential creation, and a
  backend de-dup so model/provider/runner have a single source of truth.
  Phases 1 & 3 parallelizable.
- [active/agent-manual-testing-scope.md](active/agent-manual-testing-scope.md)
  — Ten ways to improve manual and end-to-end agent testing from the CLI.
- [active/agent-operability-tooling-scope.md](active/agent-operability-tooling-scope.md)
  — CLI, browser, log, and local-helper tooling to make the app easier for
  agents to run and diagnose.
- [active/agent-persistent-context-scope.md](active/agent-persistent-context-scope.md)
  — Wire the existing `agent.context` field end-to-end: prompt injection,
  user-edit UI, `agent_context.update` self-update tool with optional
  approval gate, versioning history. Foundation for situational behavior
  tuning by users and the upcoming manager-agent sweep. Closes
  vision-gap 4.4.
- [active/agent-tool-grant-data-model-scope.md](active/agent-tool-grant-data-model-scope.md)
  — Move Platform from legacy assignment/bundle semantics to the Harper
  grant-based tool policy model.
- [active/attention-queue-scope.md](active/attention-queue-scope.md)
  — Attention dashboard, per-kind resolution forms, claim/resolve API,
  all-must-resolve invariant, stateless agent re-entry. Companion
  runtime scope in parallel-agent-runtime. Consumes the `escalation`
  rows produced by policy-trust-dial-scope. Closes vision-gap 4.5.
- [active/api-case-convention-pr-plan.md](active/api-case-convention-pr-plan.md)
  — Convert all API-boundary fields from snake_case to camelCase, sliced into
  parallelizable PRs.
- [active/canonical-work-items-routing-scope.md](active/canonical-work-items-routing-scope.md)
  — Planner-chat-first dashboard and work-items routing: landing route,
  plans/work-items view improvements, background-agent navigation contract.
- [active/container-execution-pr-plan.md](active/container-execution-pr-plan.md)
  — Finish-it PR plan for per-run isolated container execution of coding
  tools: in-container executor + image, worker-bridge container backend,
  dispatch routing, the two Terraform stacks, security infra, and staged
  rollout — broken into parallelizable PRs with a dependency graph.
  Operationalizes production-container-tool-execution-scope.
- [active/contract-safety-pr-plan.md](active/contract-safety-pr-plan.md) —
  Contract safety checks across boundaries.
- [active/credentials-streamlining-scope.md](active/credentials-streamlining-scope.md)
  — Collapse credential storage, UI, and validation into one shape, one
  editor, one endpoint; unify local-dev with prod.
- [active/dashboard-ui-improvement-scope.md](active/dashboard-ui-improvement-scope.md)
  — Restore the dashboard to chat-first: one prioritized status strip, an
  inspector drawer replacing debug mode, layout/spacing normalization,
  semantic design tokens, and component consolidation (Radix overlays).
  Five sequenced workstreams; open questions resolved.
- [active/end-to-end-logging-pr-plan.md](active/end-to-end-logging-pr-plan.md)
  — Structured logging across web, API, and runtime layers.
- [active/execution-target-schema-pr-plan.md](active/execution-target-schema-pr-plan.md)
  — Promote `execution_target` to a first-class DB column.
- [active/fleet-sampling-observer-scope.md](active/fleet-sampling-observer-scope.md)
  — Always-on learning loop: on a slow tick, sample one running agent
  (rotating across the fleet), read a ~10-message slice of its most
  recent run, and emit an advisory recommendation the planning/manager
  agent consumes. Builds on learning-sidecar + closed-loop-observability;
  advisory only, no routing-rule writes.
- [active/frontend-supabase-api-refactor-pr-plan.md](active/frontend-supabase-api-refactor-pr-plan.md)
  — Move browser-side Supabase table/realtime access behind platform API
  routes (Auth stays in the frontend).
- [active/frontend-data-refresh-react-query-scope.md](active/frontend-data-refresh-react-query-scope.md)
  — Refactor frontend API data loading to React Query with explicit query keys,
  mutations, and runtime-event invalidation.
- [active/intelligent-cutovers-scope.md](active/intelligent-cutovers-scope.md)
  — Model fallback chains, model-tier registry, per-agent adequacy floor,
  and `provider_cutover` audit when a chosen model rate-limits, refuses,
  or fails. Companion runtime scope in parallel-agent-runtime. Closes
  vision-gap 3.4.
- [active/intelligent-cutovers-pr-plan.md](active/intelligent-cutovers-pr-plan.md)
  — 15-PR decomposition covering the deterministic cutover engine (fast
  loop) plus the router agent (slow loop): provider-failure event
  persistence, agent-callable routing tools with change audit, and
  per-workspace router-agent bootstrap with a scheduled optimization
  task. Concrete file paths, dependencies, and acceptance criteria per
  PR across platform, runtime, and helper.
- [active/large-file-refactor-checklist.md](active/large-file-refactor-checklist.md)
  — Tracker for files over 500 lines.
- [active/large-file-refactor-pr-plan.md](active/large-file-refactor-pr-plan.md)
  — PR-by-PR scoping for the top 10 refactor targets identified in the
  checklist.
- [active/learning-sidecar-scope.md](active/learning-sidecar-scope.md)
  — Hermes-style learning layer for the parallel-agent stack: workspace-scoped
  memory persistence, post-run reflection, prompt-time retrieval, and
  PR-gated skill distillation on top of the existing `memory_items` table.
- [active/learning-sidecar-pr-plan.md](active/learning-sidecar-pr-plan.md)
  — PR-by-PR sequence for the learning sidecar across harper-server,
  parallel-agent-platform, and parallel-agent-runtime, including the
  small migration footprint.
- [active/learning-sidecar-production-readiness-scope.md](active/learning-sidecar-production-readiness-scope.md)
  — Get the learning loop actually running in prod. Fixes the verified
  runtime↔platform break: the runtime POSTs `/api/learning/jobs/<kind>` but
  the platform only registers a reflection-only path, so reflection 404s and
  distillation has no route. Converges both repos on one endpoint that reuses
  the existing dispatcher, plus prod config + rollout + verification.
- [active/local-chat-deprecation-scope.md](active/local-chat-deprecation-scope.md)
  — Phase out `/local-chat` and route coding-agent local-model traffic
  through the Runtime relay path.
- [active/local-openclaw-helper-scope.md](active/local-openclaw-helper-scope.md)
  — Add OpenClaw as a first-class local-runtime kind: wizard, install command,
  routing-rule editor; cross-repo plan (platform, runtime, helper, harper-server).
- [active/manager-as-regular-agent-scope.md](active/manager-as-regular-agent-scope.md)
  — Stop treating manager agents as a separate runtime + platform surface;
  collapse SessionResolver, Runner.Manager, dual-write, and manager-only
  routes into the generic agent path. Scheduler stays.
- [active/manager-agent-scheduled-work-scope.md](active/manager-agent-scheduled-work-scope.md)
  — Scope natural-language recurring manager work: inventory existing
  scheduler/work-item/cron tables, propose scheduled-work materialization, and
  outline platform/runtime PRs.
- [active/manager-pr-review-fallback-scope.md](active/manager-pr-review-fallback-scope.md)
  — Scope the manager-agent PR review fallback: detect existing GitHub
  auto-review, avoid duplicate reviews per PR head SHA, and dispatch a
  cross-model reviewer only when review is missing.
- [active/local-helper-architecture-drift-pr-plan.md](active/local-helper-architecture-drift-pr-plan.md)
  — Quarantine legacy direct local-chat helper behavior from the current relay
  helper architecture.
- [active/local-helper-page-scope.md](active/local-helper-page-scope.md)
  — Guided "Local computer" wizard in `/settings/local-models`: closes the
  manager-binding gap, adds presence + install one-liner + invisible tokens.
- [active/local-runtime-shared-routes-pr-plan.md](active/local-runtime-shared-routes-pr-plan.md)
  — Shared local-runtime route builders for API registration and web clients.
- [active/onboarding-flow-scope.md](active/onboarding-flow-scope.md)
  — First-run UX scope: sign-up, login, and one-step-per-card path to a
  running agent (cloud key or local model bypass).
- [active/plan-fanout-dashboard-scope.md](active/plan-fanout-dashboard-scope.md)
  — Plan-as-fanout dashboard scope plus planner `task.create` contract
  hardening so created work items are orchestrator-ready.
- [active/policy-trust-dial-scope.md](active/policy-trust-dial-scope.md)
  — Implement OQ-06's escalation policy as the workspace trust dial:
  `EscalationPolicy` schema, `escalation` table, `escalate_to_human`
  tool, per-task cost overrides, policy editor UI. Companion runtime
  scope in parallel-agent-runtime. Closes vision-gap 4.6; foundation
  for 4.1, 4.3, and 4.5.
- [active/production-container-tool-execution-scope.md](active/production-container-tool-execution-scope.md)
  — Production container execution for tool calls.
- [active/query-invalidation-large-file-refactor.md](active/query-invalidation-large-file-refactor.md)
  — Split the frontend query invalidation module into focused helpers while
  keeping the public facade stable.
- [active/provider-execution-adapter-rollout-scope.md](active/provider-execution-adapter-rollout-scope.md)
  — Add execution adapters for xAI, Google (Gemini), Mistral, Groq,
  OpenRouter, Together, Perplexity, Azure OpenAI, and Bedrock so all
  credential-storing providers can actually run agent turns. Closes
  vision-gap 2.2.
- [active/typing-hardening-scope.md](active/typing-hardening-scope.md) —
  Tighten TypeScript types and eliminate unsafe casts.
- [active/unified-execution-profile-scope.md](active/unified-execution-profile-scope.md)
  — Consolidate model/provider/credential/runner-kind selection into one value
  type, one picker, one write, one default.
- [active/universal-tool-calling-plan.md](active/universal-tool-calling-plan.md)
  — Universal tool-calling schema and execution plan.
- [active/vision-gap-scoping-restart.md](active/vision-gap-scoping-restart.md)
  — Working queue for restarting scope docs for vision-gap items that
  still lack dedicated implementation scopes.
- [active/web-ui-component-standardization-scope.md](active/web-ui-component-standardization-scope.md)
  — Standardize reused web UI primitives such as buttons, navigation controls,
  alerts, segmented controls, empty states, status tones, and form fields.

## Reference

Durable design and process docs.

- [reference/product-vision.md](reference/product-vision.md) — Product goals
  and principles.
- [reference/testing-strategy.md](reference/testing-strategy.md) — Platform
  testing strategy and expectations.
- [reference/tool-crud-conventions.md](reference/tool-crud-conventions.md) —
  Agent tool naming and cross-repo update requirements for database-backed
  resources.
- [reference/end-to-end-local-runbook.md](reference/end-to-end-local-runbook.md)
  — Local end-to-end runbook for platform/runtime verification.
- [reference/implementation-checklist.md](reference/implementation-checklist.md)
  — Ongoing API contract alignment checklist.
- [reference/auth-jwt-design.md](reference/auth-jwt-design.md) — JWT auth
  design for browser-facing API calls.
- [reference/auth-user-vs-app-user.md](reference/auth-user-vs-app-user.md) —
  Auth user vs application user identity model.
- [reference/contracts-directory-guidelines.md](reference/contracts-directory-guidelines.md)
  — Shared contract ownership and usage guidelines.
- [reference/frontend-data-refresh-react-query.md](reference/frontend-data-refresh-react-query.md)
  — React Query data-refresh conventions, freshness classes, invalidation, and
  cross-tab behavior.
- [reference/execution-profile-contract.md](reference/execution-profile-contract.md)
  — Computed agent execution profiles, provider/runner separation, credential
  references.
- [reference/codex-oauth-coding-agent.md](reference/codex-oauth-coding-agent.md)
  — Runtime contract, diagnostics, and live-smoke runbook for coding agents
  using ChatGPT/Codex OAuth instead of OpenAI API keys.
- [reference/launcher-architecture-and-cross-repo-integration.md](reference/launcher-architecture-and-cross-repo-integration.md)
  — Cross-repo integration spec for launcher, API server proxy, orchestrator.
- [reference/planning-agent-readonly-architecture.md](reference/planning-agent-readonly-architecture.md)
  — Capability-based planning agent architecture (read-only repo tools).
- [reference/closed-loop-agent-observability.md](reference/closed-loop-agent-observability.md)
  — Observability principles and identifiers.
- [reference/database-schema-diagnostics.md](reference/database-schema-diagnostics.md)
  — Schema diagnostic tool reference.
- [reference/resolver-routing-note.md](reference/resolver-routing-note.md) —
  External reference and platform notes for resolver-style routing.
- [reference/hardening-and-reuse-opportunities.md](reference/hardening-and-reuse-opportunities.md)
  — Catalog of follow-up hardening and reuse opportunities.
- [reference/oq-04-credentials-pr-plan.md](reference/oq-04-credentials-pr-plan.md)
  — Canonical credentials implementation scope spanning multiple PRs.
- [decision-records/README.md](decision-records/README.md) — ADRs for code
  organization.
