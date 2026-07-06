import { vi } from "vitest";

import { createMockSupabaseClient as createSupabaseClientMock } from "../test-utils/supabase-client-mock.js";
import type * as RuntimeTargetModule from "./runtime-target.js";

vi.mock("../supabase-client.js", () => ({
  getServiceRoleSupabase: vi.fn(),
}));

vi.mock("./runtime-target.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeTargetModule>();
  return {
    ...actual,
    resolveRuntimeTargetForAgent: vi.fn(),
    localOrchestratorRuntimeTarget: vi.fn(),
  };
});

export const createMockSupabaseClient = createSupabaseClientMock;

export const supabaseClientModule = await import("../supabase-client.js");
export const localRuntimeMachinesModule = await import("./local-runtime-machines.js");
export const runtimeTargetModule = await import("./runtime-target.js");
