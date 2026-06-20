import { z } from "zod";
import { KnownExecutionProviderSchema } from "./provider-registry.js";
import { LOCAL_RUNNER_KIND_VALUES } from "./runner-kinds.js";

// ---------------------------------------------------------------------------
// Request / Response schemas for Local Runtime (multi-kind machine registration)
// ---------------------------------------------------------------------------

/** Zod schema matching any local runner kind value. */
const LocalRunnerKindSchema = z.enum(LOCAL_RUNNER_KIND_VALUES);

const LOOPBACK_ENDPOINT_SCHEMES = new Set(["http:", "https:"]);
const LOOPBACK_HOSTNAMES = new Set(["localhost", "::1"]);
const LOOPBACK_IPV4_PATTERN = /^127(?:\.\d{1,3}){3}$/;

function isLoopbackHostname(hostname: string) {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return (
    LOOPBACK_HOSTNAMES.has(normalized) || LOOPBACK_IPV4_PATTERN.test(normalized)
  );
}

export function normalizeLocalEndpoint(endpoint: string) {
  const trimmed = endpoint.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("endpoint must be a valid URL");
  }

  if (!LOOPBACK_ENDPOINT_SCHEMES.has(parsed.protocol)) {
    throw new Error("endpoint must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("endpoint must not include URL credentials");
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error("endpoint host must be localhost, 127.0.0.1, or ::1");
  }

  return parsed.toString();
}

const LocalEndpointSchema = z
  .string()
  .trim()
  .min(1, "endpoint is required")
  .superRefine((endpoint, ctx) => {
    try {
      normalizeLocalEndpoint(endpoint);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : "endpoint is invalid",
      });
    }
  });

export const LocalToolCallCapabilitySchema = z.enum([
  "native_tools",
  "prompt_fallback",
  "no_tool_support",
]);
export type LocalToolCallCapability = z.infer<
  typeof LocalToolCallCapabilitySchema
>;

/**
 * Runtime-family identifiers carried by each runner entry in the registration
 * request. One helper machine can advertise multiple of these — one entry per
 * `[runner.<kind>]` stanza in the helper TOML.
 */
export const LOCAL_RUNTIME_REGISTRATION_RUNNER_KINDS = [
  "openai_compatible",
  "openclaw",
] as const;
export type LocalRuntimeRegistrationRunnerKind =
  (typeof LOCAL_RUNTIME_REGISTRATION_RUNNER_KINDS)[number];

export const LocalRuntimeMachineStatusSchema = z.enum([
  "online",
  "offline",
  "degraded",
]);
export type LocalRuntimeMachineStatus = z.infer<
  typeof LocalRuntimeMachineStatusSchema
>;

export const LocalRuntimeDiagnosticCodeSchema = z.enum([
  "helper_not_connected",
  "helper_heartbeat_stale",
  "workspace_root_missing",
  "helper_degraded",
  "helper_not_registered",
]);
export type LocalRuntimeDiagnosticCode = z.infer<
  typeof LocalRuntimeDiagnosticCodeSchema
>;

export const LocalRuntimeDiagnosticSchema = z.object({
  code: LocalRuntimeDiagnosticCodeSchema,
  severity: z.enum(["info", "warning", "error"]),
  title: z.string().min(1),
  message: z.string().min(1),
  action: z.string().min(1).nullable().default(null),
  command: z.string().min(1).nullable().default(null),
  logPath: z.string().min(1).nullable().default(null),
  detail: z.record(z.string(), z.unknown()).default({}),
});
export type LocalRuntimeDiagnostic = z.infer<
  typeof LocalRuntimeDiagnosticSchema
>;

export const LocalRuntimeErrorDetailSchema = z.object({
  httpStatus: z.number().int().positive().optional(),
  dialError: z.string().min(1).optional(),
  endpoint: z.string().min(1).optional(),
  rawMessage: z.string().min(1).optional(),
});
export type LocalRuntimeErrorDetail = z.infer<
  typeof LocalRuntimeErrorDetailSchema
>;

export const LocalRuntimeModelSchema = z.object({
  id: z.string(),
  machineId: z.string(),
  runnerKind: z.string().min(1),
  model: z.string().min(1),
  provider: z.string().nullable(),
  capabilities: z.record(z.string(), z.unknown()).default({}),
  lastAdvertisedAt: z.string(),
});
export type LocalRuntimeModel = z.infer<typeof LocalRuntimeModelSchema>;

export const LocalRuntimeEventSchema = z.object({
  id: z.string(),
  machineId: z.string(),
  workspaceId: z.string(),
  kind: z.string().min(1),
  detail: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
});
export type LocalRuntimeEvent = z.infer<typeof LocalRuntimeEventSchema>;

