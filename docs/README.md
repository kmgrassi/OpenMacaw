# OpenMacaw Docs

This directory holds OpenMacaw-level documentation: material that applies to
the combined platform, runtime, and local helper repository.

## Start here

- The root README documents `./openmacaw run`, the default command for starting
  the local platform and runtime stack, plus prerequisites and environment
  setup.
- [Supabase setup](supabase/README.md) covers the local database quick start
  and the hosted-project migration workflow.
- The [end-to-end local runbook](../platform/docs/reference/end-to-end-local-runbook.md)
  is the first-run verification checklist: login, onboarding, and sending a
  first agent message.
- The [manual testing inventory](../platform/docs/reference/manual-testing-inventory.md)
  lists the broader human QA flows across setup, auth, onboarding, dashboard,
  settings, plans, runtime, helper, diagnostics, and release smoke checks.
- [Open source readiness scope](open-source-readiness-scope.md) defines the
  remaining work to make OpenMacaw understandable, runnable, auditable, and
  maintainable for external developers and self-hosters.
- [OpenMacaw vs. OpenClaw vs. Hermes](openmacaw-vs-openclaw-hermes.md) explains
  how OpenMacaw relates to those two adjacent agent projects — always-on cloud
  orchestration with local-model routing, OpenClaw integrated as a runner kind,
  and Hermes's learning ideas adapted into an optional workspace sidecar.

## Subsystem docs

The imported subsystems still keep most of their original documentation in
their own directories:

- `platform/docs/` for platform/API/web contracts, runbooks, active scopes, and
  generated schema guidance.
- `runtime/docs/` and `runtime/apps/orchestrator/docs/` for runtime,
  orchestrator, launcher, relay, smoke, and scheduling docs.
- `local-runtime-helper/docs/` for helper install, runtime config, relay, and
  local runner docs.

Those docs have not all been rewritten for public OpenMacaw context. When a
document still refers to old repository names, private GitHub URLs, Harper-only
infrastructure, or stale prototype status, treat that as part of the open-source
readiness cleanup rather than as the final public position.

## Documentation lifecycle

Use repository-level docs for durable cross-subsystem guidance. Keep
subsystem-specific implementation details next to the subsystem they describe.

Historical planning documents can remain useful, but public entrypoints should
link to stable reference docs before linking to active scopes, shipped PR
plans, or superseded material.
