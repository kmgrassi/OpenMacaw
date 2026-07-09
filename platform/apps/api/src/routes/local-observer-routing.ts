import type { Express } from "express";

import {
  RenderLocalObserverEvaluationPromptRequestSchema,
  ReviewLocalObserverEvaluationRequestSchema,
} from "../../../../contracts/local-observer-routing.js";
import { apiRoute } from "../http.js";
import {
  renderLocalObserverEvaluationPrompt,
  reviewLocalObserverEvaluation,
} from "../services/local-observer-routing.js";

export function registerLocalObserverRoutingRoutes(app: Express) {
  app.post(
    "/api/evals/local-observer-routing/render-evaluation-prompt",
    apiRoute({
      bodySchema: RenderLocalObserverEvaluationPromptRequestSchema,
      invalidBodyMessage: "Invalid local observer evaluation prompt request",
      async handler({ res, body }) {
        return res.status(200).json(renderLocalObserverEvaluationPrompt(body));
      },
    }),
  );

  app.post(
    "/api/evals/local-observer-routing/review-evaluation",
    apiRoute({
      bodySchema: ReviewLocalObserverEvaluationRequestSchema,
      invalidBodyMessage: "Invalid local observer evaluation review request",
      async handler({ res, body }) {
        return res.status(200).json(reviewLocalObserverEvaluation(body));
      },
    }),
  );
}
