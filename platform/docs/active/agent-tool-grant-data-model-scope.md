# Agent Tool Grant Data Model - Platform Scope

## Goal

Move Platform from legacy assignment/bundle semantics to the Harper Server
grant-based tool policy model:

- `tool_policy_template` and `tool_policy_template_tool` are write-time
  presets.
- `agent_tool_grant` is the runtime source of truth for an agent's effective
  tools.
- Runtime and Platform tool resolution read effective grants only.
- Applying a template writes concrete `agent_tool_grant` rows.
- User edits mutate `agent_tool_grant` rows.

This replaces all Platform use of:

- `agent.tool_bundles`
- `agent_tool` as the effective assignment table
- `agent_tool.included`
- hardcoded default tool bundle maps as runtime policy

## Runtime Invariant

Tool availability must be evaluated from the database at agent start or turn
preparation:

```sql
select tool.*
from agent_tool_grant grant
join tool on tool.id = grant.tool_id
where grant.agent_id = :agent_id
  and grant.workspace_id = :workspace_id
  and grant.mode = 'include'
  and tool.enabled = true;
```

Templates are not runtime subscriptions. A template update does not silently
change existing agents. To change an agent's tools, Platform updates
`agent_tool_grant`.

## Data Model

Harper Server owns the migration.

### `tool_policy_template`

Preset definitions such as `planner`, `coding`, `manager`, `repo_read`,
`repo_write`, and `local_model_coding`.

Platform uses this table to:

- list available presets in settings/onboarding
- apply default presets for new agents
- show provenance for grants created from a preset

### `tool_policy_template_tool`

Preset membership. This table is only used when applying or previewing a
template.

### `agent_tool_grant`

Effective per-agent policy.

Important fields:

- `agent_id`
- `tool_id`
- `workspace_id`
- `mode`: `include` or `exclude`
- `source`: `template`, `manual`, `system`, or `migration`
- `source_tool_template_id`
- `reason`
- `created_by_user_id`

Resolution behavior:

- `include` means the tool is available.
- `exclude` means the tool is unavailable and the explicit user/system intent
  is preserved for UI and audit.
- If a tool has no grant row, it is unavailable.

## Platform Areas To Update

### Contracts

Files:

- `contracts/tool-definition.ts`
- `contracts/platform-api-contracts.ts`
- `apps/api/src/contracts/tool-definition-contract.test.ts`

Changes:

- Replace bundle/override contract names with template/grant contract names.
- Add schemas for `ToolPolicyTemplate`, `ToolPolicyTemplateTool`, and
  `AgentToolGrant`.
- Response for `GET /api/agents/:id/tools` should expose:
  - available templates
  - available tools
  - effective grants
  - resolved enabled tools
- Request shapes should mutate grants, not bundle selections.

### Generated Supabase Types

Files:

- `packages/supabase-schema/src/database.types.ts`

Changes:

- Regenerate after the Harper Server migration is applied:
  `pnpm run db:schema:sync`.
- Do not hand-edit generated types.

### API Tool Resolution

Files:

- `apps/api/src/services/agent-tools.ts`
- `apps/api/src/services/local-chat-agent-tools.ts`
- `apps/api/src/services/runtime-dispatch-context.ts`

Changes:

- Resolve tools from `agent_tool_grant`.
- Remove reads from `agent.tool_bundles`.
- Remove effective-policy reads from `agent_tool`.
- Remove duplicated hardcoded bundle expansion from local chat.
- Keep workspace/global tool visibility and `tool.enabled` filtering.
- Ensure runtime dispatch and local chat use the same resolver.

### Default Agent Tool Setup

Files:

- `apps/api/src/services/default-agent-tools.ts`
- `apps/api/src/services/stored-agent-management.ts`
- `apps/api/src/services/stored-agent-routing.ts`
- `apps/api/src/routes/stored-agent-credentials.ts`

Changes:

- Replace `ensureDefaultAgentToolsForAgent` with an implementation that applies
  the correct `tool_policy_template` into `agent_tool_grant`.
- Default mapping:
  - planning agent -> `planner`
  - manager agent -> `manager`
  - regular coding agent -> `coding`
  - local model coding agent -> `local_model_coding`
