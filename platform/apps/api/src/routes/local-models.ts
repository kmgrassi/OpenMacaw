/**
 * Dev-only endpoint that lists installed local models the user can pick
 * from when assigning a local provider to an agent. Hits Ollama's
 * `/api/tags` (default) so the UI can offer a dropdown instead of a
 * free-text input.
 *
 * Gated to NODE_ENV=development and 127.0.0.1 — same envelope as
 * routes/local-directory.ts. No reason to surface this in a cloud
 * build.
 */
import type { Express, Request, Response } from "express";

import { ApiRouteError, errorPayload, handleApiRouteError } from "../http.js";
import { assertDevRouteAccess } from "./dev-route-guard.js";

type OllamaModel = {
  name: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: { family?: string; parameter_size?: string; quantization_level?: string };
};

function localModelHostBase(): string {
  return (process.env.LOCAL_MODEL_HOST_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
}

export function registerLocalModelsRoutes(app: Express) {
  app.get("/api/local/installed-models", async (req: Request, res: Response) => {
    try {
      assertDevRouteAccess(req, { localhostOnly: true });
      const base = localModelHostBase();

      const upstream = await fetch(`${base}/api/tags`).catch((error) => {
        throw new ApiRouteError(
          502,
          "local_model_host_unreachable",
          `Could not reach local model host at ${base} (${(error as Error).message ?? "unknown"}).`,
        );
      });

      if (!upstream.ok) {
        const body = await upstream.text().catch(() => "");
        return res.status(200).json(
          errorPayload("local_model_host_error", `Local model host returned ${upstream.status}.`, {
            status: upstream.status,
            body: body.slice(0, 500),
          }),
        );
      }

      const parsed = (await upstream.json().catch(() => null)) as { models?: OllamaModel[] } | null;
      const raw = Array.isArray(parsed?.models) ? parsed.models : [];

      const models = raw
        .map((entry) => normalizeOllamaModel(entry))
        .filter((model): model is NonNullable<typeof model> => model !== null);

      return res.status(200).json({
        host: base,
        models,
      });
    } catch (error) {
      return handleApiRouteError(res, error, {
        status: 502,
        code: "list_local_models_failed",
        message: "Could not list installed local models",
      });
    }
  });
}

function normalizeOllamaModel(entry: OllamaModel) {
  if (!entry || typeof entry.name !== "string" || entry.name.trim() === "") {
    return null;
  }
  return {
    name: entry.name.trim(),
    family: entry.details?.family ?? null,
    parameterSize: entry.details?.parameter_size ?? null,
    quantizationLevel: entry.details?.quantization_level ?? null,
    sizeBytes: typeof entry.size === "number" ? entry.size : null,
    modifiedAt: typeof entry.modified_at === "string" ? entry.modified_at : null,
  };
}
