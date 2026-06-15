import type { ToolDefinition } from "../tool-spec-translator.js";

export type DatabaseToolResult = {
  status?: number;
  output: string;
};

export type CredentialRefArg = {
  type: "credential_id" | "alias";
  value: string;
};

export type FallbackArg = {
  provider: string;
  model: string;
  credentialRef: CredentialRefArg | null;
};

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

export function optionalPositiveInteger(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  max: number,
): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, max);
}

export function booleanArg(args: Record<string, unknown>, key: string): boolean | null {
  const value = args[key];
  return typeof value === "boolean" ? value : null;
}

export function scheduleArg(args: Record<string, unknown>): Record<string, unknown> | null {
  const value = args.schedule ?? args.next_interval ?? args.nextInterval;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function scheduledTaskIdArg(args: Record<string, unknown>): string {
  return stringArg(args, "scheduledTaskId") || stringArg(args, "scheduled_task_id") || stringArg(args, "id");
}

export function toolIdArg(args: Record<string, unknown>): string {
  return stringArg(args, "toolId") || stringArg(args, "tool_id") || stringArg(args, "id");
}

export function toolSlugArg(args: Record<string, unknown>): string {
  return stringArg(args, "toolSlug") || stringArg(args, "tool_slug") || stringArg(args, "slug");
}

export function toolKey(tool: ToolDefinition): string {
  return tool.slug || tool.functionName || tool.name;
}

export function jsonOutput(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
