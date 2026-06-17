import assert from "node:assert/strict";
import test from "node:test";
import {
  waitForGatewayEvent,
  waitForGatewayHello,
  waitForGatewayResponse,
  waitForSocketOpen,
} from "./gateway-ws.mjs";

class FakeSocket {
  #listeners = new Map();

  addEventListener(type, handler) {
    const handlers = this.#listeners.get(type) ?? new Set();
    handlers.add(handler);
    this.#listeners.set(type, handlers);
  }

  removeEventListener(type, handler) {
    this.#listeners.get(type)?.delete(handler);
  }

  emit(type, event = {}) {
    for (const handler of [...(this.#listeners.get(type) ?? [])]) {
      handler(event);
    }
  }
}

function parseFrame(value) {
  return JSON.parse(value);
}

test("waitForSocketOpen resolves when the socket opens", async () => {
  const ws = new FakeSocket();
  const promise = waitForSocketOpen(ws, { timeoutMs: 100 });
  ws.emit("open");
  await promise;
});

test("waitForGatewayHello resolves on hello-ok and forwards parsed frames", async () => {
  const ws = new FakeSocket();
  const observed = [];
  const promise = waitForGatewayHello({
    ws,
    requestId: "req-1",
    timeoutMs: 100,
    parseFrame,
    onFrame: (frame) => observed.push(frame?.type ?? null),
  });

  ws.emit("message", { data: JSON.stringify({ type: "hello-ok" }) });

  const frame = await promise;
  assert.equal(frame.type, "hello-ok");
  assert.deepEqual(observed, ["hello-ok"]);
});

test("waitForGatewayResponse rejects request errors with the gateway message", async () => {
  const ws = new FakeSocket();
  const promise = waitForGatewayResponse({
    ws,
    requestId: "req-2",
    timeoutMs: 100,
    parseFrame,
  });

  ws.emit("message", {
    data: JSON.stringify({
      type: "res",
      id: "req-2",
      ok: false,
      error: { message: "denied" },
    }),
  });

  await assert.rejects(promise, /denied/);
});

test("waitForGatewayResponse rejects malformed success frames without ok:true", async () => {
  const ws = new FakeSocket();
  const promise = waitForGatewayResponse({
    ws,
    requestId: "req-3",
    timeoutMs: 100,
    parseFrame,
  });

  ws.emit("message", {
    data: JSON.stringify({
      type: "res",
      id: "req-3",
      payload: {},
    }),
  });

  await assert.rejects(promise, /malformed response/);
});

test("waitForGatewayEvent resolves terminal results and falls back on close", async () => {
  const completedSocket = new FakeSocket();
  const completedPromise = waitForGatewayEvent({
    ws: completedSocket,
    timeoutMs: 100,
    parseFrame,
    fallbackResult: () => ({ status: "fallback" }),
    onFrameResult: (frame) => {
      if (frame?.type !== "event") return undefined;
      return { status: frame.payload.state };
    },
  });

  completedSocket.emit("message", {
    data: JSON.stringify({ type: "event", payload: { state: "completed" } }),
  });

  assert.deepEqual(await completedPromise, { status: "completed" });

  const closedSocket = new FakeSocket();
  const closedPromise = waitForGatewayEvent({
    ws: closedSocket,
    timeoutMs: 100,
    parseFrame,
    fallbackResult: () => ({ status: "fallback" }),
    onFrameResult: () => undefined,
  });

  closedSocket.emit("close");

  assert.deepEqual(await closedPromise, { status: "fallback" });
});
