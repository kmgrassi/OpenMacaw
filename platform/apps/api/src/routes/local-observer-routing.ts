import type { Express } from "express";

import {
  RenderLocalObserverPromptRequestSchema,
  ValidateLocalObserverRecommendationRequestSchema,
} from "../../../../contracts/local-observer-routing.js";
import { apiRoute } from "../http.js";
import { renderLocalObserverPrompt, validateLocalObserverRecommendation } from "../services/local-observer-routing.js";

export function registerLocalObserverRoutingRoutes(app: Express) {
  app.post(
    "/api/evals/local-observer-routing/render-prompt",
    apiRoute({
      bodySchema: RenderLocalObserverPromptRequestSchema,
      invalidBodyMessage: "Invalid local observer routing prompt request",
      async handler({ res, body }) {
        return res.status(200).json(renderLocalObserverPrompt(body));
      },
    }),
  );

  app.post(
    "/api/evals/local-observer-routing/validate-recommendation",
    apiRoute({
      bodySchema: ValidateLocalObserverRecommendationRequestSchema,
      invalidBodyMessage: "Invalid local observer routing recommendation request",
      async handler({ res, body }) {
        return res.status(200).json(validateLocalObserverRecommendation(body));
      },
    }),
  );
}
