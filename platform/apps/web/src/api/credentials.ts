import {
  AgentCredentialReferenceResponseSchema,
  CreateCredentialResponseSchema,
  CredentialAliasListResponseSchema,
  StoredCredentialActivationResponseSchema,
  SavedCredentialListResponseSchema,
  UpsertCredentialAliasResponseSchema,
  type CodingHandoffRequest,
  type AgentCredentialReferenceResponse,
  type CredentialAlias,
  type CredentialScope,
  type CredentialReference,
  type CredentialProvider,
  type CreateCredentialResponse,
  type SavedCredential,
  type StoredCredentialActivationResponse,
} from "../../../../contracts/credentials";
import { apiFetch } from "./client";
import { ROUTES } from "./routes";
export type {
  CredentialProvider,
  CredentialScope,
  SavedCredential,
  CreateCredentialResponse,
  StoredCredentialActivationResponse,
  CredentialAlias,
  CredentialReference,
  AgentCredentialReferenceResponse,
} from "../../../../contracts/credentials";

export async function listSavedCredentialsForAgent(
  agentId: string,
  workspaceId: string,
): Promise<SavedCredential[]> {
  const body = await apiFetch(
    `${ROUTES.storedAgentCredentials(agentId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    {
      method: "GET",
      schema: SavedCredentialListResponseSchema,
      defaultErrorMessage: (status) =>
        `Failed to load stored credentials (${status})`,
    },
  );
  return body.credentials;
}

export async function listSavedCredentialsForWorkspace(
  workspaceId: string,
): Promise<SavedCredential[]> {
  const body = await apiFetch(
    `${ROUTES.credentials}?workspaceId=${encodeURIComponent(workspaceId)}`,
    {
      method: "GET",
      schema: SavedCredentialListResponseSchema,
      defaultErrorMessage: (status) =>
        `Failed to load workspace credentials (${status})`,
    },
  );
  return body.credentials;
}

export async function listCredentialAliases(
  workspaceId: string,
): Promise<CredentialAlias[]> {
  const body = await apiFetch(
    `${ROUTES.credentialAliases}?workspaceId=${encodeURIComponent(workspaceId)}`,
    {
      method: "GET",
      schema: CredentialAliasListResponseSchema,
      defaultErrorMessage: (status) =>
        `Failed to load credential aliases (${status})`,
    },
  );
  return body.aliases;
}

export async function saveCredentialAlias(input: {
  workspaceId: string;
  alias: string;
  credentialId: string;
}): Promise<CredentialAlias> {
  const body = await apiFetch(ROUTES.credentialAlias(input.alias), {
    method: "PUT",
    body: input,
    schema: UpsertCredentialAliasResponseSchema,
    defaultErrorMessage: (status) =>
      `Failed to save credential alias (${status})`,
  });

  return body.alias;
}

export async function getAgentCredentialReference(
  agentId: string,
  workspaceId: string,
): Promise<AgentCredentialReferenceResponse> {
  return apiFetch(
    `${ROUTES.storedAgentCredentialReference(agentId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    {
      method: "GET",
      schema: AgentCredentialReferenceResponseSchema,
      defaultErrorMessage: (status) =>
        `Failed to load credential reference (${status})`,
    },
  );
}

export async function saveAgentCredentialReference(input: {
  agentId: string;
  workspaceId: string;
  runnerKind?: string;
  provider?: string | null;
  model?: string | null;
  localModelId?: string | null;
  localEndpointUrl?: string | null;
  credentialRef: CredentialReference | null;
}): Promise<AgentCredentialReferenceResponse> {
  return apiFetch(ROUTES.storedAgentCredentialReference(input.agentId), {
    method: "PUT",
    body: {
      workspaceId: input.workspaceId,
      runnerKind: input.runnerKind,
      provider: input.provider,
      model: input.model,
      localModelId: input.localModelId,
      localEndpointUrl: input.localEndpointUrl,
      credentialRef: input.credentialRef,
    },
    schema: AgentCredentialReferenceResponseSchema,
    defaultErrorMessage: (status) =>
      `Failed to save credential reference (${status})`,
  });
}

export async function launchSavedCredential(
  agentId: string,
  credentialId: string,
  workspaceId: string,
  handoff?: CodingHandoffRequest | null,
): Promise<StoredCredentialActivationResponse> {
  return apiFetch(
    ROUTES.storedAgentCredentialLaunch(agentId, credentialId),
    {
      method: "POST",
      body: { workspaceId, handoff: handoff ?? null },
      schema: StoredCredentialActivationResponseSchema,
      defaultErrorMessage: (status) =>
        `Failed to launch stored credential (${status})`,
    },
  );
}

export async function activateStoredAgent(
  agentId: string,
  workspaceId: string,
) {
  return apiFetch(ROUTES.storedAgentActivate(agentId), {
    method: "POST",
    body: { workspaceId },
    schema: StoredCredentialActivationResponseSchema,
    defaultErrorMessage: (status) =>
      `Failed to activate stored agent (${status})`,
  });
}

export async function saveStoredCredential(input: {
  scope: CredentialScope;
  provider: CredentialProvider;
  apiKey: string;
  endpoint?: string;
  apiVersion?: string;
  alias?: string;
}): Promise<CreateCredentialResponse> {
  return apiFetch(ROUTES.credentials, {
    method: "POST",
    body: {
      scope: input.scope,
      key: {
        format: "api_key",
        provider: input.provider,
        secret: input.apiKey,
        endpoint: input.endpoint,
        apiVersion: input.apiVersion,
      },
      alias: input.alias,
    },
    schema: CreateCredentialResponseSchema,
    defaultErrorMessage: (status) =>
      `Failed to save stored credential (${status})`,
  });
}
