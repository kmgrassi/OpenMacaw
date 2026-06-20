import { createHash } from "node:crypto";

import type { DefaultAgentRole } from "../../../../../contracts/setup.js";
import { ApiRouteError } from "../../http.js";

function deterministicUuid(input: string) {
  const hex = createHash("sha256").update(input).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex
    .slice(16, 20)
    .join("")}-${hex.slice(20, 32).join("")}`;
}

export function personalDefaultAgentId(workspaceId: string, userId: string, role: DefaultAgentRole) {
  return deterministicUuid(`default-agent:${workspaceId}:${userId}:${role}`);
}

export function workspaceManagerAgentId(workspaceId: string) {
  return deterministicUuid(`workspace-manager-agent:${workspaceId}`);
}

export function workspaceRouterAgentId(workspaceId: string) {
  return deterministicUuid(`workspace-router-agent:${workspaceId}`);
}

export function workspaceRouterOptimizationTaskId(workspaceId: string, agentId: string) {
  return deterministicUuid(`workspace-router-optimization-task:${workspaceId}:${agentId}`);
}

export function requireCurrentUser(userId: string) {
  userId = userId.trim();
  if (!userId) {
    throw new ApiRouteError(401, "auth_required", "Supabase access token is required");
  }
  return userId;
}
