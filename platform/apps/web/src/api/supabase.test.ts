import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getSupabaseClient,
  getSupabaseConfigStatus,
  SupabaseConfigError,
} from "./supabase";

describe("Supabase browser config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports missing browser Supabase config without constructing a client", () => {
    vi.stubEnv("VITE_SUPABASE_ENV", "dev");
    vi.stubEnv("VITE_SUPABASE_DEV_URL", "");
    vi.stubEnv("VITE_SUPABASE_DEV_ANON_KEY", "");
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "");

    expect(getSupabaseConfigStatus()).toMatchObject({
      configured: false,
      missing: ["Supabase URL", "Supabase anon key"],
    });
    expect(() => getSupabaseClient()).toThrow(SupabaseConfigError);
  });
});
