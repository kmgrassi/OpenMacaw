import { ApiRouteError } from "../../http.js";
import { getCredentialRowByIdForWorkspace, resolveCredentialAlias } from "../../repositories/credentials.js";
import { listStoredAgentsFromSupabase } from "../../services/stored-agent-management.js";

type CredentialReferenceInput = {
  type: "credential_id" | "alias";
  value: string;
} | null;

export type StoredAgentRouteRecord = Awaited<ReturnType<typeof listStoredAgentsFromSupabase>>[number];

export async function assertCredentialReferenceBelongsToWorkspace(input: {
  workspaceId: string;
  credentialRef: CredentialReferenceInput;
}) {
  if (!input.credentialRef) return null;

  if (input.credentialRef.type === "alias") {
    const alias = await resolveCredentialAlias(input.workspaceId, input.credentialRef.value);
    if (!alias) {
      throw new ApiRouteError(404, "credential_alias_not_found", "Credential alias was not found");
    }
    return alias.credential_id;
  }

  const credential = await getCredentialRowByIdForWorkspace(input.credentialRef.value, input.workspaceId);
  if (!credential) {
    throw new ApiRouteError(404, "credential_not_found", "Credential was not found");
  }
  return credential.id;
}

export async function requireStoredAgent(input: {
  accessToken: string;
  userId: string;
  agentId: string;
  workspaceId?: string | null;
}): Promise<StoredAgentRouteRecord> {
  const agents = await listStoredAgentsFromSupabase({
    accessToken: input.accessToken,
    userId: input.userId,
  });
  const agent = agents.find((candidate) => candidate.id === input.agentId);
  if (!agent || (input.workspaceId && agent.workspaceId !== input.workspaceId)) {
    throw new ApiRouteError(404, "agent_not_found", "Stored agent was not found");
  }
  return agent;
}
