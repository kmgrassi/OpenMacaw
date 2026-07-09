import { CREDENTIAL_PROVIDERS } from "../../../../contracts/credentials";
import { normalizeDisplayLabel } from "./display-labels";

type FormatProviderLabelOptions = {
  fallback?: string;
  localOpenAICompatible?: boolean;
};

function titleCaseWords(value: string) {
  return value
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function formatProviderLabel(
  provider: string | null | undefined,
  options: FormatProviderLabelOptions = {},
) {
  const normalized = provider?.trim();
  if (!normalized) return options.fallback ?? "Unknown provider";

  if (normalized === "openai_compatible" && options.localOpenAICompatible) {
    return "OpenAI-compatible local";
  }

  const metadata = CREDENTIAL_PROVIDERS.find(
    (candidate) => candidate.provider === normalized,
  );
  if (metadata) {
    return metadata.label.replace(" API key", "");
  }

  return titleCaseWords(normalizeDisplayLabel(normalized));
}
