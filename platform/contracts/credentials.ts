import { z } from "zod";

import { ExecutionProfileResolutionSchema } from "./execution-profile.js";
import { ModelTierFloorSchema } from "./model-tiers.js";
import {
  CREDENTIAL_PROVIDERS,
  CREDENTIAL_PROVIDER_REGISTRY,
  CredentialProviderSchema,
  LaunchableKindSchema,
} from "./provider-registry.js";

export {
  CREDENTIAL_PROVIDERS,
  CREDENTIAL_PROVIDER_REGISTRY,
  CredentialProviderSchema,
  LaunchableKindSchema,
} from "./provider-registry.js";

export const SavedCredentialSchema = z.object({
  id: z.string(),
  credentialRowId: z.string().optional(),
  agentId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  provider: z.string().nullable(),
  label: z.string(),
  envVar: z.string(),
  updatedAt: z.string(),
  validationState: z
    .enum(["ok", "invalid", "expired", "unknown"])
    .default("unknown"),
  validatedAt: z.string().nullable().default(null),
  launchableKind: LaunchableKindSchema,
});

export const SavedCredentialListResponseSchema = z.object({
  credentials: z.array(SavedCredentialSchema),
});

export const CredentialReferenceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("credential_id"),
    value: z.string().min(1),
  }),
  z.object({
    type: z.literal("alias"),
    value: z.string().min(1),
  }),
]);

export const CredentialAliasSchema = z.object({
  workspaceId: z.string(),
  alias: z.string(),
  credentialId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  credential: SavedCredentialSchema.nullable().default(null),
});

export const CredentialAliasListResponseSchema = z.object({
  aliases: z.array(CredentialAliasSchema),
});

export const UpsertCredentialAliasRequestSchema = z.object({
  workspaceId: z.string().min(1),
  alias: z.string().trim().min(1).max(64),
  credentialId: z.string().min(1),
});

export const UpsertCredentialAliasResponseSchema = z.object({
  alias: CredentialAliasSchema,
});

export const AgentCredentialReferenceSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string(),
  runnerKind: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  credentialRef: CredentialReferenceSchema.nullable(),
  fallbacks: z
    .array(
      z.object({
        provider: z.string().trim().min(1),
        model: z.string().trim().min(1),
        credentialRef: CredentialReferenceSchema.nullable(),
      }),
    )
    .default([]),
  modelTierFloor: ModelTierFloorSchema.default("any"),
  localEndpointUrl: z.string().trim().min(1).nullable(),
  credential: SavedCredentialSchema.nullable().default(null),
  updatedAt: z.string().nullable(),
});

export const AgentCredentialReferenceResponseSchema = z.object({
  reference: AgentCredentialReferenceSchema,
  credentials: z.array(SavedCredentialSchema),
  aliases: z.array(CredentialAliasSchema),
});

export const UpsertAgentCredentialReferenceRequestSchema = z.object({
  workspaceId: z.string().min(1),
  runnerKind: z.string().trim().min(1).optional(),
  provider: z.string().trim().min(1).nullable().optional(),
  model: z.string().trim().min(1).nullable().optional(),
  localModelId: z.string().trim().min(1).nullable().optional(),
  localEndpointUrl: z.string().trim().min(1).nullable().optional(),
  credentialRef: CredentialReferenceSchema.nullable(),
  fallbacks: z
    .array(
      z.object({
        provider: z.string().trim().min(1),
        model: z.string().trim().min(1),
        credentialRef: CredentialReferenceSchema.nullable(),
      }),
    )
    .optional()
    .default([]),
  modelTierFloor: ModelTierFloorSchema.optional().default("any"),
});

export const ApiKeyCredentialProviderSchema = CredentialProviderSchema.exclude([
  "openai_codex",
]);

export const OAuthIdentitySchema = z.object({
  accountId: z.string().min(1).optional(),
  chatgptPlanType: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
});

