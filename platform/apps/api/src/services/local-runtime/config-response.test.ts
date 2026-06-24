import { afterEach, describe, expect, it } from "vitest";

import {
  buildLocalRuntimeConfigResponse,
  buildRegistrationConfig,
  localRelayRuntimeEndpoint,
  sharedWorkspaceRootFromRegistration,
} from "./config-response.js";

describe("localRelayRuntimeEndpoint", () => {
  afterEach(() => {
    delete process.env.LOCAL_RELAY_WS_URL;
  });

  it("uses the default relay endpoint when the environment variable is unset", () => {
    delete process.env.LOCAL_RELAY_WS_URL;

    expect(localRelayRuntimeEndpoint()).toBe("ws://127.0.0.1:4000");
  });

  it("prefers the configured relay endpoint from the environment", () => {
    process.env.LOCAL_RELAY_WS_URL = "ws://localhost:9999";

    expect(localRelayRuntimeEndpoint()).toBe("ws://localhost:9999");
  });
});

describe("sharedWorkspaceRootFromRegistration", () => {
  it("returns the first trimmed openai-compatible workspace root", () => {
    expect(
      sharedWorkspaceRootFromRegistration([
        {
          kind: "openclaw",
          endpoint: "http://localhost:7100",
        },
        {
          kind: "openai_compatible",
          endpoint: "http://127.0.0.1:11434/v1",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
          workspaceRoot: "  /tmp/workspace  ",
          toolCallCapability: "native_tools",
        },
      ]),
    ).toBe("/tmp/workspace");
  });

  it("returns null when no openai-compatible runner declares a workspace root", () => {
    expect(
      sharedWorkspaceRootFromRegistration([
        {
          kind: "openclaw",
          endpoint: "http://localhost:7100",
        },
      ]),
    ).toBeNull();
  });
});

describe("buildRegistrationConfig", () => {
  afterEach(() => {
    delete process.env.LOCAL_RELAY_WS_URL;
  });

  it("builds config snippets with the resolved runtime endpoint", () => {
    process.env.LOCAL_RELAY_WS_URL = "ws://localhost:9999";

    expect(
      buildRegistrationConfig({
        workspaceId: "workspace-1",
        machineId: "machine-1",
        displayName: "qwen3-coder",
        workspaceRoot: "/tmp/workspace",
        token: "token-1",
        runners: [
          {
            kind: "openai_compatible",
            endpoint: "http://127.0.0.1:11434/v1",
            model: "qwen3-coder:30b",
            provider: "openai_compatible",
            workspaceRoot: "/tmp/workspace",
            toolCallCapability: "native_tools",
          },
        ],
      }),
    ).toMatchObject({
      machineId: "machine-1",
      runtimeEndpoint: "ws://localhost:9999",
      workspaceId: "workspace-1",
      token: "token-1",
      runners: [
        expect.objectContaining({
          kind: "openai_compatible",
          model: "qwen3-coder:30b",
        }),
      ],
    });
  });
});

describe("buildLocalRuntimeConfigResponse", () => {
  afterEach(() => {
    delete process.env.LOCAL_RELAY_WS_URL;
  });

  it("uses the rotate-token placeholder when no token is available", () => {
    const response = buildLocalRuntimeConfigResponse({
      workspaceId: "workspace-1",
      machineId: "machine-1",
      machineDisplayName: "coder box",
      workspaceRoot: "/tmp/workspace",
      token: null,
      tokenAvailable: false,
      runners: [
        {
          ruleId: "runner-1",
          kind: "openai_compatible",
          runnerKind: "local_relay",
          diagnosticRunnerKind: "openai_compatible",
          endpoint: "http://127.0.0.1:11434/v1",
          model: "qwen3-coder:30b",
          provider: "openai_compatible",
          toolCallCapability: "native_tools",
          apiKey: null,
        },
      ],
    });

    expect(response.token).toBeNull();
    expect(response.tokenAvailable).toBe(false);
    expect(response.configSnippet).toContain('token = "<rotate-token-to-generate-a-new-value>"');
    expect(response.configSnippet).toContain('id = "machine-1"');
    expect(response.configSnippet).toContain('endpoint = "ws://127.0.0.1:4000"');
    expect(response.setupCommand).toContain('GOBIN="$(go env GOBIN)"');
    expect(response.setupCommand).toContain('HELPER_BIN="${GOBIN:-$GOPATH/bin}/local-runtime-helper"');
    expect(response.setupCommand).toContain('"$HELPER_BIN"');
    expect(response.setupCommand).toContain("'register'");
    expect(response.setupCommand).toContain("--machine-id");
    expect(response.setupCommand).toContain("machine-1");
    expect(response.setupCommand).toContain("--openai-compatible-model");
    expect(response.setupCommand).toContain("<rotate-token-to-generate-a-new-value>");
  });
});
