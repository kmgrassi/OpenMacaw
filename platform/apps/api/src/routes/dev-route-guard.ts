import type { Request } from "express";

import { ApiRouteError } from "../http.js";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export type DevRouteGuardOptions = {
  localhostOnly?: boolean;
  allowNonProduction?: boolean;
  disabledCode?: string;
  disabledMessage?: string;
  forbiddenCode?: string;
  forbiddenMessage?: string;
};

export function isLoopbackRequest(req: Request): boolean {
  const ip = req.ip ?? req.socket.remoteAddress ?? "";
  return LOOPBACK_ADDRESSES.has(ip);
}

export function assertDevRouteAccess(req: Request, options: DevRouteGuardOptions = {}) {
  const enabled = options.allowNonProduction
    ? process.env.NODE_ENV !== "production"
    : process.env.NODE_ENV === "development";
  if (!enabled) {
    throw new ApiRouteError(
      404,
      options.disabledCode ?? "not_found",
      options.disabledMessage ?? "Endpoint is unavailable",
    );
  }

  if (options.localhostOnly && !isLoopbackRequest(req)) {
    throw new ApiRouteError(
      403,
      options.forbiddenCode ?? "forbidden",
      options.forbiddenMessage ?? "Local-only endpoint is unavailable from this address",
    );
  }
}
