import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const sourceRoot = new URL(".", import.meta.url).pathname;

function productionSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return productionSourceFiles(path);
    if (!path.endsWith(".ts")) return [];
    if (path.endsWith(".test.ts") || path.endsWith(".d.ts")) return [];
    return [path];
  });
}

// Files whose `URLSearchParams` use is for outbound HTTP requests to services
// we call (request bodies or query strings), not for Supabase REST queries.
// New entries here need to be justified in the PR description.
//   - services/oauth/openai-codex.ts: OAuth token endpoint request body.
//   - services/local-runtime/dispatch.ts: query string for the orchestrator's
//     /api/v1/local-runtime/health diagnostics probe.
const URLSEARCHPARAMS_ALLOWLIST = new Set(["services/oauth/openai-codex.ts", "services/local-runtime/dispatch.ts"]);
const POSTGREST_OPERATOR_FILTER_ALLOWLIST = new Set([
  // repositories/provider-cutovers.ts: keyset pagination uses Supabase's
  // `.or(...)` API, whose public typed-client contract accepts a PostgREST
  // filter string for grouped OR conditions.
  "repositories/provider-cutovers.ts",
]);

describe("Supabase data-access guardrails", () => {
  const files = productionSourceFiles(sourceRoot);

  it("keeps API production code on the typed Supabase client", () => {
    const violations = files.flatMap((file) => {
      const contents = readFileSync(file, "utf8");
      const relativePath = relative(sourceRoot, file);
      const matches = [
        contents.includes("supabase-rest-client") ? "supabase-rest-client import/reference" : null,
        contents.includes("/rest/v1") ? "direct Supabase REST endpoint" : null,
        contents.includes("new URLSearchParams") && !URLSEARCHPARAMS_ALLOWLIST.has(relativePath)
          ? "URLSearchParams database filters"
          : null,
        /eq\.\$\{|in\.\(/.test(contents) && !POSTGREST_OPERATOR_FILTER_ALLOWLIST.has(relativePath)
          ? "PostgREST operator string filters"
          : null,
      ].filter(Boolean);

      return matches.map((match) => `${relativePath}: ${match}`);
    });

    expect(violations).toEqual([]);
  });
});
