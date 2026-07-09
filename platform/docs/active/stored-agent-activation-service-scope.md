# Stored Agent Activation Service Cleanup

Status: active scoping. Created 2026-07-08.

## Problem

`apps/api/src/routes/stored-agent-credentials/activation-route-handlers.ts`
contains two route handlers that implement the same core flow with slightly
different HTTP behavior:

- authorize access to the stored agent
- parse and review the optional planning handoff
- resolve the execution profile and require a Codex runner
- list saved credentials and pick one
- resolve the secret, validate it, and persist validation state
- launch the worker session and shape the response

That duplication makes the launch path and the activate path easy to drift apart
when credential selection, validation, or launcher payloads change.

## Scope

This cleanup PR:

1. Extracts a shared stored-agent activation service under
   `apps/api/src/services/`.
2. Moves common credential selection, validation, and worker launch orchestration
   into that service.
3. Keeps the current HTTP contract intact, including the different validation
   failure behavior for `/credentials/:credentialId/launch` vs `/activate`.
4. Adds focused service tests for both selection modes and validation-failure
   shaping.

## Non-Goals

- Changing the stored credential response schema.
- Changing launcher semantics or execution-profile resolution behavior.
- Refactoring unrelated stored-agent credential list/save/reference routes.

## Validation

- `pnpm -C apps/api run test -- stored-agent`
- `pnpm -C apps/api run validate`
