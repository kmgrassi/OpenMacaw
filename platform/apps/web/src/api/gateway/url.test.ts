import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveGatewayWsUrl } from "./url";

describe("resolveGatewayWsUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses the explicit gateway websocket URL when configured", () => {
    vi.stubEnv("VITE_GATEWAY_WS_URL", "wss://gateway.example.com");
    vi.stubEnv("VITE_BROKER_BASE", "https://api.example.com");

    expect(resolveGatewayWsUrl()).toBe("wss://gateway.example.com/ws");
  });

  it("derives the websocket URL from the broker base when the websocket env is missing", () => {
    vi.stubEnv("VITE_GATEWAY_WS_URL", "");
    vi.stubEnv("VITE_BROKER_BASE", "https://api.example.com");

    expect(resolveGatewayWsUrl()).toBe("wss://api.example.com/ws");
  });

  it("derives the websocket URL from the stored broker base when env is missing", () => {
    vi.stubEnv("VITE_GATEWAY_WS_URL", "");
    vi.stubEnv("VITE_BROKER_BASE", "");
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) =>
          key === "openclaw.broker_base" ? "https://api.example.com/" : null,
      },
      location: {
        hostname: "app.openmacaw.ai",
      },
    });

    expect(resolveGatewayWsUrl()).toBe("wss://api.example.com/ws");
  });
});
