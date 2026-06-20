import { normalizeAgentType } from "../../../../../contracts/agents.js";
import type {
  DefaultAgentAssignmentUpdateRequest,
  DefaultAgentCredentialApplicationRequest,
  DefaultAgentRole,
  ManagerCredentialActivationRequest,
} from "../../../../../contracts/setup.js";
import type { CredentialReference } from "../../../../../contracts/credentials.js";
import { ApiRouteError } from "../../http.js";
import { findSetupAgentById, listSetupAgentRows } from "../../repositories/agents.js";
import {
  createAgentCredential,
  getCredentialRowByIdForWorkspace,
  resolveCredentialAlias,
} from "../../repositories/credentials.js";
import { getCredentialProviderMetadata } from "../../../../../contracts/credentials.js";
import { upsertAgentCredentialReferenceRule } from "../../repositories/routing-rules.js";
import { saveModelProviderCredentialForWorkspaceInSupabase } from "../saved-credentials.js";
import { resolveExecutionProfile } from "../execution-profile-resolver.js";
import {
  buildCredentialJson,
  buildRequirementStatusFromResolution,
  defaultAgentToolPolicy,
  managerToolPolicyDefaults,
} from "./builders.js";
import { updateAgentModelSettings, updateAgentRuntimeDefaults } from "./gateway-config.js";
import { requireCurrentUser, workspaceManagerAgentId } from "./identity.js";
import {
  ensureDefaultAgent,
  ensureWorkspaceManagerAgent,
  ensureWorkspaceRouterAgent,
  ensureDefaultWorkspace,
  getDefaultAssignment,
  getWorkspaceById,
  listWorkspaceMemberships,
  upsertDefaultAssignment,
  writeGatewayConfigForDefaultAgent,
  writeGatewayConfigForManagerAgent,
} from "./store.js";
import { mapDefaultAgentStatus, mapSetupAgent, mapWorkspace } from "./mappers.js";
import { DEFAULT_AGENT_ROLES, onboardingAgentDefaults, type OnboardingDefaultAgentRole } from "./defaults.js";
import type { AgentRow, DefaultAgentStatus } from "./types.js";

async function buildDefaultAgentStatus(
  accessToken: string,
  requesterUserId: string,
  agent: AgentRow,
): Promise<DefaultAgentStatus> {
  const resolution = await resolveExecutionProfile({ accessToken, requesterUserId, agentId: agent.id });

  return {
    agentId: agent.id,
    ...buildRequirementStatusFromResolution(resolution),
  };
}

export async function getDefaultAgentStatusForWorkspace(
  accessToken: string,
  verifiedUserId: string,
  workspaceId: string,
  role: DefaultAgentRole,
): Promise<DefaultAgentStatus | null> {
  const userId = requireCurrentUser(verifiedUserId);
  const assignment = await getDefaultAssignment(accessToken, workspaceId, userId, role);
  if (!assignment) return null;

  const agent = await findSetupAgentById(accessToken, assignment.agent_id);
  if (!agent) {
    return {
      agentId: assignment.agent_id,
      configured: false,
      missing: ["agent"],
    };
  }

  return buildDefaultAgentStatus(accessToken, userId, agent);
}