export const CredentialKeySchema = z.discriminatedUnion("format", [
  z.object({
    format: z.literal("api_key"),
    provider: ApiKeyCredentialProviderSchema,
    secret: z.string().trim().min(1),
    label: z.string().min(1).optional(),
    keyLast4: z.string().min(1).optional(),
    endpoint: z.string().trim().min(1).optional(),
    apiVersion: z.string().trim().min(1).optional(),
  }),
  z.object({
    format: z.literal("oauth"),
    provider: z.literal("openai_codex"),
    access: z.string().trim().min(1),
    refresh: z.string().trim().min(1).optional(),
    expiresAt: z.number().int().positive().optional(),
    identity: OAuthIdentitySchema.optional(),
    keyLast4: z.string().min(1).optional(),
  }),
  z.object({
    format: z.literal("secret_ref"),
    provider: ApiKeyCredentialProviderSchema,
    secretRef: z.string().min(1),
  }),
  z.object({
    format: z.literal("compatible_endpoint"),
    provider: z.literal("openai_compatible"),
    baseUrl: z.string().min(1),
    secret: z.string().min(1).nullable(),
  }),
]);

export const SaveCredentialRequestSchema = z.object({
  workspaceId: z.string().min(1),
  provider: CredentialProviderSchema,
  apiKey: z.string().min(1),
  endpoint: z.string().optional(),
  apiVersion: z.string().optional(),
});

export const SaveCredentialResponseSchema = z.object({
  credential: SavedCredentialSchema,
});

export const CredentialScopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workspace"),
    workspaceId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("agent"),
    workspaceId: z.string().min(1),
    agentId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("user"),
    userId: z.string().min(1),
  }),
]);

export const CreateCredentialKeySchema = CredentialKeySchema;

export const CreateCredentialRequestSchema = z.object({
  scope: CredentialScopeSchema,
  key: CreateCredentialKeySchema,
  alias: z.string().trim().min(1).max(64).optional(),
});

export const CreateCredentialResponseSchema = SaveCredentialResponseSchema;

export const CredentialValidationResultSchema = z.object({
  ok: z.boolean(),
  provider: z.string(),
  model: z.string().nullable(),
  checkedAt: z.string(),
  status: z.number().int().nullable(),
  code: z.string().nullable(),
  message: z.string(),
});

export const CredentialRevocationReportRequestSchema = z.object({
  workspaceId: z.string().min(1),
  credentialId: z.string().min(1),
  reason: z.string().trim().min(1).max(500).optional(),
  status: z.number().int().optional(),
  code: z.string().trim().min(1).max(100).optional(),
});

export const CredentialRevocationReportResponseSchema = z.object({
  credentialId: z.string(),
  validationState: z.enum(["invalid"]),
  validatedAt: z.string(),
});

export const WorkerLaunchResultSchema = z.object({
  attempted: z.boolean(),
  sessionId: z.string().nullable(),
  status: z.string(),
  command: z.string().nullable(),
  cwd: z.string().nullable(),
});

export const CodingHandoffRequestSchema = z.object({
  planId: z.string().trim().min(1),
  taskIds: z.array(z.string().trim().min(1)).min(1),
});

export const StoredCredentialLaunchRequestSchema = z.object({
  workspaceId: z.string().min(1),
  handoff: CodingHandoffRequestSchema.nullable().optional(),
});

export const StoredAgentActivationRequestSchema = z.object({
  workspaceId: z.string().min(1),
  handoff: CodingHandoffRequestSchema.nullable().optional(),
});

export const StoredCredentialActivationResponseSchema = z.object({
  credential: SavedCredentialSchema,
  validation: CredentialValidationResultSchema,
  launch: WorkerLaunchResultSchema.nullable(),
  handoff: CodingHandoffRequestSchema.nullable().optional(),
  execution_profile: ExecutionProfileResolutionSchema.optional(),
});

export type SavedCredential = z.infer<typeof SavedCredentialSchema>;
export type SavedCredentialListResponse = z.infer<
  typeof SavedCredentialListResponseSchema
>;
export type CredentialReference = z.infer<typeof CredentialReferenceSchema>;
export type CredentialAlias = z.infer<typeof CredentialAliasSchema>;
export type CredentialAliasListResponse = z.infer<
  typeof CredentialAliasListResponseSchema
>;
export type UpsertCredentialAliasRequest = z.infer<
  typeof UpsertCredentialAliasRequestSchema
>;
export type UpsertCredentialAliasResponse = z.infer<
  typeof UpsertCredentialAliasResponseSchema
>;
export type AgentCredentialReference = z.infer<
  typeof AgentCredentialReferenceSchema
>;
export type AgentCredentialReferenceResponse = z.infer<
  typeof AgentCredentialReferenceResponseSchema
>;
export type UpsertAgentCredentialReferenceRequest = z.infer<
  typeof UpsertAgentCredentialReferenceRequestSchema
