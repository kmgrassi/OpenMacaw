import type { AgentMessageToolCall } from "../../../../contracts/messages";

export type ToolCallDisplay = {
  label: string;
  status?: string;
  inputSummary?: string;
  outputSummary?: string;
};

type JsonRecord = Record<string, unknown>;

type ToolCallMetadataPayload = {
  name?: string;
  tool_name?: string;
  toolName?: string;
  tool?: string;
  kind?: string;
  status?: string;
  state?: string;
  phase?: string;
};

type ToolCallInputPayload = {
  name?: string;
  tool_name?: string;
  toolName?: string;
  arguments?: unknown;
  input?: ToolCallInputPayload | unknown;
};

type ToolCallOutputPayload = {
  status?: string;
  state?: string;
  error_code?: string;
  errorCode?: string;
  output?: unknown;
};

type ToolCallExecutionOutput = {
  argv?: string[];
  cwd?: string;
  error?: unknown;
  result?: unknown;
  output?: unknown;
  status?: string;
  state?: string;
};

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function asToolCallMetadataPayload(
  value: unknown,
): ToolCallMetadataPayload | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    name: optionalString(record.name),
    tool_name: optionalString(record.tool_name),
    toolName: optionalString(record.toolName),
    tool: optionalString(record.tool),
    kind: optionalString(record.kind),
    status: optionalString(record.status),
    state: optionalString(record.state),
    phase: optionalString(record.phase),
  };
}

function asToolCallInputPayload(value: unknown): ToolCallInputPayload | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    name: optionalString(record.name),
    tool_name: optionalString(record.tool_name),
    toolName: optionalString(record.toolName),
    arguments: record.arguments,
    input: record.input,
  };
}

function asToolCallOutputPayload(value: unknown): ToolCallOutputPayload | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    status: optionalString(record.status),
    state: optionalString(record.state),
    error_code: optionalString(record.error_code),
    errorCode: optionalString(record.errorCode),
    output: record.output,
  };
}

function asToolCallExecutionOutput(
  value: unknown,
): ToolCallExecutionOutput | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    argv: isStringArray(record.argv) ? record.argv : undefined,
    cwd: optionalString(record.cwd),
    error: record.error,
    result: record.result,
    output: record.output,
    status: optionalString(record.status),
    state: optionalString(record.state),
  };
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
  const nestedInput = asToolCallInputPayload(inputRecord?.input);
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
  outputRecord: ToolCallOutputPayload | null,
) {
  if (label !== "git.run") return undefined;
  const nestedOutput = asToolCallExecutionOutput(
    parseEmbeddedJson(outputRecord?.output),
  );
  const command = nestedOutput?.argv?.join(" ");
  const cwd = nestedOutput?.cwd;
  if (!command && typeof cwd !== "string") return undefined;

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

  const record = asToolCallMetadataPayload(value);
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
  const inputRecord = asToolCallInputPayload(input);
  const outputRecord = asToolCallOutputPayload(output);
  const nestedOutput = asToolCallExecutionOutput(outputRecord?.output);
  const label =
    stringField(inputRecord, "tool_name", "toolName", "name") ??
    stringField(
      asToolCallInputPayload(inputRecord?.input),
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
