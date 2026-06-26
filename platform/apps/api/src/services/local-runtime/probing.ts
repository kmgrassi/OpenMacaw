import {
  LocalModelCatalogResponseSchema,
  LocalModelProbeResponseSchema,
  normalizeLocalEndpoint,
  type LocalModelProbeRequest,
} from "../../../../../contracts/local-runtime.js";
import { ApiRouteError } from "../../http.js";
import { helperOnline } from "./config-snippet.js";
import { getLocalRuntimeRuleDetails } from "./routing-metadata.js";

function modelListUrl(endpoint: string) {
  const normalized = endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
  return new URL("models", normalized).toString();
}

function parseCatalog(body: unknown) {
  const parsed = LocalModelCatalogResponseSchema.safeParse(body);
  return parsed.success ? parsed.data.data : [];
}

export async function probeLocalModel(input: LocalModelProbeRequest) {
  let endpoint: string;
  try {
    endpoint = normalizeLocalEndpoint(input.endpoint);
  } catch (error) {
    throw new ApiRouteError(
      422,
      "local_runtime_invalid_endpoint",
      error instanceof Error ? error.message : String(error),
    );
  }

  const checkedAt = new Date().toISOString();
  try {
    const response = await fetch(modelListUrl(endpoint), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return LocalModelProbeResponseSchema.parse({
        endpoint,
        model: input.model,
        reachable: false,
        modelFound: false,
        checkedAt,
        error: `Model endpoint returned HTTP ${response.status}`,
      });
    }

    const body = (await response.json()) as unknown;
    const data = parseCatalog(body);
    const modelFound = data.some((model) => model.id === input.model || model.name === input.model);
    return LocalModelProbeResponseSchema.parse({
      endpoint,
      model: input.model,
      reachable: true,
      modelFound,
      checkedAt,
      error: modelFound ? null : "Endpoint is reachable, but the model was not listed",
    });
  } catch (error) {
    return LocalModelProbeResponseSchema.parse({
      endpoint,
      model: input.model,
      reachable: false,
      modelFound: false,
      checkedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function probeRegisteredLocalRuntimeForWorkspace(workspaceId: string, ruleId: string) {
  const checkedAt = new Date().toISOString();
  const details = await getLocalRuntimeRuleDetails(workspaceId, ruleId);
  if (details.registrationRunnerKind === "openclaw") {
    throw new ApiRouteError(
      400,
      "local_runtime_probe_unsupported",
      "OpenClaw runtimes do not expose an OpenAI-compatible model list to probe",
    );
  }
  const online = helperOnline(details.machineLastSeenAt);
  const runnerAdvertised = details.machineAdvertisedRunnerKinds.includes(details.registrationRunnerKind);

  return LocalModelProbeResponseSchema.parse({
    endpoint: details.endpoint,
    model: details.model,
    reachable: online && runnerAdvertised,
    modelFound: online && runnerAdvertised && Boolean(details.model),
    checkedAt,
    error:
      online && runnerAdvertised
        ? null
        : online
          ? `Helper is online, but it is not advertising ${details.registrationRunnerKind}`
          : "Local runtime relay is not currently online",
  });
}
