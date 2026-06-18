import { describe, expect, it } from "vitest";

import { LocalExecutionTargetSchema } from "../../../../../contracts/local-runtime.js";
import { buildLocalExecution } from "./config-snippet.js";

describe("buildLocalExecution", () => {
  it("derives online status from a fresh heartbeat", () => {
    const lastSeenAt = new Date().toISOString();

    expect(
      buildLocalExecution({
        machine: {
          id: "machine-1",
          display_name: "coder box",
          last_seen_at: lastSeenAt,
          revoked_at: null,
          runner_kinds: ["openai_compatible"],
          advertised_runner_kinds: ["openai_compatible"],
        },
        workspaceRoot: "/workspace",
      }),
    ).toMatchObject({
      status: "online",
      helperOnline: true,
      diagnostics: [],
    });
  });

  it("adds an actionable diagnostic for a stale helper heartbeat", () => {
    const staleHeartbeat = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    expect(
      buildLocalExecution({
        machine: {
          id: "machine-1",
          display_name: "coder box",
          last_seen_at: staleHeartbeat,
          revoked_at: null,
          runner_kinds: ["openai_compatible"],
          advertised_runner_kinds: ["openai_compatible"],
        },
        workspaceRoot: "/workspace",
      }),
    ).toMatchObject({
      status: "offline",
      helperOnline: false,
      diagnostics: [
        expect.objectContaining({
          code: "helper_heartbeat_stale",
          severity: "error",
          command:
            "local-runtime-helper doctor --config ~/.config/openmacaw/runtime.toml && local-runtime-helper start --config ~/.config/openmacaw/runtime.toml",
          logPath: null,
        }),
      ],
    });
  });

  it("adds a workspace-root diagnostic when repository tools cannot resolve local paths", () => {
    expect(
      buildLocalExecution({
        machine: {
          id: "machine-1",
          display_name: "coder box",
          last_seen_at: new Date().toISOString(),
          revoked_at: null,
          runner_kinds: ["openai_compatible"],
          advertised_runner_kinds: ["openai_compatible"],
        },
        workspaceRoot: null,
      }),
    ).toMatchObject({
      status: "online",
      helperOnline: true,
      diagnostics: [
        expect.objectContaining({
          code: "workspace_root_missing",
          severity: "warning",
        }),
      ],
    });
  });

  it("derives schema status from helperOnline when older mappers omit it", () => {
    expect(
      LocalExecutionTargetSchema.parse({
        machineId: "machine-1",
        machineDisplayName: "coder box",
        helperOnline: true,
        lastSeenAt: new Date().toISOString(),
        workspaceRoot: "/workspace",
        registered: true,
      }),
    ).toMatchObject({
      status: "online",
      helperOnline: true,
    });
  });
});