export const LocalExecutionTargetSchema = z
  .object({
    machineId: z.string().nullable(),
    machineDisplayName: z.string().nullable(),
    status: LocalRuntimeMachineStatusSchema.optional(),
    helperOnline: z.boolean(),
    lastSeenAt: z.string().nullable(),
    workspaceRoot: z.string().nullable(),
    registered: z.boolean(),
    helperVersion: z.string().nullable().default(null),
    advertisedRunnerKinds: z.array(z.string()).default([]),
    advertisedModels: z.array(z.string()).default([]),
    runtimeManagedTools: z.boolean().nullable().default(null),
    lastError: z.string().nullable().default(null),
    lastErrorAt: z.string().nullable().default(null),
    diagnostics: z.array(LocalRuntimeDiagnosticSchema).default([]),
  })
  .transform((target) => ({
    ...target,
    status: target.status ?? (target.helperOnline ? "online" : "offline"),
  }));
export type LocalExecutionTarget = z.infer<typeof LocalExecutionTargetSchema>;

const OpenAICompatibleRunnerInputSchema = z.object({
  kind: z.literal("openai_compatible"),
  endpoint: LocalEndpointSchema,
  model: z.string().min(1, "model is required"),
  provider: KnownExecutionProviderSchema.default("openai_compatible"),
  apiKey: z.string().trim().min(1).optional(),
  workspaceRoot: z.string().trim().min(1).optional(),
  toolCallCapability: LocalToolCallCapabilitySchema.default("native_tools"),
});
export type OpenAICompatibleRunnerInput = z.infer<
  typeof OpenAICompatibleRunnerInputSchema
>;

const OpenClawRunnerInputSchema = z.object({
  kind: z.literal("openclaw"),
  endpoint: LocalEndpointSchema,
  apiKey: z.string().trim().min(1).optional(),
});
export type OpenClawRunnerInput = z.infer<typeof OpenClawRunnerInputSchema>;

export const LocalRuntimeRunnerInputSchema = z.discriminatedUnion("kind", [
  OpenAICompatibleRunnerInputSchema,
  OpenClawRunnerInputSchema,
]);
export type LocalRuntimeRunnerInput = z.infer<
  typeof LocalRuntimeRunnerInputSchema
>;

