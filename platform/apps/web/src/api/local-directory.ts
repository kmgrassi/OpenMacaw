/**
 * Web-side helpers for local workspace-directory actions.
 *
 * Directory picking runs through the local runtime helper because the selected
 * absolute path only has meaning on the user's machine. Workspace-path
 * persistence/validation endpoints below are still platform API routes.
 */
import { brokerFetch } from "./broker-fetch";

const DEFAULT_LOCAL_HELPER_BASE = "http://127.0.0.1:7317";

export function resolveLocalRuntimeHelperBase(): string {
  return (
    import.meta.env.VITE_LOCAL_RUNTIME_HELPER_BASE?.trim() ||
    DEFAULT_LOCAL_HELPER_BASE
  ).replace(/\/+$/, "");
}

export type ValidateDirectoryResult =
  | { ok: true; path: string }
  | {
      ok: false;
      path: string;
      reason: "not_absolute" | "not_found" | "not_a_directory" | "not_readable";
    };

export type PickDirectoryResult =
  | { cancelled: true; path: null }
  | { cancelled: false; path: string; validation: ValidateDirectoryResult };

export async function pickDirectory(opts?: {
  defaultLocation?: string;
  prompt?: string;
}): Promise<PickDirectoryResult> {
  const base = resolveLocalRuntimeHelperBase();
  const res = await fetch(`${base}/api/local/pick-directory`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts ?? {}),
  }).catch((error) => {
    throw new Error(
      `Could not reach local runtime helper at ${base}. Start the helper, then try Browse again. (${error instanceof Error ? error.message : String(error)})`,
    );
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`pick-directory failed (${res.status}): ${body}`);
  }
  return (await res.json()) as PickDirectoryResult;
}

export async function validateDirectory(
  path: string,
): Promise<ValidateDirectoryResult> {
  const res = await brokerFetch("/api/local/validate-directory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`validate-directory failed (${res.status}): ${body}`);
  }
  return (await res.json()) as ValidateDirectoryResult;
}

export type FetchWorkspacePathResult = {
  path: string | null;
  validation: ValidateDirectoryResult | null;
};

export async function fetchAgentWorkspacePath(
  agentId: string,
): Promise<FetchWorkspacePathResult> {
  const res = await brokerFetch(
    `/api/local/agents/${encodeURIComponent(agentId)}/workspace-path`,
    { method: "GET" },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`fetch-workspace-path failed (${res.status}): ${body}`);
  }
  return (await res.json()) as FetchWorkspacePathResult;
}

export type SaveWorkspacePathResult = {
  agentId: string;
  workspacePath: string | null;
  toolPolicy: Record<string, unknown>;
};

export async function saveAgentWorkspacePath(
  agentId: string,
  path: string | null,
): Promise<SaveWorkspacePathResult> {
  const res = await brokerFetch(
    `/api/local/agents/${encodeURIComponent(agentId)}/workspace-path`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`save-workspace-path failed (${res.status}): ${body}`);
  }
  return (await res.json()) as SaveWorkspacePathResult;
}
