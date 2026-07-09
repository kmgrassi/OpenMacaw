import type { LocalToolCallCapability } from "../../../api/local-runtime";
import { formatProviderLabel } from "../../../lib/provider-labels";

type BadgeVariant = "default" | "success" | "warning" | "error";

export const LOCAL_HELPER_INSTALL_COMMAND =
  "cd local-runtime-helper && go install ./cmd/local-runtime-helper";

export const PROVIDER_OPTIONS = [
  { value: "openai_compatible", label: formatProviderLabel("openai_compatible") },
  { value: "ollama", label: "Ollama" },
  { value: "llama-cpp", label: "llama.cpp" },
  { value: "vllm", label: "vLLM" },
];

export const LOCAL_MODEL_OPTIONS = [
  { value: "qwen3-coder:30b", label: "qwen3-coder:30b" },
];

export const TOOL_CALL_CAPABILITY_OPTIONS: Array<{
  value: LocalToolCallCapability;
  label: string;
}> = [
  { value: "native_tools", label: "Native tools" },
  { value: "prompt_fallback", label: "Prompt fallback" },
  { value: "no_tool_support", label: "No tool support" },
];

export function formatCapability(value: LocalToolCallCapability | null) {
  if (value === null) return "Runtime-managed";
  return (
    TOOL_CALL_CAPABILITY_OPTIONS.find((option) => option.value === value)
      ?.label ?? value
  );
}

export function formatLastSeen(value: string | null) {
  if (!value) return "Never";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

export function helperStatus(
  lastSeenAt: string | null,
  heartbeatIntervalMs: number,
): {
  label: "Online" | "Stale" | "Offline";
  variant: BadgeVariant;
  dotClassName: string;
} {
  if (!lastSeenAt) {
    return {
      label: "Offline",
      variant: "error",
      dotClassName: "bg-red-400",
    };
  }
  const timestamp = Date.parse(lastSeenAt);
  if (Number.isNaN(timestamp)) {
    return {
      label: "Offline",
      variant: "error",
      dotClassName: "bg-red-400",
    };
  }
  const ageMs = Date.now() - timestamp;
  if (ageMs <= heartbeatIntervalMs * 2) {
    return {
      label: "Online",
      variant: "success",
      dotClassName: "bg-green-400",
    };
  }
  if (ageMs <= heartbeatIntervalMs * 4) {
    return {
      label: "Stale",
      variant: "warning",
      dotClassName: "bg-yellow-400",
    };
  }
  return {
    label: "Offline",
    variant: "error",
    dotClassName: "bg-red-400",
  };
}

export function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