export async function listSetupAuthState(accessToken: string, verifiedUserId: string) {
  const userId = requireCurrentUser(verifiedUserId);
  const { workspace, workspaces } = await ensureDefaultWorkspace(accessToken, userId);
  const defaultAgents = {
    planning: await ensureDefaultAgent(accessToken, workspace.id, userId, "planning"),
    coding: await ensureDefaultAgent(accessToken, workspace.id, userId, "coding"),
  };
  const managerAgent = await ensureWorkspaceManagerAgent(accessToken, workspace.id, userId);
  const routerAgent = await ensureWorkspaceRouterAgent(accessToken, workspace.id, userId);

  const agentRows = await listSetupAgentRows(accessToken);
  const normalizedAgentRows = agentRows.map((agent) => ({
    ...agent,
    type: normalizeAgentType(agent.type),
  }));
  const agentById = new Map(normalizedAgentRows.map((agent) => [agent.id, agent]));
  for (const defaultAgent of Object.values(defaultAgents)) {
    if (!agentById.has(defaultAgent.id)) {
      const normalized = {
        ...defaultAgent,
        type: normalizeAgentType(defaultAgent.type),
      };
      normalizedAgentRows.push(normalized);
      agentById.set(normalized.id, normalized);
    }
  }
  if (!agentById.has(managerAgent.id)) {
    const normalized = {
      ...managerAgent,
      type: normalizeAgentType(managerAgent.type),
    };
    normalizedAgentRows.push(normalized);
    agentById.set(normalized.id, normalized);
  }
  if (!agentById.has(routerAgent.id)) {
    const normalized = {
      ...routerAgent,
      type: normalizeAgentType(routerAgent.type),
    };
    normalizedAgentRows.push(normalized);
    agentById.set(normalized.id, normalized);
  }

  const defaultAgentState = {
    planning: await buildDefaultAgentStatus(accessToken, userId, defaultAgents.planning),
    coding: await buildDefaultAgentStatus(accessToken, userId, defaultAgents.coding),
  };
  const managerAgentState = await buildDefaultAgentStatus(accessToken, userId, managerAgent);
  const defaultAgentIds = new Set(Object.values(defaultAgents).map((agent) => agent.id));
  const defaultSelectableAgents = normalizedAgentRows.filter(
    (agent) => agent.status === "active" && !["manager", "router"].includes(normalizeAgentType(agent.type)),
  );
  const configuredExistingAgents = (
    await Promise.all(
      defaultSelectableAgents
        .filter((agent) => !defaultAgentIds.has(agent.id))
        .map(async (agent) => ({
          agent,
          status: await buildDefaultAgentStatus(accessToken, userId, agent),
        })),
    )
  ).filter(({ status }) => status.configured);
  const onboardingReasons = DEFAULT_AGENT_ROLES.flatMap((role) =>
    defaultAgentState[role].missing.map((missing) => `${role}_missing_${missing}`),
  );
  const usableResolvedAgentId =
    (defaultAgentState.planning.configured ? defaultAgentState.planning.agentId : null) ??
    (defaultAgentState.coding.configured ? defaultAgentState.coding.agentId : null) ??
    configuredExistingAgents[0]?.agent.id ??
    null;
  const fallbackAgentId =
    defaultAgentState.planning.agentId ??
    defaultAgentState.coding.agentId ??
    defaultSelectableAgents.find((agent) => !defaultAgentIds.has(agent.id))?.id ??
    defaultSelectableAgents[0]?.id ??
    null;
  const resolvedAgentId = usableResolvedAgentId ?? fallbackAgentId;

  return {
    ready: true,
    userId,
    resolvedAgentId,
    workspaceId: workspace.id,
    workspaces: workspaces.map(mapWorkspace),
    agents: normalizedAgentRows.map(mapSetupAgent),
    defaultAgents: {
      planning: mapDefaultAgentStatus(defaultAgentState.planning),
      coding: mapDefaultAgentStatus(defaultAgentState.coding),
    },
    managerAgent: mapDefaultAgentStatus(managerAgentState),
    onboarding: {
      required: onboardingReasons.length > 0,
      blocking: !usableResolvedAgentId,
      reasons: onboardingReasons,
    },
  };
}

async function assertCredentialReferenceForWorkspace(input: {
  workspaceId: string;
  credentialRef: CredentialReference;
}): Promise<CredentialReference> {
  if (input.credentialRef.type === "alias") {
    const alias = await resolveCredentialAlias(input.workspaceId, input.credentialRef.value);
    if (!alias) throw new ApiRouteError(404, "credential_alias_not_found", "Credential alias was not found");
    return { type: "alias", value: alias.alias };
  }

  const credential = await getCredentialRowByIdForWorkspace(input.credentialRef.value, input.workspaceId);
  if (!credential) throw new ApiRouteError(404, "credential_not_found", "Credential was not found");
  return { type: "credential_id", value: credential.id };
}

