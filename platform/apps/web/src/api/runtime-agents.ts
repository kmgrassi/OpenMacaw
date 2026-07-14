import { apiFetch } from "./client";
import { ROUTES } from "./routes";

export async function fetchRuntimeAgents() {
  return apiFetch(ROUTES.agents, {
    method: "GET",
    defaultErrorMessage: (status) => `Runtime agent list failed (${status})`,
  });
}
