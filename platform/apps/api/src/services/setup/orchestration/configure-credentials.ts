import { normalizeAgentType } from "../../../../../../contracts/agents.js";
import { getCredentialProviderMetadata, normalizeCredentialProvider } from "../../../../../../contracts/credentials.js";
import type { AgentCredentialConfigurationRequest } from "../../../../../../contracts/setup.js";
import { ApiRouteError } from "../../../http.js";
import { findSetupAgentById } from "../../../repositories/agents.js";
import { createAgentCredential, getCredentialRowByIdForWorkspace } from "../../../repositories/credentials.js";
import { buildCredentialJson } from "../builders.js";
import { updateAgentModelSettings } from "../gateway-config.js";
import { requireCurrentUser } from "../identity.js";
import { getWorkspaceById, listWorkspaceMemberships, writeGatewayConfigForDefaultAgent } from "../store.js";
import { assembleSetup } from "./assemble.js";

export async function configureSetupAgentCredentialsImpl(
  accessToken: string,
  verifiedUserId: string,
  input: AgentCredentialConfigurationRequest,
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

  const role = normalizeAgentType(agent.type);
  if (role === "custom" || role === "manager" || role === "router") {
    throw new ApiRouteError(
      400,
      `${role}_agent_configuration_unsupported`,
      role === "custom"
        ? "Custom agents require a backend adapter configuration before credentials can be applied here"
        : role === "router"
          ? "Router agent credential activation is handled by the routing execution profile flow"
          : "Manager agent credential activation is handled by the manager execution profile flow",
    );
  }

  await updateAgentModelSettings(accessToken, agent.id, input.model);

  if (input.credentialId) {
    // Reuse a stored workspace credential. Runtime resolution matches by
    // (provider, workspace) so no new credential row is needed — we only
    // verify the selected credential exists and matches the chosen provider.
    await requireWorkspaceCredentialForProvider(input.credentialId, input.workspaceId, input.provider);
  } else if (input.secret) {
    await createAgentCredential({
      agentId: agent.id,
      workspaceId: input.workspaceId,
      userId,
      credentialKey: buildCredentialJson({
        provider: input.provider,
        label: input.label,
        keyName: input.keyName ?? getCredentialProviderMetadata(input.provider).envVar,
        secret: input.secret,
      }),
      accessToken,
    });
  }

  await writeGatewayConfigForDefaultAgent(accessToken, userId, agent, role, input.provider, input.model);
  return assembleSetup(accessToken, userId, agent.id);
}

// Verifies a stored workspace credential exists and matches the selected
// provider. Returns the credential row id so callers can reference it.
export async function requireWorkspaceCredentialForProvider(
  credentialId: string,
  workspaceId: string,
  provider: string,
): Promise<string> {
  const existing = await getCredentialRowByIdForWorkspace(credentialId, workspaceId);
  if (!existing) {
    throw new ApiRouteError(404, "credential_not_found", "Selected credential was not found in this workspace");
  }
  if (normalizeCredentialProvider(existing.provider) !== normalizeCredentialProvider(provider)) {
    throw new ApiRouteError(
      400,
      "credential_provider_mismatch",
      "Selected credential does not match the chosen provider",
      { credential_provider: existing.provider, requested_provider: provider },
    );
  }
  return existing.id;
}
