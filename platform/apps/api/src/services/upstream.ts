import { contextHeaders } from "../middleware/request-context.js";
import { internalServiceRoleHeaders } from "./internal-service-auth.js";

export type UpstreamResponse = {
  status: number;
  body: unknown;
  headers: Record<string, string>;
};

export function createUpstreamRequester(baseUrl: string, timeoutMs: number) {
  return async function upstreamRequest(path: string, init: RequestInit = {}): Promise<UpstreamResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const hasBody =
        init.body !== undefined &&
        String(init.body).trim().length > 0 &&
        init.method !== "GET" &&
        init.method !== "HEAD";

      const requestHeaders = new Headers(init.headers);
      const headerRecord = Object.fromEntries(requestHeaders.entries());

      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        method: init.method || "GET",
        body: hasBody ? init.body : undefined,
        signal: controller.signal,
        headers: internalServiceRoleHeaders({
          "content-type": "application/json",
          ...headerRecord,
          ...contextHeaders(),
        }),
      });

      const contentType = response.headers.get("content-type") ?? "";
      const body = contentType.includes("application/json") ? await response.json() : await response.text();

      return { status: response.status, body, headers: Object.fromEntries(response.headers.entries()) };
    } finally {
      clearTimeout(timeoutId);
    }
  };
}
