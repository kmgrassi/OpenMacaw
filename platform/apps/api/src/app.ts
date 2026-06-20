import express from "express";

import type { ApiConfig } from "./config.js";
import { createCorsMiddleware } from "./middleware/cors.js";
import { requireAuth } from "./middleware/authJwt.js";
import { createRequestContextMiddleware } from "./middleware/request-context.js";
import { registerAgentDashboardRoutes } from "./routes/agent-dashboard.js";
import { registerAgentDiagnosticRoutes } from "./routes/agent-diagnostic.js";
import { registerAgentDispatchProbeRoutes } from "./routes/agent-dispatch-probe.js";
import { registerAgentObservationRoutes } from "./routes/agent-observation.js";
import { registerAgentToolRoutes } from "./routes/agent-tools.js";
import { registerAwsResourceAccessSmokeRoutes } from "./routes/aws-resource-access-smoke.js";
import { registerClaudeCodeSmokeRoutes } from "./routes/claude-code-smoke.js";
import { registerCredentialRoutes } from "./routes/credentials.js";
import { registerCredentialOAuthRoutes } from "./routes/credentials-oauth.js";
import { registerCredentialValidationRoutes } from "./routes/credential-validation.js";
import { registerDevAgentTriggerMessageRoutes } from "./routes/dev-agent-trigger-message.js";
import { registerDevToolInvocationRoutes } from "./routes/dev-tool-invocation.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerLearningSkillPrRoutes } from "./routes/learning-skill-prs.js";
import { registerManagerAgentRoutes } from "./routes/manager-agent.js";
import { registerManagerAgentSmokeRoutes } from "./routes/manager-agent-smoke.js";
import { registerMemoryItemRoutes } from "./routes/memory-items.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerLocalModelCodingSmokeRoutes } from "./routes/local-model-coding-smoke.js";
import { registerModelAgnosticSmokeRoutes } from "./routes/model-agnostic-smoke.js";
import { registerModelCatalogRoutes } from "./routes/models.js";
import { registerPlanReviewRoutes } from "./routes/plan-reviews.js";
import { registerPlanRoutes } from "./routes/plans.js";
import { registerPlannerLocalModelSmokeRoutes } from "./routes/planner-local-model-smoke.js";
import { registerProviderFailureRoutes } from "./routes/provider-failures.js";
import { registerProxyRoutes } from "./routes/proxy.js";
import { registerProviderCutoverRoutes } from "./routes/provider-cutovers.js";
import { registerResourceCredentialRoutes } from "./routes/resource-credentials.js";
import { registerSetupRoutes } from "./routes/setup.js";
import { registerScheduledTaskRoutes } from "./routes/scheduled-tasks.js";
import { registerWorkspaceSettingsRoutes } from "./routes/workspace-settings.js";
import { registerLocalDirectoryRoutes } from "./routes/local-directory.js";
import { registerLocalModelsRoutes } from "./routes/local-models.js";
import { registerLocalModelProxyRoutes } from "./routes/local-model-proxy.js";
import { registerLocalRuntimeRoutes } from "./routes/local-runtime.js";
import { registerLearningRoutes } from "./routes/learning.js";
import { registerLearningCostRoutes } from "./routes/learning-cost.js";
import { registerLearningMemoryRoutes } from "./routes/learning-memory.js";
import { registerStoredAgentRoutes } from "./routes/stored-agents.js";
import { registerWorkItemRoutes } from "./routes/work-items.js";
import { createLauncherClient } from "./services/launcher.js";
import { startCredentialRevalidationCron } from "./services/credential-validation.js";
import { createUpstreamRequester } from "./services/upstream.js";
import { handleApiRouteError } from "./http.js";

export function shouldRequireJwtAuth(req: express.Request) {
  if (req.method === "POST" && req.path === "/memory/items") return false;
  if (req.method === "POST" && /^\/work-items\/[^/]+\/cutovers$/.test(req.path)) return false;
  return !req.path.startsWith("/webhooks/") && !req.path.startsWith("/internal/scheduled-tasks/");
}

function requireApiAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!shouldRequireJwtAuth(req)) {
    return next();
  }
  return requireAuth(req, res, next);
}

export function createApp(config: ApiConfig) {
  const app = express();
  const launcherClient = createLauncherClient({
    baseUrl: config.launcherBaseUrl,
    timeoutMs: config.launcherRequestTimeoutMs,
  });
  const launcherRequest = createUpstreamRequester(config.launcherBaseUrl, config.launcherRequestTimeoutMs);

  app.use(createRequestContextMiddleware());
  app.use(
    express.json({
      verify: (req, _res, buffer) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
      },
    }),
  );
  app.use(createCorsMiddleware(config.corsOrigins));

  registerHealthRoutes(app, config, launcherClient, launcherRequest);
  app.use("/api", requireApiAuth);
  registerAgentDiagnosticRoutes(app, launcherRequest);
  registerMemoryRoutes(app);
  registerAwsResourceAccessSmokeRoutes(app);
  registerClaudeCodeSmokeRoutes(app);
  registerManagerAgentSmokeRoutes(app);
  registerLocalModelCodingSmokeRoutes(app);
  registerPlannerLocalModelSmokeRoutes(app);
  registerModelAgnosticSmokeRoutes(app);
  registerModelCatalogRoutes(app);
  registerSetupRoutes(app, launcherClient, launcherRequest);
  registerManagerAgentRoutes(app, launcherRequest);
  registerStoredAgentRoutes(app, launcherClient);
  registerCredentialRoutes(app);
  registerCredentialOAuthRoutes(app);
  registerResourceCredentialRoutes(app);
  registerCredentialValidationRoutes(app);
  registerDevToolInvocationRoutes(app);
  registerAgentToolRoutes(app);
  registerDevAgentTriggerMessageRoutes(app, launcherClient);
  registerLocalRuntimeRoutes(app, launcherRequest);
  registerLearningRoutes(app);
  registerLearningCostRoutes(app);
  registerLearningMemoryRoutes(app);
  registerLocalModelProxyRoutes(app);
  registerLocalDirectoryRoutes(app);
  registerLocalModelsRoutes(app);
  registerLearningSkillPrRoutes(app, config);
  registerAgentDashboardRoutes(app);
  registerAgentDispatchProbeRoutes(app, launcherClient);
  registerPlanReviewRoutes(app);
  registerProviderFailureRoutes(app);
  registerPlanRoutes(app, config, launcherRequest);
  registerScheduledTaskRoutes(app);
  registerMemoryItemRoutes(app);
  registerAgentObservationRoutes(app, launcherClient);
  registerProxyRoutes(app, launcherClient, launcherRequest, config.orchestratorRequestTimeoutMs);
  registerProviderCutoverRoutes(app);
  registerWorkItemRoutes(app, config);
  registerWorkspaceSettingsRoutes(app);
  startCredentialRevalidationCron();

  app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    handleApiRouteError(res, error, {
      status: 500,
      code: "internal_error",
      message: "Request failed",
    });
  });

  return app;
}
