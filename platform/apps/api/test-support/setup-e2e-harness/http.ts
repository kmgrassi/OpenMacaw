import type { IncomingMessage, Server, ServerResponse } from "node:http";

export function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export function postgrestJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown) {
  const accept = req.headers.accept ?? "";
  const wantsObject = typeof accept === "string" && accept.includes("application/vnd.pgrst.object+json");
  json(res, status, wantsObject && Array.isArray(body) ? (body[0] ?? null) : body);
}

export function readBody(req: IncomingMessage) {
  return new Promise<string>((resolve) => {
    let text = "";
    req.on("data", (chunk) => {
      text += String(chunk);
    });
    req.on("end", () => resolve(text));
  });
}

export function applyLimit<T>(rows: T[], url: URL) {
  const limit = Number(url.searchParams.get("limit") ?? "");
  return Number.isFinite(limit) && limit > 0 ? rows.slice(0, limit) : rows;
}

export function parseInFilter(value: string | null) {
  if (!value?.startsWith("in.(") || !value.endsWith(")")) return null;
  return value
    .slice(4, -1)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseEqFilter(value: string | null) {
  if (!value?.startsWith("eq.")) return null;
  return value.slice(3);
}

export function sortByCreatedAt<T extends Record<string, unknown>>(rows: T[], url: URL) {
  if (url.searchParams.get("order") !== "created_at.asc") return rows;
  return [...rows].sort((left, right) => String(left.created_at ?? "").localeCompare(String(right.created_at ?? "")));
}

export function sortByPosition<T extends Record<string, unknown>>(rows: T[], url: URL) {
  if (url.searchParams.get("order") !== "position.asc") return rows;
  return [...rows].sort((left, right) => Number(left.position ?? 0) - Number(right.position ?? 0));
}

export function sortByName<T extends Record<string, unknown>>(rows: T[], url: URL) {
  if (url.searchParams.get("order") !== "name.asc") return rows;
  return [...rows].sort((left, right) => String(left.name ?? "").localeCompare(String(right.name ?? "")));
}

export function closeServer(server: Server | undefined) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}