export async function activateManagerAgentCredentials(
  accessToken: string,
  verifiedUserId: string,
  input: ManagerCredentialActivationRequest,
) {
  const userId = requireCurrentUser(verifiedUserId);
  const workspace = await getWorkspaceById(accessToken, input.workspaceId);
  if (!workspace) {
    throw new ApiRouteError(404, "workspace_not_found", "Workspace was not found");
  }

  const memberships = await listWorkspaceMemberships(accessToken, userId);
  if (!memberships.some((membership) => membership.workspace_id === input.workspaceId)) {
    throw new ApiRouteError(403, "workspace_forbidden", "Workspace is not available to the authenticated user");
  }

  const agent = await findSetupAgentById(accessToken, input.agentId);
  if (!agent) {
    throw new ApiRouteError(404, "agent_not_found", "Manager agent was not found");
  }
  if (agent.workspace_id !== input.workspaceId) {
    throw new ApiRouteError(400, "workspace_mismatch", "Manager agent does not belong to the selected workspace");
  }
  if (normalizeAgentType(agent.type) !== "manager") {
    throw new ApiRouteError(400, "manager_agent_required", "Selected agent is not a manager agent");
  }

  const savedCredential = input.newCredential
    ? await saveModelProviderCredentialForWorkspaceInSupabase({
        workspaceId: input.workspaceId,
        userId,
        provider: input.provider,
        apiKey: input.newCredential.apiKey,
        label: input.newCredential.label,
      })
    : null;
  const credentialRef: CredentialReference = savedCredential
    ? { type: "credential_id", value: savedCredential.credentialRowId ?? savedCredential.id.split(":", 1)[0] ?? "" }
    : await assertCredentialReferenceForWorkspace({
        workspaceId: input.workspaceId,
        credentialRef: input.credentialRef as CredentialReference,
      });

  if (!credentialRef?.value) {
    throw new ApiRouteError(502, "credential_save_failed", "Credential persistence returned no reusable reference");
  }

  await updateAgentModelSettings(accessToken, agent.id, input.model);
  await upsertAgentCredentialReferenceRule({
    agentId: agent.id,
    workspaceId: input.workspaceId,
    runnerKind: "llm_tool_runner",
    provider: input.provider,
    model: input.model,
    credentialRef,
  });
  await writeGatewayConfigForManagerAgent({
    accessToken,
    userId,
    agent,
    provider: input.provider,
    model: input.model,
    runnerKind: "llm_tool_runner",
    cadenceMs: input.cadenceMs,
  });

  return listSetupAuthState(accessToken, userId);
}

export async function updateDefaultAgentAssignment(
  accessToken: string,
  verifiedUserId: string,
  input: DefaultAgentAssignmentUpdateRequest,
) {
  const userId = requireCurrentUser(verifiedUserId);
  const workspace = await getWorkspaceById(accessToken, input.workspaceId);
  if (!workspace) {
    throw new ApiRouteError(404, "workspace_not_found", "Workspace was not found");
  }

  const memberships = await listWorkspaceMemberships(accessToken, userId);
  if (!memberships.some((membership) => membership.workspace_id === input.workspaceId)) {
    throw new ApiRouteError(403, "workspace_forbidden", "Workspace is not available to the authenticated user");
  }

  const agent = await findSetupAgentById(accessToken, input.agentId);
  if (!agent) {
    throw new ApiRouteError(404, "agent_not_found", "Agent was not found");
  }
  if (agent.workspace_id !== input.workspaceId) {
    throw new ApiRouteError(400, "workspace_mismatch", "Agent does not belong to the selected workspace");
  }

  const agentRole = normalizeAgentType(agent.type);
  if (agentRole !== input.role) {
    throw new ApiRouteError(
      400,
      "default_role_mismatch",
      `A ${input.role} default must reference a ${input.role} agent`,
      { agent_type: agentRole },
    );
  }

  await upsertDefaultAssignment(accessToken, input.workspaceId, userId, input.role, input.agentId, "user_selected");
  return listSetupAuthState(accessToken, userId);
}

