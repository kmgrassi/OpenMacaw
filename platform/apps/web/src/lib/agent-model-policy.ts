import {
  modelProviderFromId,
  type ModelCatalogEntry,
} from "../../../../contracts/model-catalog";
import type { LocalRuntime, LocalRuntimeRunner } from "../api/local-runtime";
import type {
  CredentialAlias,
  CredentialReference,
  SavedCredential,
} from "../api/credentials";
import type { Agent } from "../types/agents";
import { formatProviderLabel } from "./provider-labels";

export const CLOUD_CODING_RUNNER_KIND = "codex";
export const LOCAL_MODEL_CODING_RUNNER_KIND = "local_model_coding";
export const LOCAL_RELAY_RUNNER_KIND = "local_relay";

export type ApprovalPolicy = "on_request" | "never";

export function runnerKindForAgent(agent: Agent) {
  if (agent.runnerKind) return agent.runnerKind;
  if (agent.agentType === "planning") return "llm_tool_runner";
  if (agent.agentType === "manager") return "llm_tool_runner";
  if (agent.agentType === "router") return "llm_tool_runner";
  if (agent.agentType === "custom")
    return agent.customTarget?.backendType ?? "openclaw_ws";
  return "codex";
}

export function defaultRunnerKindForAgent(agent: Agent) {
  if (agent.localModelCoding?.enabled) return LOCAL_MODEL_CODING_RUNNER_KIND;
  if (agent.agentType === "coding") return agent.runnerKind ?? "codex";
  return runnerKindForAgent(agent);
}

/** Selectable runners for the local coding model picker — one per openai_compatible runner across all machines. */
export type LocalCodingRunnerOption = {
  /** Routing-rule id used as the agent's localModelId. */
  id: string;
  runtime: LocalRuntime;
  runner: LocalRuntimeRunner;
};

export function localCodingRunnerOptions(
  runtimes: LocalRuntime[],
): LocalCodingRunnerOption[] {
  return runtimes.flatMap((runtime) =>
    runtime.runners
      .filter((runner) => runner.kind === "openai_compatible")
      .map((runner) => ({ id: runner.id, runtime, runner })),
  );
}

/**
 * Resolve the `local_relay` target runner for an agent. The target is stored
 * on the credential-reference routing rule's `provider` column. Until that
 * reference loads, fall back to the agent record's `provider` so the editor
 * stays usable on first paint. Returns "" when neither source has a value.
 */
export function localRelayTargetForAgent(input: {
  savedProvider: string | null | undefined;
  agentProvider: string | null | undefined;
}): string {
  return input.savedProvider ?? input.agentProvider ?? "";
}

export function findLocalCodingRunnerForSavedModel(
  savedModel: string | null | undefined,
  savedLocalRunnerId: string | null | undefined,
  options: LocalCodingRunnerOption[],
): LocalCodingRunnerOption | null {
  const localId = savedLocalRunnerId?.trim();
  if (localId) {
    const byId = options.find((option) => option.id === localId);
    if (byId) return byId;
  }
  if (!savedModel) return null;
  return (
    options.find(
      (option) => `local/${option.id}/${option.runner.model}` === savedModel,
    ) ??
    options.find((option) => option.runner.model === savedModel) ??
    null
  );
}

export function credentialRowId(credential: SavedCredential): string {
  return (
    credential.credentialRowId ??
    credential.id.split(":", 1)[0] ??
    credential.id
  );
}

export function credentialProviderLabel(provider: string | null | undefined) {
  return formatProviderLabel(provider);
}

export function credentialRefValue(
  ref: CredentialReference | null | undefined,
) {
  return ref ? `${ref.type}:${ref.value}` : "";
}

export function parseCredentialRef(value: string): CredentialReference | null {
  const [type, refValue] = value.split(":", 2);
  if ((type === "alias" || type === "credential_id") && refValue) {
    return { type, value: refValue };
  }
  return null;
}

export function modelProviderForSelection(
  modelId: string,
  models: ModelCatalogEntry[],
): string | null {
  if (!modelId || modelId.startsWith("local/")) return null;
  return (
    models.find((model) => model.id === modelId)?.provider ??
    modelProviderFromId(modelId)
  );
}

export function credentialOptionsForProvider(
  provider: string | null,
  credentials: SavedCredential[],
  aliases: CredentialAlias[],
) {
  if (!provider) return [];

  const matchingCredentials = credentials.filter(
    (credential) => credential.provider === provider,
  );
  const matchingAliases = aliases.filter(
    (alias) => alias.credential?.provider === provider,
  );

  return [
    ...matchingCredentials.map((credential) => ({
      value: `credential_id:${credentialRowId(credential)}`,
      label: `${credential.label} (${credentialProviderLabel(credential.provider)})`,
    })),
    ...matchingAliases.map((alias) => ({
      value: `alias:${alias.alias}`,
      label: `Alias: ${alias.alias} (${credentialProviderLabel(alias.credential?.provider)})`,
    })),
  ];
}
