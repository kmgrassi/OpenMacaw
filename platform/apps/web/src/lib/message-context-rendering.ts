export type MessageContextDisplay = {
  label: string;
  chars: number | null;
  sha256: string | null;
  text: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringField(
  record: Record<string, unknown> | null,
  ...keys: string[]
): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function numberField(
  record: Record<string, unknown> | null,
  ...keys: string[]
): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

export function getMessageContextDisplay(
  metadata: unknown,
): MessageContextDisplay | null {
  const record = asRecord(metadata);
  const snapshot =
    asRecord(record?.agent_context_snapshot) ??
    asRecord(record?.agentContextSnapshot);

  const text =
    stringField(snapshot, "text", "content", "context") ??
    stringField(record, "agent_context", "agentContext");

  if (!text) return null;

  const chars = numberField(snapshot, "chars", "characters", "length");
  const sha256 = stringField(snapshot, "sha256", "hash");

  return {
    label: chars === null ? "Context passed" : `Context passed (${chars} chars)`,
    chars,
    sha256,
    text,
  };
}