>;
export type ApiKeyCredentialProvider = z.infer<
  typeof ApiKeyCredentialProviderSchema
>;
export type CredentialProvider = z.infer<typeof CredentialProviderSchema>;
export type CredentialProviderMetadata = (typeof CREDENTIAL_PROVIDERS)[number];
export type OAuthIdentity = z.infer<typeof OAuthIdentitySchema>;
export type CredentialKey = z.infer<typeof CredentialKeySchema>;
export type SaveCredentialRequest = z.infer<typeof SaveCredentialRequestSchema>;
export type SaveCredentialResponse = z.infer<
  typeof SaveCredentialResponseSchema
>;
export type CredentialScope = z.infer<typeof CredentialScopeSchema>;
export type CreateCredentialKey = z.infer<typeof CreateCredentialKeySchema>;
export type CreateCredentialRequest = z.infer<
  typeof CreateCredentialRequestSchema
>;
export type CreateCredentialResponse = z.infer<
  typeof CreateCredentialResponseSchema
>;
export type CredentialValidationResult = z.infer<
  typeof CredentialValidationResultSchema
>;
export type CredentialRevocationReportRequest = z.infer<
  typeof CredentialRevocationReportRequestSchema
>;
export type CredentialRevocationReportResponse = z.infer<
  typeof CredentialRevocationReportResponseSchema
>;
export type WorkerLaunchResult = z.infer<typeof WorkerLaunchResultSchema>;
export type CodingHandoffRequest = z.infer<typeof CodingHandoffRequestSchema>;
export type StoredCredentialActivationResponse = z.infer<
  typeof StoredCredentialActivationResponseSchema
>;
export type StoredCredentialLaunchRequest = z.infer<
  typeof StoredCredentialLaunchRequestSchema
>;
export type StoredAgentActivationRequest = z.infer<
  typeof StoredAgentActivationRequestSchema
>;

export function normalizeCredentialProvider(
  value: unknown,
): CredentialProvider | null {
  if (typeof value !== "string") return null;
  const provider = value.trim().toLowerCase();
  return CredentialProviderSchema.safeParse(provider).success
    ? (provider as CredentialProvider)
    : null;
}

export function getCredentialProviderMetadata(
  provider: CredentialProvider,
): CredentialProviderMetadata {
  return CREDENTIAL_PROVIDER_REGISTRY[provider];
}

export function detectCredentialProviderFromRecord(
  raw: Record<string, unknown>,
): string | null {
  const explicitProvider =
    typeof raw.provider === "string" ? raw.provider.trim().toLowerCase() : "";
  if (explicitProvider) return explicitProvider;

  const provider = CREDENTIAL_PROVIDERS.find((metadata) =>
    metadata.aliases.some((alias) => typeof raw[alias] === "string"),
  );
  return provider?.provider ?? null;
}

export function detectInlineCredentialSecret(
  raw: Record<string, unknown>,
  metadata: Pick<CredentialProviderMetadata, "aliases">,
): string | null {
  const alias = metadata.aliases.find((candidate) => {
    const value = raw[candidate];
    return typeof value === "string" && value.trim().length > 0;
  });
  return alias ? String(raw[alias]).trim() : null;
}

export function credentialKeyToRecord(
  key: CredentialKey,
): Record<string, unknown> {
  switch (key.format) {
    case "api_key": {
      const metadata = getCredentialProviderMetadata(key.provider);
      return {
        provider: key.provider,
        ...(key.label ? { label: key.label } : {}),
        [metadata.envVar]: key.secret,
        key_last4: key.keyLast4 ?? key.secret.slice(-4),
        ...(key.endpoint ? { endpoint: key.endpoint } : {}),
        ...(key.apiVersion ? { api_version: key.apiVersion } : {}),
      };
    }
    case "oauth":
      return {
        provider: key.provider,
        access_token: key.access,
        ...(key.refresh ? { refresh_token: key.refresh } : {}),
        ...(key.expiresAt ? { expires_at: key.expiresAt } : {}),
        key_last4: key.keyLast4 ?? key.access.slice(-4),
        ...(key.identity?.accountId
          ? { account_id: key.identity.accountId }
          : {}),
        ...(key.identity?.chatgptPlanType
          ? { plan_type: key.identity.chatgptPlanType }
          : {}),
        ...(key.identity?.email ? { email: key.identity.email } : {}),
      };
    case "secret_ref":
      return {
        provider: key.provider,
        secret_ref: key.secretRef,
      };
    case "compatible_endpoint":
      return {
        provider: key.provider,
        endpoint: key.baseUrl,
        ...(key.secret
          ? { api_key: key.secret, key_last4: key.secret.slice(-4) }
          : {}),
      };
  }
}

