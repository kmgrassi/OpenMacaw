import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveLocalRuntimeHelperBase } from "./local-directory";

describe("local-directory api", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults directory picking to the local runtime helper", () => {
    vi.stubEnv("VITE_LOCAL_RUNTIME_HELPER_BASE", "");
    expect(resolveLocalRuntimeHelperBase()).toBe("http://127.0.0.1:7317");
  });

  it("allows overriding the local runtime helper base", () => {
    vi.stubEnv("VITE_LOCAL_RUNTIME_HELPER_BASE", "http://127.0.0.1:8123/");
    expect(resolveLocalRuntimeHelperBase()).toBe("http://127.0.0.1:8123");
  });
});
