import { afterEach, describe, expect, it, vi } from "vitest";

import { probeLocalModel } from "./probing.js";

const { getLocalRuntimeRuleDetails } = vi.hoisted(() => ({
  getLocalRuntimeRuleDetails: vi.fn(),
}));

vi.mock("./routing-metadata.js", () => ({
  getLocalRuntimeRuleDetails,
}));

describe("probeLocalModel", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("matches a listed model by id", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "qwen3-coder:30b" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      probeLocalModel({
        endpoint: "http://127.0.0.1:11434/v1",
        model: "qwen3-coder:30b",
      }),
    ).resolves.toMatchObject({
      reachable: true,
      modelFound: true,
      error: null,
    });
  });

  it("matches a listed model by name", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ name: "qwen3-coder:30b" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      probeLocalModel({
        endpoint: "http://127.0.0.1:11434/v1",
        model: "qwen3-coder:30b",
      }),
    ).resolves.toMatchObject({
      reachable: true,
      modelFound: true,
      error: null,
    });
  });

  it("treats malformed model catalogs as reachable but missing the model", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ slug: "qwen3-coder:30b" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      probeLocalModel({
        endpoint: "http://127.0.0.1:11434/v1",
        model: "qwen3-coder:30b",
      }),
    ).resolves.toMatchObject({
      reachable: true,
      modelFound: false,
      error: "Endpoint is reachable, but the model was not listed",
    });
  });

  it("surfaces upstream HTTP failures without throwing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("bad gateway", {
        status: 502,
      }),
    );

    await expect(
      probeLocalModel({
        endpoint: "http://127.0.0.1:11434/v1",
        model: "qwen3-coder:30b",
      }),
    ).resolves.toMatchObject({
      reachable: false,
      modelFound: false,
      error: "Model endpoint returned HTTP 502",
    });
  });
});