export const LocalRuntimeRegistrationRequestSchema = z.object({
  machineDisplayName: z.string().trim().min(1).optional(),
  runners: z
    .array(LocalRuntimeRunnerInputSchema)
    .min(1, "At least one runner must be selected")
    .superRefine((runners, ctx) => {
      const seen = new Set<string>();
      for (const runner of runners) {
        if (seen.has(runner.kind)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate runner kind: ${runner.kind}`,
          });
        }
        seen.add(runner.kind);
      }
    }),
});
export type LocalRuntimeRegistrationRequest = z.infer<
  typeof LocalRuntimeRegistrationRequestSchema
>;

/** Per-runner detail returned from registration / list. One row per routing rule. */
export const LocalRuntimeRunnerSchema = z.object({
  /** The routing-rule id used for agent binding. */
  id: z.string(),
  /** Registration runtime-family identifier the user picked. */
  kind: z.enum(LOCAL_RUNTIME_REGISTRATION_RUNNER_KINDS),
  /** DB runner_kind this routing rule was persisted with. */
  runnerKind: LocalRunnerKindSchema,
  endpoint: z.string(),
  /** Empty string for runtimes that don't carry a model (e.g. openclaw). */
  model: z.string(),
  provider: z.string(),
  /** Live model rows advertised by this machine for this runner kind. */
  models: z.array(LocalRuntimeModelSchema).default([]),
  lastError: z.string().nullable().default(null),
  lastErrorAt: z.string().nullable().default(null),
  /** Null for runtimes whose tool loop is internal (e.g. openclaw). */
  toolCallCapability: LocalToolCallCapabilitySchema.nullable(),
  agents: z
    .array(z.object({ agentId: z.string(), agentName: z.string() }))
    .default([]),
});
export type LocalRuntimeRunner = z.infer<typeof LocalRuntimeRunnerSchema>;

export const LocalRuntimeRegistrationResponseSchema = z.object({
  /** The machine id. Identifies the one-per-helper registration. */
  id: z.string(),
  machine: z.object({
    id: z.string(),
    displayName: z.string(),
  }),
  /** Plaintext token — shown exactly once. User copies into helper config. */
  token: z.string(),
  /** Ready-to-paste runtime.toml snippet for the local-runtime-helper daemon. */
  configSnippet: z.string(),
  /** One-command helper setup from the OpenMacaw checkout root. */
  setupCommand: z.string(),
  /** Ready-to-paste command for launching the helper from the local-runtime-helper repo root. */
  launchCommand: z.string(),
  localExecution: LocalExecutionTargetSchema,
  runners: z.array(LocalRuntimeRunnerSchema).min(1),
});
export type LocalRuntimeRegistrationResponse = z.infer<
  typeof LocalRuntimeRegistrationResponseSchema
>;

export const LocalRuntimeConfigResponseSchema = z.object({
  /** Machine id — config covers the whole helper, not a single runner. */
  id: z.string(),
  token: z.string().nullable(),
  tokenAvailable: z.boolean(),
  configSnippet: z.string(),
  setupCommand: z.string(),
  launchCommand: z.string(),
  filename: z.literal("runtime.toml"),
});
export type LocalRuntimeConfigResponse = z.infer<
  typeof LocalRuntimeConfigResponseSchema
>;

export const LocalModelProbeRequestSchema = z.object({
  endpoint: LocalEndpointSchema,
  model: z.string().min(1, "model is required"),
});
export type LocalModelProbeRequest = z.infer<
  typeof LocalModelProbeRequestSchema
>;

export const LocalModelCatalogEntrySchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
  })
  .refine((entry) => entry.id !== undefined || entry.name !== undefined, {
    message: "model entry must include id or name",
  });
export type LocalModelCatalogEntry = z.infer<
  typeof LocalModelCatalogEntrySchema
>;

export const LocalModelCatalogResponseSchema = z.object({
  data: z.array(LocalModelCatalogEntrySchema).default([]),
});
export type LocalModelCatalogResponse = z.infer<
  typeof LocalModelCatalogResponseSchema
>;

export const LocalModelProbeResponseSchema = z.object({
  endpoint: z.string(),
  model: z.string(),
  reachable: z.boolean(),
  modelFound: z.boolean(),
  checkedAt: z.string(),
  error: z.string().nullable(),
});
export type LocalModelProbeResponse = z.infer<
  typeof LocalModelProbeResponseSchema
>;

/** List item schema — one entry per machine, runners listed inline. */
export const LocalRuntimeListItemSchema = z.object({
  id: z.string(),
  machineDisplayName: z.string(),
  status: LocalRuntimeMachineStatusSchema.default("offline"),
  localExecution: LocalExecutionTargetSchema,
  models: z.array(LocalRuntimeModelSchema).default([]),
  lastError: z.string().nullable().default(null),
  runners: z.array(LocalRuntimeRunnerSchema),
});
export type LocalRuntimeListItem = z.infer<typeof LocalRuntimeListItemSchema>;

export const LocalRuntimeListResponseSchema = z.object({
  runtimes: z.array(LocalRuntimeListItemSchema),
  heartbeatIntervalMs: z.number().int().positive(),
});
export type LocalRuntimeListResponse = z.infer<
  typeof LocalRuntimeListResponseSchema
>;

export const LocalRuntimeEventsResponseSchema = z.object({
  events: z.array(LocalRuntimeEventSchema),
});
export type LocalRuntimeEventsResponse = z.infer<
  typeof LocalRuntimeEventsResponseSchema
>;

export const LocalRuntimeTestDispatchResponseSchema = z.object({
  machineId: z.string(),
  helperConnected: z.boolean(),
  modelAdvertised: z.boolean(),
  dispatchSucceeded: z.boolean(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
      detail: LocalRuntimeErrorDetailSchema.nullable().default(null),
    })
    .nullable()
    .default(null),
});
export type LocalRuntimeTestDispatchResponse = z.infer<
  typeof LocalRuntimeTestDispatchResponseSchema
>;

export const AgentLocalRuntimeAssignRequestSchema = z.object({
  agentId: z.string().min(1, "agentId is required").optional(),
  machineId: z.string().min(1, "machineId is required"),
  localRuntimeId: z.string().min(1, "localRuntimeId is required"),
});
export type AgentLocalRuntimeAssignRequest = z.infer<
  typeof AgentLocalRuntimeAssignRequestSchema
>;

export const AgentLocalRuntimeAssignResponseSchema = z.object({
  routingRuleId: z.string(),
  agentId: z.string(),
  machineId: z.string(),
  model: z.string(),
});
export type AgentLocalRuntimeAssignResponse = z.infer<
  typeof AgentLocalRuntimeAssignResponseSchema
>;

export const AgentLocalModelAssignRequestSchema = z.object({
  agentId: z.string().min(1, "agentId is required"),
  machineId: z.string().min(1, "machineId is required"),
  runnerKind: z.string().min(1, "runnerKind is required"),
  model: z.string().min(1, "model is required"),
  provider: KnownExecutionProviderSchema.default("openai_compatible"),
});
export type AgentLocalModelAssignRequest = z.infer<
  typeof AgentLocalModelAssignRequestSchema
>;

export const AgentLocalModelAssignResponseSchema = z.object({
  routingRuleId: z.string(),
  agentId: z.string(),
  machineId: z.string(),
  runnerKind: z.string(),
  model: z.string(),
  provider: z.string(),
});
export type AgentLocalModelAssignResponse = z.infer<
  typeof AgentLocalModelAssignResponseSchema
>;
