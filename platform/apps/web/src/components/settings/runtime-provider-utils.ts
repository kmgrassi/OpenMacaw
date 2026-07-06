import { PROVIDER_REGISTRY } from "../../../../../contracts/provider-registry";

function fallbackProviderLabel(provider: string) {
  return provider
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function runtimeProviderLabel(provider: string | null | undefined) {
  if (!provider) return "Unknown provider";
  if (provider === "local") return "Local runtime";
  const label =
    PROVIDER_REGISTRY[provider as keyof typeof PROVIDER_REGISTRY]?.label;
  return label ? label.replace(/ API key$/, "") : fallbackProviderLabel(provider);
}

export function managerRuntimeProviderLabel(
  provider: string | null | undefined,
) {
  if (provider === "openai_compatible") return "OpenAI-compatible local";
  return runtimeProviderLabel(provider);
}
