import type {
  LocalRuntime,
  LocalRuntimeRunner,
} from "../../../api/local-runtime";
import type { AgentRuntimeProfile } from "../../../../../../contracts/agents";
import type { CredentialReference } from "../../../../../../contracts/credentials";
import type { RuntimeCredentialState } from "./types";
import {
  MODEL_TIER_REGISTRY,
  modelRegistryEntry,
  modelTier,
  modelTierLabel,
  type ModelTierFloor,
} from "../../../../../../contracts/model-tiers";
import {
  credentialProviderLabel,
  credentialRowId,
  credentialValidationLabel,
  matchesProviderFilter,
} from "../credential-picker/credential-picker-utils";

export type LocalRuntimeRunnerOption = {
  id: string;
  runtime: LocalRuntime;
  runner: LocalRuntimeRunner;
};

export const MODEL_TIER_FLOOR_OPTIONS: Array<{
  value: ModelTierFloor;
  label: string;
}> = [
  { value: "any", label: "Any model" },
  { value: "local", label: "Local or better" },
  { value: "mid", label: "Mid or better" },
  { value: "frontier", label: "Frontier only" },
];

export const FALLBACK_PROVIDER_OPTIONS = Array.from(
  new Set(
    MODEL_TIER_REGISTRY.map((entry) => entry.provider).filter(
      (provider) => provider !== "bedrock",
    ),
  ),
).map((provider) => ({
  value: provider,
  label: providerLabel(provider),
}));

export function buildRoutingWarnings(input: {
  primaryProvider: string;
  primaryModel: string;
  modelTierFloor: ModelTierFloor;
  fallbacks: AgentRuntimeProfile["fallbacks"];
}) {
  const warnings: string[] = [];
  const primaryTier = modelTier(input.primaryProvider, input.primaryModel);
  if (input.modelTierFloor === "frontier" && primaryTier === "mid") {
    warnings.push(
      "Frontier floor is advisory here: the primary model is mid-tier, so cutover may escalate instead of degrading.",
    );
  }
  input.fallbacks.forEach((fallback, index) => {
    const entry = modelRegistryEntry(fallback.provider, fallback.model);
    if (entry && !entry.executable) {
      warnings.push(
        `Fallback ${index + 1} uses ${providerLabel(fallback.provider)}, whose execution adapter is not available yet. See the provider adapter rollout scope.`,
      );
    }
  });
  return warnings;
}

export function firstModelForProvider(provider: string) {
  return (
    MODEL_TIER_REGISTRY.find((entry) => entry.provider === provider)?.model ??
    ""
  );
}

export function modelOptionsForProvider(provider: string) {
  return MODEL_TIER_REGISTRY.filter((entry) => entry.provider === provider).map(
    (entry) => ({
      value: entry.model,
      label: `${modelTierLabel(entry.model)} (${entry.tier})`,
    }),
  );
}

export function credentialOptionsForProvider(
  state: RuntimeCredentialState | null,
  provider: string,
) {
  const credentials = state?.credentials ?? [];
  const aliases = state?.aliases ?? [];
  return [
    { value: "", label: "No credential reference" },
    ...aliases
      .filter((alias) => matchesProviderFilter(alias.credential, provider))
      .map((alias) => ({
        value: `alias:${alias.alias}`,
        label: `Alias: ${alias.alias}${alias.credential ? ` (${credentialProviderLabel(alias.credential)} - ${alias.credential.label})` : ""}`,
      })),
    ...credentials
      .filter((credential) => matchesProviderFilter(credential, provider))
      .map((credential) => ({
        value: `credential_id:${credentialRowId(credential)}`,
        label: `${credentialProviderLabel(credential)} - ${credential.label} (${credentialValidationLabel(credential)})`,
      })),
  ];
}

export function credentialRefFromValue(
  value: string,
): CredentialReference | null {
  const [type, refValue] = value.split(":", 2);
  if ((type === "alias" || type === "credential_id") && refValue) {
    return { type, value: refValue };
  }
  return null;
}

export function providerLabel(provider: string) {
  return provider
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function localRunnerLabel(option: LocalRuntimeRunnerOption) {
  return `${option.runner.model} on ${option.runtime.machineDisplayName}`;
}

export function buildLocalRuntimeRunnerOptions(
  options: LocalRuntimeRunnerOption[],
  current: string,
): Array<{ value: string; label: string }> {
  if (options.length === 0) {
    return [{ value: "", label: "No online local runtimes" }];
  }
  const selectOptions = options.map((option) => ({
    value: option.id,
    label: localRunnerLabel(option),
  }));
  if (current && !selectOptions.some((option) => option.value === current)) {
    selectOptions.unshift({ value: current, label: "Current local runtime" });
  }
  return selectOptions;
}