export async function applyDefaultAgentCredentials(
  accessToken: string,
  verifiedUserId: string,
  input: DefaultAgentCredentialApplicationRequest,
) {
  const userId = requireCurrentUser(verifiedUserId);
  const workspace = await getWorkspaceById(accessToken, input.workspaceId);
  if (!workspace) {
    throw new ApiRouteError(404, "workspace_not_found", "Workspace was not found");
  }

  const memberships = await listWorkspaceMemberships(accessToken, userId);
  if (!memberships.some((membership) => membership.workspace_id === input.workspaceId)) {
    throw new ApiRouteError(403, "workspace_forbidden", "Workspace is not available to the authenticated user");
  }

  const assignments = await Promise.all(
    DEFAULT_AGENT_ROLES.map(async (role) => ({
      role,
      assignment: await getDefaultAssignment(accessToken, input.workspaceId, userId, role),
    })),
  );
  const agentIds = Array.from(new Set(input.agentIds));
  if (input.provider !== "openai") {
    const requestedAgents = await Promise.all(agentIds.map((agentId) => findSetupAgentById(accessToken, agentId)));
    if (
      agentIds.includes(workspaceManagerAgentId(input.workspaceId)) ||
      requestedAgents.some((agent) => normalizeAgentType(agent?.type) === "manager")
    ) {
      throw new ApiRouteError(
        400,
        "manager_provider_not_supported",
        "The manager agent can only be configured with an OpenAI credential during onboarding",
        { provider: input.provider },
      );
    }
  }
  const managerAgent = await ensureWorkspaceManagerAgent(accessToken, input.workspaceId, userId);
  const roleByAgentId = new Map<string, OnboardingDefaultAgentRole>();
  for (const { role, assignment } of assignments) {
    if (assignment) roleByAgentId.set(assignment.agent_id, role);
  }
  roleByAgentId.set(managerAgent.id, "manager");

  const unauthorizedAgentIds = agentIds.filter((agentId) => !roleByAgentId.has(agentId));
  if (unauthorizedAgentIds.length > 0) {
    throw new ApiRouteError(
      403,
      "default_agent_forbidden",
      "Selected agents must be assigned defaults for the authenticated user and workspace",
      { agent_ids: unauthorizedAgentIds },
    );
  }

  const credential = {
    provider: input.provider,
    label: input.label,
    keyName: input.keyName ?? getCredentialProviderMetadata(input.provider).envVar,
    secret: input.secret,
  };

  for (const agentId of agentIds) {
    const role = roleByAgentId.get(agentId);
    if (!role) continue;

    const agent = await findSetupAgentById(accessToken, agentId);
    if (!agent || agent.workspace_id !== input.workspaceId) {
      throw new ApiRouteError(403, "default_agent_forbidden", "Selected agent is not in the requested workspace");
    }

    const defaults = onboardingAgentDefaults({
      provider: input.provider,
      role,
      modelOverride: input.model,
    });
    if (!defaults) {
      throw new ApiRouteError(
        400,
        "default_model_not_available",
        "A model override is required for this credential provider",
        { provider: input.provider, agent_type: role },
      );
    }
    const toolPolicy = role === "manager" ? managerToolPolicyDefaults() : defaultAgentToolPolicy(role);

    await updateAgentRuntimeDefaults(accessToken, agent.id, defaults.model, toolPolicy);

    const savedCredential = await createAgentCredential({
      agentId: agent.id,
      workspaceId: input.workspaceId,
      userId,
      credentialKey: buildCredentialJson(credential),
      accessToken,
    });
    // The credential row only points to the agent; runtime resolution
    // reads `routing_rule` to find which credential to use. Without a
    // matching routing rule, the platform API reports "no credential
    // reference" for the agent even though a credential row exists,
    // and the dashboard ends up stuck in a start-loop because it
    // never sees the agent become ready. We mirror what the per-agent
    // credential save path (POST /api/credentials) already does via
    // syncCredentialIntoRoutingRuleForAgent. `defaults.runnerKind`
    // comes from the canonical `DEFAULT_RUNNER_KIND_BY_AGENT_TYPE`
    // map, so the rule we write here agrees with the gateway_config
    // that `writeGatewayConfigForDefaultAgent` writes next.
    if (savedCredential?.id) {
      await upsertAgentCredentialReferenceRule({
        agentId: agent.id,
        workspaceId: input.workspaceId,
        runnerKind: defaults.runnerKind,
        provider: input.provider,
        model: defaults.model,
        credentialRef: { type: "credential_id", value: savedCredential.id },
      });
    }

    if (role === "manager") {
      await writeGatewayConfigForManagerAgent({
        accessToken,
        userId,
        agent,
        provider: input.provider,
        model: defaults.model,
        runnerKind: "llm_tool_runner",
      });
    } else {
      await writeGatewayConfigForDefaultAgent(
        accessToken,
        userId,
        agent,
        role,
        input.provider,
        defaults.model,
        defaults.runnerKind,
      );
    }
  }

  return listSetupAuthState(accessToken, userId);
}