- Applying a default template should be idempotent.
- Do not insert runtime policy rows into legacy `agent_tool`.

### Agent Tool Settings API

Files:

- `apps/api/src/routes/agent-tools.ts`
- `apps/api/src/routes/agent-tools.test.ts`
- `apps/api/src/services/agent-tools.test.ts`

Changes:

- Rename route behavior from bundle/override management to template/grant
  management.
- Candidate endpoint shape:
  - `GET /api/agents/:id/tools`
    returns templates, available tools, grants, and resolved tools.
  - `POST /api/agents/:id/tool-templates/:templateId/apply`
    applies a template by upserting include grants.
  - `PUT /api/agents/:id/tool-grants/:toolId`
    upserts an include or exclude grant.
  - `DELETE /api/agents/:id/tool-grants/:toolId`
    removes the grant row, making the tool unavailable unless another explicit
    operation adds it back.
- Keep authorization on workspace membership/admin rules consistent with the
  current settings API.

### Frontend Settings UI

Files:

- `apps/web/src/hooks/useToolDefinitions.ts`
- `apps/web/src/api/generated/platform-api-client.ts`
- `apps/web/src/components/agent-settings/ToolDefinitionsPanel.tsx`
- `apps/web/src/components/agent-settings/ToolDefinitionList.tsx`
- `apps/web/src/components/settings/AgentDetail.tsx`

Changes:

- Show templates as presets to apply, not as continuously selected bundles.
- Show effective grants as the current truth.
- Let users:
  - apply a template
  - include a tool
  - exclude/remove a tool
  - inspect provenance (`template`, `manual`, `system`, `migration`)
- UI should reflect the next runtime state after each save/reload.

### Tests

Files:

- `apps/api/src/services/agent-tools.test.ts`
- `apps/api/src/services/local-chat-agent-tools.test.ts`
- `apps/api/src/services/default-agent-tools.test.ts`
- `apps/api/src/services/stored-agent-routing.test.ts`
- `apps/api/src/routes/agent-tools.test.ts`
- `apps/api/src/contracts/tool-definition-contract.test.ts`
- frontend tests around `ToolDefinitionsPanel` if present

Coverage:

- default template application creates include grants
- manual include grant makes a tool available
- manual exclude grant makes a tool unavailable
- runtime resolver ignores templates and reads grants
- local chat resolver matches API resolver
- legacy `agent_tool` rows are no longer written by Platform

### Docs And Follow-Up Cleanup

Files:

- `docs/agent-tool-data-model-overhaul.md`
- `docs/universal-tool-calling-plan.md`
- `docs/hardcoded-scope-inventory.md`
- `docs/local-model-readiness-platform-prs.md`

Changes:

- Replace bundle/override language with template/grant language.
- Mark `agent_tool` and `agent.tool_bundles` as legacy only.
- Cross-link the Harper Server migration PR once merged.

## PR Sequence

### HS-1 - Harper Server Schema

Create:

- `tool_policy_template`
- `tool_policy_template_tool`
- `agent_tool_grant`

Seed templates and template membership. Backfill existing agents with concrete
grants. Preserve legacy `agent_tool` rows as `migration` include grants.

### PLAT-1 - Contracts And Generated Types

Regenerate Supabase types after HS-1 lands and update Zod contracts.

### PLAT-2 - Shared Grant Resolver

Implement one resolver for API runtime dispatch, settings, and local chat.

### PLAT-3 - Default Template Application

Replace default `agent_tool` materialization with idempotent grant creation
from templates.

### PLAT-4 - Settings API And UI

Expose template application and grant edits in agent settings.

### PLAT-5 - Legacy Cleanup

Remove all Platform policy-path references to:

- `agent.tool_bundles`
- `agent_tool`
- `included`

Keep non-policy tables such as `agent_tool_call_event`.

## Verification

Required before merging implementation PRs:

- `pnpm -C apps/api run validate`
- `pnpm exec tsc --noEmit -p apps/web/tsconfig.app.json`
- browser smoke for the agent settings tool editor
- runtime/local chat smoke confirming tool changes take effect on the next
  agent turn/start
