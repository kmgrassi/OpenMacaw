import { describe, expect, it } from "vitest";

import {
  agentDashboardGatewayConfigStateRoute,
  agentDashboardRunsRoute,
  agentDashboardVersionRoute,
  agentDiagnosticRoute,
  credentialAliasRoute,
  managerRuntimeStatusRoute,
  agentRuntimeProfileRoute,
  localRuntimeEventsRoute,
  workerBridgeSessionRoute,
  workspaceAgentDiagnosticsRoute,
} from "../../../../contracts/routes";
import { ROUTES } from "./routes";

describe("shared route contracts", () => {
  it("keeps ROUTES.agentRuntimeProfile aligned with the shared contract helper", () => {
    expect(ROUTES.agentRuntimeProfile("agent/1", "workspace 1")).toBe(
      agentRuntimeProfileRoute("agent/1", "workspace 1"),
    );
  });

  it("keeps the dashboard route helpers aligned with the shared contract helpers", () => {
    expect(ROUTES.agentDashboardVersion("agent/1", "workspace 1")).toBe(
      agentDashboardVersionRoute("agent/1", "workspace 1"),
    );
    expect(ROUTES.agentDashboardRuns("agent/1", 3)).toBe(
      agentDashboardRunsRoute("agent/1", 3),
    );
    expect(
      ROUTES.agentDashboardGatewayConfigState("agent/1", "workspace 1"),
    ).toBe(agentDashboardGatewayConfigStateRoute("agent/1", "workspace 1"));
  });

  it("keeps diagnostic and manager route helpers aligned with the shared contract helpers", () => {
    expect(ROUTES.agentDiagnostic("agent/1", "workspace 1")).toBe(
      agentDiagnosticRoute("agent/1", { workspaceId: "workspace 1" }),
    );
    expect(ROUTES.workspaceAgentDiagnostics("workspace 1")).toBe(
      workspaceAgentDiagnosticsRoute("workspace 1"),
    );
    expect(ROUTES.managerAgentStatus("workspace 1")).toBe(
      managerRuntimeStatusRoute("workspace 1"),
    );
  });

  it("keeps credential alias and worker bridge route helpers aligned with the shared contract helpers", () => {
    expect(ROUTES.credentialAlias("primary/openai")).toBe(
      credentialAliasRoute("primary/openai"),
    );
    expect(ROUTES.workerBridgeSession("session/1")).toBe(
      workerBridgeSessionRoute("session/1"),
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
