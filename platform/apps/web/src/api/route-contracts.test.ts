import { describe, expect, it } from "vitest";

import {
  agentRuntimeProfileRoute,
  localRuntimeEventsRoute,
} from "../../../../contracts/routes";
import { ROUTES } from "./routes";

describe("shared route contracts", () => {
  it("keeps ROUTES.agentRuntimeProfile aligned with the shared contract helper", () => {
    expect(ROUTES.agentRuntimeProfile("agent/1", "workspace 1")).toBe(
      agentRuntimeProfileRoute("agent/1", "workspace 1"),
    );
  });

  it("builds local runtime events paths without a limit query by default", () => {
    expect(localRuntimeEventsRoute("machine/1")).toBe(
      "/api/local-runtime/runtimes/machine%2F1/events",
    );
  });

  it("builds local runtime events paths with an encoded limit query", () => {
    expect(localRuntimeEventsRoute("machine/1", { limit: 25 })).toBe(
      "/api/local-runtime/runtimes/machine%2F1/events?limit=25",
    );
  });
});
