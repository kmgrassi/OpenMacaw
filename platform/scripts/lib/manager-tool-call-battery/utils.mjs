import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

export function loadEnvFile(filePath) {
  let contents;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch {
    return;
  }

  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    if (process.env[match[1]] != null) continue;
    process.env[match[1]] = unquote(match[2]);
  }
}

export function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

export function renderTemplate(value, context) {
  return String(value).replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key) => context[key] ?? _match);
}

export function safeJson(value) {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function normalizeUrl(url) {
  return String(url).replace(/\/$/, "");
}

export function requireValue(value, name) {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`${name} is required`);
}

export function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export function requireArgValue(flag, value) {
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function numberOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function evidenceText(value) {
  return flattenEvidenceText(value).join(" ");
}

export function sanitizeForArtifact(value) {
  if (Array.isArray(value)) return value.map((entry) => sanitizeForArtifact(entry));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => {
      if (isSensitiveKey(key)) return [key, "[redacted]"];
      return [key, sanitizeForArtifact(entryValue)];
    }),
  );
}

function flattenEvidenceText(value) {
  if (value == null) return [];
  if (typeof value === "string") {
    return [value, ...flattenParsedJsonString(value)];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    const flattened = value.flatMap(flattenEvidenceText);
    const joined = joinedPrimitiveArray(value);
    return joined ? [joined, ...flattened] : flattened;
  }
  if (typeof value === "object") {
    return [JSON.stringify(value), ...Object.values(value).flatMap(flattenEvidenceText)];
  }
  return [];
}

function flattenParsedJsonString(value) {
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return [];

  try {
    return flattenEvidenceText(JSON.parse(trimmed));
  } catch {
    return [];
  }
}

function joinedPrimitiveArray(value) {
  if (!value.every((entry) => typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean")) {
    return null;
  }

  return value.map(String).join(" ");
}

function isSensitiveKey(key) {
  return /(api[_-]?key|token|secret|password|credential|authorization)/i.test(key);
}
