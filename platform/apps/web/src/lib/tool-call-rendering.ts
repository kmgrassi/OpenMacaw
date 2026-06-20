import type { AgentMessageToolCall } from "../../../../contracts/messages";

export type ToolCallDisplay = {
  label: string;
  status?: string;
  inputSummary?: string;
  outputSummary?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function compact(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, 240) : undefined;
  }

  const serialized = JSON.stringify(value);
  if (!serialized || serialized === "{}" || serialized === "[]")
    return undefined;
  return serialized.length > 240
    ? `${serialized.slice(0, 237)}...`
    : serialized;
}

function compactNonEmpty(value: unknown): string | undefined {
  if (isEmptyStructuredValue(value)) return undefined;
  return compact(value);
}

function isEmptyStructuredValue(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  const record = asRecord(value);
  return record
    ? Object.keys(record).length === 0 ||
        Object.values(record).every(isEmptyStructuredValue)
    : false;
}

function parseEmbeddedJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function toolArguments(inputRecord: Record<string, unknown> | null) {
  const nestedInput = asRecord(inputRecord?.input);
  return (
    nonEmptyValue(inputRecord?.arguments) ??
    nonEmptyValue(nestedInput?.arguments) ??
    nonEmptyValue(inputRecord?.input)
  );
}

function nonEmptyValue(value: unknown): unknown | undefined {
  return isEmptyStructuredValue(value) ? undefined : value;
}

function inferredExecutionArguments(
  label: string,
  outputRecord: Record<string, unknown> | null,
) {
  if (label !== "git.run") return undefined;
  const output = parseEmbeddedJson(outputRecord?.output);
  const nestedOutput = asRecord(output);
  const argv = nestedOutput?.argv;
  const cwd = nestedOutput?.cwd;
  if (!Array.isArray(argv) && typeof cwd !== "string") return undefined;

  const command = Array.isArray(argv)
    ? argv.filter((part): part is string => typeof part === "string").join(" ")
    : undefined;
  return {
    ...(command ? { command } : {}),
    ...(typeof cwd === "string" && cwd.trim() ? { cwd } : {}),
  };
}

function stringField(
  record: Record<string, unknown> | null,
  ...fields: string[]
) {
  for (const field of fields) {
    const value = record?.[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function formatMetadataToolCall(
  value: unknown,
  index: number,
): ToolCallDisplay | null {
  if (typeof value === "string" && value.trim()) {
    return { label: value.trim() };
  }

  const record = asRecord(value);
  if (!record) return null;

  const label =
    stringField(record, "name", "tool_name", "toolName", "tool", "kind") ??
    `Tool call ${index + 1}`;
  const status = stringField(record, "status", "state", "phase");

  return { label, status };
}

export function formatPersistedToolCall(
  toolCall: AgentMessageToolCall,
  index: number,
): ToolCallDisplay {
  const input = parseJson(toolCall.input);
  const output = parseJson(toolCall.output);
  const inputRecord = asRecord(input);
  const outputRecord = asRecord(output);
  const nestedOutput = asRecord(outputRecord?.output);
  const label =
    stringField(inputRecord, "tool_name", "toolName", "name") ??
    stringField(
      asRecord(inputRecord?.input),
      "name",
      "tool_name",
      "toolName",
    ) ??
    `Tool call ${index + 1}`;

  const status =
    stringField(outputRecord, "status", "state") ??
    stringField(nestedOutput, "status", "state");
  const errorCode = stringField(outputRecord, "error_code", "errorCode");
  const inferredArguments = inferredExecutionArguments(label, outputRecord);
  const inputSummary =
    compactNonEmpty(toolArguments(inputRecord)) ??
    compactNonEmpty(inferredArguments) ??
    compactNonEmpty(input);
  const outputSummary =
    compact(
      nestedOutput?.error ?? nestedOutput?.result ?? outputRecord?.output,
    ) ?? compact(output);

  return {
    label,
    status: errorCode ? [status, errorCode].filter(Boolean).join(" ") : status,
    inputSummary,
    outputSummary,
  };
}

export function formatPersistedToolCalls(
  toolCalls: AgentMessageToolCall[] | undefined,
): ToolCallDisplay[] {
  return (toolCalls ?? []).map(formatPersistedToolCall);
}
