import { ApiRouteError } from "../http.js";

export function internalServiceRoleHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!serviceRoleKey) {
    throw new ApiRouteError(
      503,
      "service_role_unconfigured",
      "Service-role authentication is not configured for internal runtime requests",
    );
  }

  return {
    ...extraHeaders,
    authorization: `Bearer ${serviceRoleKey}`,
  };
}
