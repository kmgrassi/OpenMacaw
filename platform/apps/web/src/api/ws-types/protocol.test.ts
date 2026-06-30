import { describe, expect, it } from "vitest";
import {
  gatewayFrameType,
  parseGatewayEventFrame,
  parseGatewayHelloOk,
  parseGatewayResponseFrame,
} from "./protocol";

describe("gateway websocket frame parsers", () => {
  it("parses typed chat event frames", () => {
    const frame = parseGatewayEventFrame({
      type: "event",
      event: "chat",
      payload: {
        runId: "run-1",
        sessionKey: "agent:11111111-1111-4111-8111-111111111111:main",
        state: "delta",
        message: [{ text: "hello" }],
      },
      seq: 7,
    });

    expect(frame).toEqual({
      type: "event",
      event: "chat",
      payload: {
        runId: "run-1",
        sessionKey: "agent:11111111-1111-4111-8111-111111111111:main",
        state: "delta",
        message: [{ text: "hello" }],
      },
      seq: 7,
    });
  });

  it("parses runtime tool lifecycle chat frames", () => {
    const frame = parseGatewayEventFrame({
      type: "event",
      event: "chat",
      payload: {
        runId: "run-1",
        sessionKey: "agent:11111111-1111-4111-8111-111111111111:main",
        state: "tool_call_started",
        tool_name: "task.create",
        tool_call_id: "call-1",
      },
    });

    expect(frame).toEqual({
      type: "event",
      event: "chat",
      payload: {
        runId: "run-1",
        sessionKey: "agent:11111111-1111-4111-8111-111111111111:main",
        state: "tool_call_started",
        tool_name: "task.create",
        tool_call_id: "call-1",
      },
      seq: undefined,
    });
  });

  it("rejects malformed runtime event frames", () => {
    expect(
      parseGatewayEventFrame({
        type: "event",
        event: "tool.started",
        payload: {
          sessionKey: "agent:11111111-1111-4111-8111-111111111111:main",
          toolName: ["Bash"],
        },
      }),
    ).toBeNull();
  });

  it("parses hello frames with optional sections", () => {
    const hello = parseGatewayHelloOk({
      type: "hello-ok",
      protocol: 3,
      server: { version: "1.2.3", connId: "conn-1" },
      features: { methods: ["connect"], events: ["chat"] },
      auth: { deviceToken: "token-1", role: "operator", scopes: ["admin"] },
      policy: { tickIntervalMs: 1000 },
      snapshot: { ready: true },
    });

    expect(hello?.server?.connId).toBe("conn-1");
    expect(hello?.features?.events).toEqual(["chat"]);
    expect(hello?.policy?.tickIntervalMs).toBe(1000);
  });

  it("rejects error responses without a valid error payload", () => {
    expect(
      parseGatewayResponseFrame({
        type: "res",
        id: "req-1",
        ok: false,
        error: { code: 42, message: "bad" },
      }),
    ).toBeNull();
  });

  it("reports the frame type when present", () => {
    expect(gatewayFrameType({ type: "event" })).toBe("event");
    expect(gatewayFrameType({ nope: true })).toBeUndefined();
  });
});
