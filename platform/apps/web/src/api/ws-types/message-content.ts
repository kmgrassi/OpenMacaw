export type RuntimeMessageContent =
  | string
  | {
      text?: string;
      delta?: string;
      message?: string;
      content?: RuntimeMessageContent;
    }
  | Array<
      | string
      | {
          text?: string;
          content?: string;
          delta?: string;
        }
    >;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isRuntimeMessageBlock(
  value: unknown,
): value is Extract<RuntimeMessageContent, object> {
  if (!isRecord(value)) return false;
  return (
    isOptionalString(value.text) &&
    isOptionalString(value.delta) &&
    isOptionalString(value.message) &&
    (value.content === undefined || isRuntimeMessageContent(value.content))
  );
}

function isRuntimeMessageArrayItem(
  value: unknown,
): value is Extract<RuntimeMessageContent, Array<unknown>>[number] {
  if (typeof value === "string") return true;
  if (!isRecord(value)) return false;
  return (
    isOptionalString(value.text) &&
    isOptionalString(value.content) &&
    isOptionalString(value.delta)
  );
}

export function isRuntimeMessageContent(
  value: unknown,
): value is RuntimeMessageContent {
  if (typeof value === "string") return true;
  if (Array.isArray(value)) {
    return value.every((item) => isRuntimeMessageArrayItem(item));
  }
  return isRuntimeMessageBlock(value);
}