export function credentialKeyFromRecord(
  raw: Record<string, unknown>,
): CredentialKey | null {
  const rawProvider =
    typeof raw.provider === "string" ? raw.provider.trim().toLowerCase() : "";
  if (rawProvider === "openai_compatible") {
    const baseUrl =
      typeof raw.base_url === "string" && raw.base_url.trim()
        ? raw.base_url.trim()
        : typeof raw.endpoint === "string" && raw.endpoint.trim()
          ? raw.endpoint.trim()
          : "";
    if (!baseUrl) return null;
    const secret =
      detectInlineCredentialSecret(raw, CREDENTIAL_PROVIDER_REGISTRY.openai) ??
      null;
    return CredentialKeySchema.parse({
      format: "compatible_endpoint",
      provider: "openai_compatible",
      baseUrl,
      secret,
    });
  }

  const provider = normalizeCredentialProvider(raw.provider);
  if (provider === "openai_codex") {
    const access =
      typeof raw.access_token === "string" ? raw.access_token.trim() : "";
    const refresh =
      typeof raw.refresh_token === "string" ? raw.refresh_token.trim() : "";
    const expiresAt =
      typeof raw.expires_at === "number"
        ? raw.expires_at
        : typeof raw.expires_at === "string" &&
            /^\d+$/.test(raw.expires_at.trim())
          ? Number.parseInt(raw.expires_at.trim(), 10)
          : null;
    if (!access) return null;
    return CredentialKeySchema.parse({
      format: "oauth",
      provider,
      access,
      refresh: refresh || undefined,
      expiresAt: expiresAt ?? undefined,
      keyLast4:
        typeof raw.key_last4 === "string" && raw.key_last4.trim()
          ? raw.key_last4.trim()
          : undefined,
      identity: {
        accountId:
          typeof raw.account_id === "string" && raw.account_id.trim()
            ? raw.account_id.trim()
            : undefined,
        chatgptPlanType:
          typeof raw.plan_type === "string" && raw.plan_type.trim()
            ? raw.plan_type.trim()
            : undefined,
        email:
          typeof raw.email === "string" && raw.email.trim()
            ? raw.email.trim()
            : undefined,
      },
    });
  }
  if (!provider) return null;

  const secretRef =
    typeof raw.secret_ref === "string" && raw.secret_ref.trim()
      ? raw.secret_ref.trim()
      : null;
  if (secretRef) {
    return CredentialKeySchema.parse({
      format: "secret_ref",
      provider,
      secretRef,
    });
  }

  const metadata = getCredentialProviderMetadata(provider);
  const secret = detectInlineCredentialSecret(raw, metadata);
  if (!secret) return null;
  return CredentialKeySchema.parse({
    format: "api_key",
    provider,
    secret,
    label:
      typeof raw.label === "string" && raw.label.trim()
        ? raw.label.trim()
        : undefined,
    keyLast4:
      typeof raw.key_last4 === "string" && raw.key_last4.trim()
        ? raw.key_last4.trim()
        : undefined,
    endpoint:
      typeof raw.endpoint === "string" && raw.endpoint.trim()
        ? raw.endpoint.trim()
        : undefined,
    apiVersion:
      typeof raw.api_version === "string" && raw.api_version.trim()
        ? raw.api_version.trim()
        : undefined,
  });
}

export function credentialRecordMatchesProvider(
  raw: Record<string, unknown> | null,
  provider: CredentialProvider,
): boolean {
  if (!raw) return false;
  const metadata = getCredentialProviderMetadata(provider);
  return (
    metadata.aliases.some((alias) => typeof raw[alias] === "string") ||
    (metadata.launchableKind === "codex" &&
      typeof raw.secret_ref === "string") ||
    detectCredentialProviderFromRecord(raw) === provider
  );
}

export function maskCredentialLabel(
  metadata: Pick<CredentialProviderMetadata, "label">,
  last4: string | null,
): string {
  return last4 ? `${metadata.label} ••••${last4}` : metadata.label;
}
