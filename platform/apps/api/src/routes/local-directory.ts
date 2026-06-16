/**
 * Dev-only routes that help the user pick + validate a local filesystem
 * directory for their coding agent and persist it on the agent's
 * tool_policy.executionTarget.workspace_root.
 *
 * The endpoints are gated to NODE_ENV=development and bind/respond only
 * on 127.0.0.1 because they expose host-OS capabilities (native file
 * picker, filesystem stat) that have no place in a cloud/multi-tenant
 * environment.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Express, Request, Response } from "express";

import { getUserScopedSupabase, getServiceRoleSupabase } from "../supabase-client.js";
import { assertSupabaseNoError, assertSupabaseSuccess } from "../lib/supabase-errors.js";
import {
  ApiRouteError,
  errorPayload,
  handleApiRouteError,
  requireAccessToken,
  requireRouteParam,
  requireVerifiedUser,
} from "../http.js";
import { assertDevRouteAccess } from "./dev-route-guard.js";

type ValidateResult =
  | { ok: true; path: string }
  | { ok: false; reason: "not_absolute" | "not_found" | "not_a_directory" | "not_readable"; path: string };

async function validateDirectory(rawPath: unknown): Promise<ValidateResult> {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return { ok: false, reason: "not_absolute", path: "" };
  }
  const expanded = expandHome(rawPath.trim());
  if (!path.isAbsolute(expanded)) {
    return { ok: false, reason: "not_absolute", path: expanded };
  }
  try {
    const stat = await fs.stat(expanded);
    if (!stat.isDirectory()) {
      return { ok: false, reason: "not_a_directory", path: expanded };
    }
    try {
      await fs.access(expanded, fs.constants.R_OK);
    } catch {
      return { ok: false, reason: "not_readable", path: expanded };
    }
    return { ok: true, path: expanded };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "not_found", path: expanded };
    }
    throw error;
  }
}

function expandHome(p: string): string {
  if (p.startsWith("~")) {
    const home = process.env.HOME;
    if (home) return path.join(home, p.slice(1));
  }
  return p;
}

async function spawnFolderPicker(opts: { defaultLocation?: string; prompt?: string }): Promise<string | null> {
  // macOS native folder chooser. Returns the POSIX path of the chosen
  // directory, or null when the user cancels. Falls through with the
  // platform note on non-darwin hosts so the UI can surface it.
  if (process.platform !== "darwin") {
    throw new ApiRouteError(
      501,
      "picker_unsupported",
      "Native directory picker is currently only supported on macOS. Paste the path manually.",
    );
  }

  const defaultClause = opts.defaultLocation
    ? `default location (POSIX file "${opts.defaultLocation.replace(/"/g, '\\"')}")`
    : "";
  const promptClause = opts.prompt ? `with prompt "${opts.prompt.replace(/"/g, '\\"')}"` : "";
  const script = `
    try
      set chosen to choose folder ${[promptClause, defaultClause].filter(Boolean).join(" ")}
      POSIX path of chosen
    on error errMsg number errNum
      if errNum is -128 then return ""
      error errMsg number errNum
    end try
  `;

  return await new Promise<string | null>((resolve, reject) => {
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf8").trim();
        reject(new Error(`osascript exited ${code}: ${stderr || "(no stderr)"}`));
        return;
      }
      const stdout = Buffer.concat(chunks).toString("utf8").trim();
      if (!stdout) {
        resolve(null);
        return;
      }
      // osascript returns paths with a trailing slash; normalize.
      resolve(stdout.replace(/\/+$/, ""));
    });
  });
}

export function registerLocalDirectoryRoutes(app: Express) {
  app.post("/api/local/pick-directory", async (req: Request, res: Response) => {
    try {
      assertDevRouteAccess(req, { localhostOnly: true });
      const body = (req.body ?? {}) as { defaultLocation?: unknown; prompt?: unknown };
      const defaultLocation = typeof body.defaultLocation === "string" ? body.defaultLocation : undefined;
      const prompt = typeof body.prompt === "string" ? body.prompt : "Choose a workspace directory for this agent";
      const picked = await spawnFolderPicker({ defaultLocation, prompt });
      if (picked === null) {
        return res.status(200).json({ cancelled: true, path: null });
      }
      const validated = await validateDirectory(picked);
      return res.status(200).json({ cancelled: false, path: picked, validation: validated });
    } catch (error) {
      return handleApiRouteError(res, error, {
        status: 502,
        code: "pick_directory_failed",
        message: "Could not open native directory picker",
      });
    }
  });

  app.post("/api/local/validate-directory", async (req: Request, res: Response) => {
    try {
      assertDevRouteAccess(req, { localhostOnly: true });
      const body = (req.body ?? {}) as { path?: unknown };
      const result = await validateDirectory(body.path);
      return res.status(200).json(result);
    } catch (error) {
      return handleApiRouteError(res, error, {
        status: 502,
        code: "validate_directory_failed",
        message: "Could not validate directory",
      });
    }
  });

  app.get("/api/local/agents/:agentId/workspace-path", async (req: Request, res: Response) => {
    try {
      assertDevRouteAccess(req, { localhostOnly: true });
      const accessToken = requireAccessToken(req);
      requireVerifiedUser(req);
      const agentId = requireRouteParam(req, "agentId");
      const supabase = getUserScopedSupabase(accessToken);
      const fetched = await supabase.from("agent").select("id,tool_policy").eq("id", agentId).maybeSingle();
      assertSupabaseNoError("agent fetch", fetched.error);
      if (!fetched.data) {
        throw new ApiRouteError(404, "agent_not_found", "Agent was not found");
      }
      const stored = extractWorkspaceRoot(fetched.data.tool_policy);
      if (stored === null) {
        return res.status(200).json({ path: null, validation: null });
      }
      const validation = await validateDirectory(stored);
      return res.status(200).json({ path: stored, validation });
    } catch (error) {
      return handleApiRouteError(res, error, {
        status: 502,
        code: "workspace_path_fetch_failed",
        message: "Could not fetch agent workspace path",
      });
    }
  });

  app.put("/api/local/agents/:agentId/workspace-path", async (req: Request, res: Response) => {
    try {
      assertDevRouteAccess(req, { localhostOnly: true });
      const accessToken = requireAccessToken(req);
      const userId = requireVerifiedUser(req);
      const agentId = requireRouteParam(req, "agentId");
      const body = (req.body ?? {}) as { path?: unknown };

      // Validate first so the UI gets a structured error instead of a
      // raw 422 from the DB layer when the path is bogus.
      const requested = typeof body.path === "string" ? body.path : null;
      let resolvedPath: string | null = null;
      if (requested !== null && requested.trim() !== "") {
        const result = await validateDirectory(requested);
        if (!result.ok) {
          return res.status(400).json(
            errorPayload("invalid_workspace_path", `Path is not usable (${result.reason})`, {
              path: result.path,
              reason: result.reason,
            }),
          );
        }
        resolvedPath = result.path;
      }

      const supabase = getUserScopedSupabase(accessToken);
      const fetched = await supabase
        .from("agent")
        .select("id,workspace_id,tool_policy")
        .eq("id", agentId)
        .maybeSingle();
      assertSupabaseNoError("agent fetch", fetched.error);
      const existing = fetched.data;
      if (!existing) {
        throw new ApiRouteError(404, "agent_not_found", "Agent was not found");
      }

      const nextToolPolicy = mergeWorkspaceRoot(existing.tool_policy, resolvedPath);

      const service = getServiceRoleSupabase();
      const updated = await service
        .from("agent")
        .update({
          tool_policy: nextToolPolicy as never,
          updated_at: new Date().toISOString(),
        })
        .eq("id", agentId)
        .select("id,tool_policy")
        .maybeSingle();
      assertSupabaseSuccess("agent update", updated.data, updated.error);

      return res.status(200).json({
        agentId,
        workspacePath: resolvedPath,
        toolPolicy: updated.data?.tool_policy ?? nextToolPolicy,
        actor: userId,
      });
    } catch (error) {
      return handleApiRouteError(res, error, {
        status: 502,
        code: "workspace_path_update_failed",
        message: "Could not update agent workspace path",
      });
    }
  });
}

function extractWorkspaceRoot(toolPolicy: unknown): string | null {
  if (!toolPolicy || typeof toolPolicy !== "object" || Array.isArray(toolPolicy)) return null;
  const target = (toolPolicy as Record<string, unknown>).executionTarget;
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  const raw = (target as Record<string, unknown>).workspace_root;
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

function mergeWorkspaceRoot(existingPolicy: unknown, workspacePath: string | null): Record<string, unknown> {
  const policy: Record<string, unknown> =
    existingPolicy && typeof existingPolicy === "object" && !Array.isArray(existingPolicy)
      ? { ...(existingPolicy as Record<string, unknown>) }
      : {};

  const existingTarget =
    policy.executionTarget && typeof policy.executionTarget === "object" && !Array.isArray(policy.executionTarget)
      ? { ...(policy.executionTarget as Record<string, unknown>) }
      : {};

  if (workspacePath === null) {
    delete existingTarget.workspace_root;
  } else {
    existingTarget.workspace_root = workspacePath;
    if (typeof existingTarget.kind !== "string" || existingTarget.kind === "") {
      existingTarget.kind = "local_helper";
    }
  }

  if (Object.keys(existingTarget).length === 0) {
    delete policy.executionTarget;
  } else {
    policy.executionTarget = existingTarget;
  }

  return policy;
}
