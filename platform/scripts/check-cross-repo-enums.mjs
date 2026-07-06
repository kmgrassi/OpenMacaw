#!/usr/bin/env node
/**
 * Cross-repo enum drift check.
 *
 * Provider, runner_kind, and tracker_kind enums today live in multiple places
 * across three repos (see docs/active/unified-execution-profile-scope.md
 * "Current state — Provider"). When they drift, the surface is a runtime 502
 * (DB CHECK constraint), a silent idle (manager SessionResolver), an
 * incorrectly selected tracker adapter, or an invisibly-limited dropdown
 * (web).
 *
 * This script fetches the authoritative sources from harper-server and
 * parallel-agent-runtime and asserts each is a superset of the relevant
 * platform contract.
 *
 * Usage:
 *   node scripts/check-cross-repo-enums.mjs
 *
 * Exits 0 if every cross-repo list contains every value the platform
 * writes. Exits 1 with a diff on drift. Network required (fetches over
 * raw.githubusercontent.com).
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolvePath(__dirname, "..");

const HARPER_OWNER_REPO = "harper-hq/harper-server";
const HARPER_RAW = `https://raw.githubusercontent.com/${HARPER_OWNER_REPO}/main`;
const HARPER_API = `https://api.github.com/repos/${HARPER_OWNER_REPO}/contents/supabase/migrations`;
const RUNTIME_RAW =
  "https://raw.githubusercontent.com/kmgrassi/parallel-agent-runtime/main";

const RUNTIME_EXECUTION_PROFILE =
  "apps/orchestrator/lib/symphony_elixir/schema/execution_profile.ex";
const RUNTIME_TRACKER = "apps/orchestrator/lib/symphony_elixir/tracker.ex";
const RUNTIME_AGENT_PROBE =
  "apps/orchestrator/lib/symphony_elixir/diagnostic/agent_probe.ex";
const RUNTIME_AGENT_INVENTORY =
  "apps/orchestrator/lib/symphony_elixir/agent_inventory/agent.ex";
const RUNTIME_SCHEDULED_TASK_DELIVERY =
  "apps/orchestrator/lib/symphony_elixir/scheduled_task/delivery.ex";
const RUNTIME_POLICY_EVALUATOR_REGISTRY =
  "apps/orchestrator/lib/symphony_elixir/policy/evaluator_registry.ex";
const RUNTIME_NORMALIZED_RUNNER_KIND_ALIASES = {
  llm_tool_runner: ["manager", "planner"],
};
const RUNTIME_NON_SCHEMA_PLATFORM_RUNNER_KINDS = ["openclaw_http_sse"];
function headers() {
  return process.env.CROSS_REPO_GITHUB_TOKEN
    ? { Authorization: `Bearer ${process.env.CROSS_REPO_GITHUB_TOKEN}` }
    : {};
}

async function fetchText(url) {
  const response = await fetch(url, { headers: headers() });
  if (!response.ok) {
    throw new Error(`Could not fetch ${url}: HTTP ${response.status}`);
  }
  return await response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: headers() });
  if (!response.ok) {
    if (response.status === 404 && !process.env.CROSS_REPO_GITHUB_TOKEN) {
      throw new Error(
        `${url} returned 404. harper-server and parallel-agent-runtime are private repos. ` +
          `Set CROSS_REPO_GITHUB_TOKEN to a token that can read them.`,
      );
    }
    throw new Error(`Could not fetch ${url}: HTTP ${response.status}`);
  }
  return await response.json();
}

function hasCrossRepoToken() {
  return Boolean(process.env.CROSS_REPO_GITHUB_TOKEN);
}

/**
 * Walks the harper-server migrations directory (sorted by filename, which
 * encodes the apply order), and returns the body of the newest migration
 * whose text contains `constraintName`. Avoids the brittleness of hardcoding
 * a specific migration filename — when a follow-up migration redefines the
 * constraint, this picks the newer one automatically.
 */
async function findLatestConstraintSql(constraintName) {
  const listing = await fetchJson(HARPER_API);
  const files = listing
    .filter((entry) => entry.type === "file" && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  for (const name of files.slice().reverse()) {
    const body = await fetchText(`${HARPER_RAW}/supabase/migrations/${name}`);
    if (body.includes(constraintName)) {
      console.log(`  found ${constraintName} in ${name}`);
      return body;
    }
  }
  throw new Error(`No migration in harper-server defines ${constraintName}`);
}

async function maybeFindLatestConstraintSql(constraintName) {
  try {
    return await findLatestConstraintSql(constraintName);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("No migration in harper-server defines")
    ) {
      console.warn(`  warning: ${error.message}`);
      return null;
    }
    throw error;
  }
}

function readPlatformContract(file) {
  return readFileSync(resolvePath(repoRoot, file), "utf-8");
}

function readLocalRuntimeSource(file) {
  const path = resolvePath(repoRoot, "..", "runtime", file);
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, "utf-8");
}

/**
 * Extract a TS readonly tuple of string literals from a contracts file.
 * Looks for `export const NAME = [` ... `] as const`. Returns the values
 * between the brackets, trimmed of quotes and whitespace.
 */
function extractTsStringTuple(source, name) {
  const re = new RegExp(
    `export const ${name}\\s*=\\s*\\[([^\\]]+)\\]\\s*as\\s*const`,
    "m",
  );
  const match = source.match(re);
  if (!match) throw new Error(`Could not find ${name} in platform contracts`);
  return match[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^["']/, "").replace(/["']$/, ""))
    .filter((entry) => entry.length > 0);
}

function extractProviderRegistryKeys(source) {
  const registryMatch = source.match(
    /export const PROVIDER_REGISTRY\s*=\s*\{([\s\S]*?)\}\s*as\s*const;/m,
  );
  if (!registryMatch) {
    throw new Error("Could not find PROVIDER_REGISTRY in platform contracts");
  }
  return [...registryMatch[1].matchAll(/^\s{2}([a-z_]+):\s*\{/gm)].map(
    (match) => match[1],
  );
}

function extractModelTierRegistryProviders(source) {
  const registryMatch = source.match(
    /export const MODEL_TIER_REGISTRY:[\s\S]*?=\s*\[([\s\S]*?)\]\s*as\s*const;/m,
  );
  if (!registryMatch) {
    throw new Error("Could not find MODEL_TIER_REGISTRY in platform contracts");
  }
  return [
    ...new Set(
      [...registryMatch[1].matchAll(/provider:\s*"([^"]+)"/g)].map(
        (match) => match[1],
      ),
    ),
  ].sort();
}

function extractTsZodDiscriminatedUnionKinds(source, name) {
  const re = new RegExp(
    `export const ${name}\\s*=\\s*z\\.discriminatedUnion\\("kind",\\s*\\[([\\s\\S]*?)\\]\\);`,
    "m",
  );
  const match = source.match(re);
  if (!match) throw new Error(`Could not find ${name} discriminated union`);
  return [...match[1].matchAll(/kind:\s*z\.literal\("([^"]+)"\)/g)].map(
    (valueMatch) => valueMatch[1],
  );
}

function extractTsZodEnumValues(source, name) {
  const re = new RegExp(
    `export const ${name}\\s*=\\s*z\\.enum\\(\\[([\\s\\S]*?)\\]\\);`,
    "m",
  );
  const match = source.match(re);
  if (!match) throw new Error(`Could not find ${name} z.enum`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map(
    (valueMatch) => valueMatch[1],
  );
}

function extractRuntimeLearningDeliveryKinds(source) {
  const stringAttrs = new Map(
    [...source.matchAll(/@([a-z_]+)\s+"([^"]+)"/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  const kindsMatch = source.match(/@learning_kinds\s+\[([^\]]+)\]/m);
  if (!kindsMatch) {
    return [];
  }
  return kindsMatch[1]
    .split(",")
    .map((entry) => entry.trim())
    .map((entry) => {
      if (entry.startsWith("@")) {
        const attrName = entry.slice(1);
        const value = stringAttrs.get(attrName);
        if (!value) {
          throw new Error(
            `Could not resolve @${attrName} in ${RUNTIME_SCHEDULED_TASK_DELIVERY}`,
          );
        }
        return value;
      }
      return entry.replace(/^["']/, "").replace(/["']$/, "");
    })
    .filter((entry) => entry.length > 0);
}

/**
 * Pull the values out of a SQL `check (column in ('a', 'b', ...))` clause.
 * Tolerates the `column is null or column in (...)` form.
 */
function extractSqlInList(sql, constraintName) {
  const re = new RegExp(
    `constraint ${constraintName}[\\s\\S]*?check\\s*\\(([\\s\\S]*?)\\)\\s*;`,
    "m",
  );
  const match = sql.match(re);
  if (!match) throw new Error(`Could not find ${constraintName} in SQL`);
  return [...match[1].matchAll(/'([^']+)'/g)].map(
    (valueMatch) => valueMatch[1],
  );
}

/**
 * Pull values out of an Elixir `@attr ~w(a b c)` form or
 * `@attr ["a", "b", ...]`. Resolves the @attr by attribute name.
 */
function extractElixirAttrList(source, attrName) {
  // ~w(...) form
  const sigilRe = new RegExp(`@${attrName}\\s+~w\\(([^)]+)\\)`, "m");
  const sigilMatch = source.match(sigilRe);
  if (sigilMatch) {
    return sigilMatch[1].trim().split(/\s+/);
  }
  // [...] form, possibly with `++` concatenations of other attrs we treat as opaque
  const listRe = new RegExp(`@${attrName}\\s+\\[([^\\]]+)\\]`, "m");
  const listMatch = source.match(listRe);
  if (!listMatch)
    throw new Error(`Could not find @${attrName} in Elixir source`);
  return listMatch[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^['"]/, "").replace(/['"]$/, ""))
    .filter((entry) => entry.length > 0);
}

function maybeExtractElixirAttrList(source, attrName) {
  try {
    return extractElixirAttrList(source, attrName);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes(`Could not find @${attrName}`)
    ) {
      return null;
    }
    throw error;
  }
}

function extractRuntimeTrackerKinds(profileSource, trackerSource) {
  const attrKinds =
    maybeExtractElixirAttrList(profileSource, "supported_tracker_kinds") ??
    maybeExtractElixirAttrList(trackerSource, "supported_tracker_kinds");

  if (attrKinds) {
    return {
      source: "@supported_tracker_kinds",
      values: attrKinds,
    };
  }

  const adapterBranches = [
    ...trackerSource.matchAll(
      /"([^"]+)"\s*->\s*(?:require_started!\()?SymphonyElixir\.Tracker\./g,
    ),
  ].map((match) => match[1]);

  if (adapterBranches.length === 0) {
    throw new Error(
      `Could not find runtime tracker kinds in ${RUNTIME_TRACKER}`,
    );
  }

  return {
    source: "Tracker.adapter case branches",
    values: adapterBranches,
  };
}

/**
 * Pull atom values out of an Elixir union type, for example:
 *
 *   @type reason ::
 *           :gateway_config_missing
 *           | :runner_spawn_failed
 */
function extractElixirAtomUnionType(source, typeName) {
  const re = new RegExp(
    `@type\\s+${typeName}\\s+::\\s*([\\s\\S]*?)(?=\\n\\s*@(?:type|spec|doc|moduledoc)|\\n\\s*def\\s|\\nend\\b)`,
    "m",
  );
  const match = source.match(re);
  if (!match) {
    throw new Error(`Could not find @type ${typeName} in Elixir source`);
  }
  return [...match[1].matchAll(/:([a-z][a-z0-9_]*)/g)].map(
    (valueMatch) => valueMatch[1],
  );
}

function assertNoUnexpectedRuntimeValues({ name, platform, runtime }) {
  const unexpected = runtime.filter((value) => !platform.includes(value));
  if (unexpected.length === 0) {
    console.log(
      `  ✓ ${name}: ${platform.length} platform values cover ${runtime.length} runtime values`,
    );
    return true;
  }
  console.log(`  ✗ ${name}: platform missing [${unexpected.join(", ")}]`);
  console.log(`    platform = [${platform.join(", ")}]`);
  console.log(`    runtime = [${runtime.join(", ")}]`);
  return false;
}

function assertSuperset({ name, allowed, required }) {
  const missing = required.filter((value) => !allowed.includes(value));
  if (missing.length === 0) {
    console.log(
      `  ✓ ${name}: ${allowed.length} allowed, ${required.length} required, all present`,
    );
    return true;
  }
  console.log(`  ✗ ${name}: missing [${missing.join(", ")}]`);
  console.log(`    allowed = [${allowed.join(", ")}]`);
  console.log(`    required = [${required.join(", ")}]`);
  return false;
}

function assertSameSet({ name, left, right }) {
  const missingFromRight = left.filter((value) => !right.includes(value));
  const missingFromLeft = right.filter((value) => !left.includes(value));
  if (missingFromRight.length === 0 && missingFromLeft.length === 0) {
    console.log(`  ✓ ${name}: [${left.join(", ")}]`);
    return true;
  }
  if (missingFromRight.length > 0) {
    console.log(
      `  ✗ ${name}: right side missing [${missingFromRight.join(", ")}]`,
    );
  }
  if (missingFromLeft.length > 0) {
    console.log(
      `  ✗ ${name}: left side missing [${missingFromLeft.join(", ")}]`,
    );
  }
  console.log(`    left = [${left.join(", ")}]`);
  console.log(`    right = [${right.join(", ")}]`);
  return false;
}

function assertRuntimeRunnerKindCoverage({ allowed, required }) {
  const missing = required.filter((value) => {
    if (allowed.includes(value)) return false;
    if (RUNTIME_NON_SCHEMA_PLATFORM_RUNNER_KINDS.includes(value)) return false;

    const aliases = RUNTIME_NORMALIZED_RUNNER_KIND_ALIASES[value];
    return !(aliases && aliases.every((alias) => allowed.includes(alias)));
  });

  if (missing.length === 0) {
    console.log(
      `  ✓ execution_profile.ex @supported_runner_kinds covers platform RUNNER_KINDS`,
    );
    return true;
  }

  console.log(
    `  ✗ execution_profile.ex @supported_runner_kinds: missing [${missing.join(", ")}]`,
  );
  console.log(`    allowed = [${allowed.join(", ")}]`);
  console.log(`    required = [${required.join(", ")}]`);
  return false;
}

function runSelfTest() {
  const runtimeAgentProbe = `
defmodule SymphonyElixir.Diagnostic.AgentProbe do
  @type reason ::
          :gateway_config_missing
          | :runner_spawn_failed
          | :new_runtime_probe_error

  @spec probe(String.t(), String.t()) :: {:ok, :ready} | {:error, reason(), map()}
  def probe(_workspace_id, _agent_id), do: {:error, :new_runtime_probe_error, %{}}
end
`;
  const platformDiagnosticCodes = [
    "gateway_config_missing",
    "runner_spawn_failed",
  ];
  const runtimeProbeErrors = extractElixirAtomUnionType(
    runtimeAgentProbe,
    "reason",
  );
  const ok = assertNoUnexpectedRuntimeValues({
    name: "self-test diagnostic error drift",
    platform: platformDiagnosticCodes,
    runtime: runtimeProbeErrors,
  });
  if (ok) {
    throw new Error(
      "self-test expected an injected runtime diagnostic error to fail coverage",
    );
  }
  console.log(
    "Self-test passed: injected runtime diagnostic error was detected.",
  );
}

async function main() {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
    return;
  }

  console.log("Reading platform contracts (local)…");
  const providerRegistry = readPlatformContract(
    "contracts/provider-registry.ts",
  );
  const platformRegisteredProviders =
    extractProviderRegistryKeys(providerRegistry);
  const platformExecutionProviders = extractTsStringTuple(
    providerRegistry,
    "KNOWN_EXECUTION_PROVIDER_IDS",
  );
  const platformCredentialProviders = extractTsStringTuple(
    providerRegistry,
    "CREDENTIAL_PROVIDER_IDS",
  );
  const platformManagerProviders = extractTsStringTuple(
    providerRegistry,
    "MANAGER_PROVIDER_IDS",
  );
  const modelTiers = readPlatformContract("contracts/model-tiers.ts");
  const modelTierRegistryProviders =
    extractModelTierRegistryProviders(modelTiers);
  const modelTierExecutionProviders = modelTierRegistryProviders.filter(
    (provider) => platformExecutionProviders.includes(provider),
  );
  const modelTierCredentialProviders = modelTierRegistryProviders.filter(
    (provider) =>
      platformCredentialProviders.includes(provider) ||
      provider === "openai_compatible",
  );

  const runnerKinds = readPlatformContract("contracts/runner-kinds.ts");
  // RUNNER_KINDS is derived from RUNNER_REGISTRY keys at runtime; pick keys
  // out of the registry literal instead. Matches `  key: {` lines.
  const platformRunnerKinds = [
    ...runnerKinds.matchAll(/^\s{2}([a-z_]+):\s*\{/gm),
  ].map((m) => m[1]);
  const trackerKinds = readPlatformContract("contracts/tracker-kinds.ts");
  const platformTrackerKinds = extractTsStringTuple(
    trackerKinds,
    "TRACKER_KINDS",
  );
  const agentHealth = readPlatformContract("contracts/agent-health.ts");
  const platformDiagnosticErrorCodes = extractTsStringTuple(
    agentHealth,
    "DiagnosticErrorCodes",
  );
  const scheduledTasks = readPlatformContract("contracts/scheduled-tasks.ts");
  const platformLearningDeliveryKinds = extractTsZodDiscriminatedUnionKinds(
    scheduledTasks,
    "ScheduledTaskDeliverySchema",
  ).filter((kind) => kind.startsWith("learning_"));
  const agentContract = readPlatformContract("contracts/agents.ts");
  const platformAgentTypes = extractTsZodEnumValues(
    agentContract,
    "AgentTypeSchema",
  );
  const policyContract = readPlatformContract("contracts/policy.ts");
  const platformPolicyKinds = extractTsStringTuple(
    policyContract,
    "POLICY_KINDS",
  );

  console.log(
    `  platform KNOWN_EXECUTION_PROVIDER_IDS: ${platformExecutionProviders.length}`,
  );
  console.log(
    `  platform CREDENTIAL_PROVIDER_IDS:      ${platformCredentialProviders.length}`,
  );
  console.log(
    `  platform MANAGER_PROVIDER_IDS:         ${platformManagerProviders.length}`,
  );
  console.log(
    `  platform RUNNER_KINDS:                 ${platformRunnerKinds.length}`,
  );
  console.log(
    `  platform TRACKER_KINDS:                ${platformTrackerKinds.length}`,
  );
  console.log(
    `  platform DiagnosticErrorCodes:         ${platformDiagnosticErrorCodes.length}`,
  );
  console.log(
    `  platform MODEL_TIER_REGISTRY providers: ${modelTierRegistryProviders.length}`,
  );
  console.log(
    `  platform learning delivery kinds:       ${platformLearningDeliveryKinds.length}`,
  );
  console.log(
    `  platform agent types:                  ${platformAgentTypes.length}`,
  );
  console.log(
    `  platform policy kinds:                 ${platformPolicyKinds.length}`,
  );

  const localRuntimeDelivery = readLocalRuntimeSource(
    RUNTIME_SCHEDULED_TASK_DELIVERY,
  );
  const localRuntimeAgentInventory = readLocalRuntimeSource(
    RUNTIME_AGENT_INVENTORY,
  );
  const localRuntimePolicyEvaluatorRegistry = readLocalRuntimeSource(
    RUNTIME_POLICY_EVALUATOR_REGISTRY,
  );
  const localLearningDeliveryOk = localRuntimeDelivery
    ? assertSameSet({
        name: "local runtime @learning_kinds = platform learning delivery kinds",
        left: platformLearningDeliveryKinds,
        right: extractRuntimeLearningDeliveryKinds(localRuntimeDelivery),
      })
    : true;
  if (!localRuntimeDelivery) {
    console.warn(
      `  warning: local ${RUNTIME_SCHEDULED_TASK_DELIVERY} not found; remote runtime check will run when CROSS_REPO_GITHUB_TOKEN is set`,
    );
  }
  const localAgentTypesOk = localRuntimeAgentInventory
    ? assertSameSet({
        name: "local runtime AgentInventory @supported_kinds = platform AgentTypeSchema",
        left: platformAgentTypes,
        right: extractElixirAttrList(
          localRuntimeAgentInventory,
          "supported_kinds",
        ),
      })
    : true;
  if (!localRuntimeAgentInventory) {
    console.warn(
      `  warning: local ${RUNTIME_AGENT_INVENTORY} not found; remote runtime check will run when CROSS_REPO_GITHUB_TOKEN is set`,
    );
  }
  const localPolicyKindsOk = localRuntimePolicyEvaluatorRegistry
    ? assertSameSet({
        name: "local runtime Policy.EvaluatorRegistry @policy_kinds = platform POLICY_KINDS",
        left: platformPolicyKinds,
        right: extractElixirAttrList(
          localRuntimePolicyEvaluatorRegistry,
          "policy_kinds",
        ),
      })
    : hasCrossRepoToken();
  if (!localRuntimePolicyEvaluatorRegistry) {
    console.warn(
      `  warning: local ${RUNTIME_POLICY_EVALUATOR_REGISTRY} not found; remote runtime check will run when CROSS_REPO_GITHUB_TOKEN is set`,
    );
  }

  const localModelTierOk = assertSuperset({
    name: "PROVIDER_REGISTRY keys ⊇ MODEL_TIER_REGISTRY providers",
    allowed: platformRegisteredProviders,
    required: modelTierRegistryProviders,
  });
  if (
    !localModelTierOk ||
    !localLearningDeliveryOk ||
    !localAgentTypesOk ||
    !localPolicyKindsOk
  ) {
    process.exit(1);
  }

  if (!hasCrossRepoToken()) {
    console.warn(
      "\nSkipping cross-repo enum drift validation: CROSS_REPO_GITHUB_TOKEN is not set, " +
        "and harper-server plus parallel-agent-runtime are private repos.",
    );
    process.exit(0);
  }

  console.log("Fetching harper-server migrations…");
  const harperProviderSql = await findLatestConstraintSql(
    "routing_rule_provider_check",
  );
  const harperRunnerKindSql = await findLatestConstraintSql(
    "routing_rule_runner_kind_check",
  );
  const harperCredentialSql = await findLatestConstraintSql(
    "credential_provider_check",
  );
  const harperTrackerKindSql = await maybeFindLatestConstraintSql(
    "workspace_settings_tracker_kind_check",
  );

  const dbProviderAllowed = extractSqlInList(
    harperProviderSql,
    "routing_rule_provider_check",
  );
  const dbRunnerKindAllowed = extractSqlInList(
    harperRunnerKindSql,
    "routing_rule_runner_kind_check",
  );
  const dbCredentialProviderAllowed = extractSqlInList(
    harperCredentialSql,
    "credential_provider_check",
  );
  const dbTrackerKindAllowed = harperTrackerKindSql
    ? extractSqlInList(
        harperTrackerKindSql,
        "workspace_settings_tracker_kind_check",
      )
    : null;

  console.log("\nDB allowlist coverage of platform writes:");
  const dbOk = [
    assertSuperset({
      name: "routing_rule.provider ⊇ KNOWN_EXECUTION_PROVIDER_IDS",
      allowed: dbProviderAllowed,
      required: platformExecutionProviders,
    }),
    assertSuperset({
      name: "routing_rule.runner_kind ⊇ RUNNER_KINDS",
      allowed: dbRunnerKindAllowed,
      required: platformRunnerKinds,
    }),
    assertSuperset({
      name: "credential.provider ⊇ platform credential providers",
      allowed: dbCredentialProviderAllowed,
      // `credential.provider` stores the concrete provider for every saved
      // credential key format. `openai_compatible` is written by the
      // compatible_endpoint credential shape even though it is not part of
      // CREDENTIAL_PROVIDER_IDS.
      required: [...platformCredentialProviders, "openai_compatible"],
    }),
    assertSuperset({
      name: "routing_rule.provider ⊇ executable MODEL_TIER_REGISTRY providers",
      allowed: dbProviderAllowed,
      required: modelTierExecutionProviders,
    }),
    assertSuperset({
      name: "credential.provider ⊇ credential-backed MODEL_TIER_REGISTRY providers",
      allowed: dbCredentialProviderAllowed,
      required: modelTierCredentialProviders,
    }),
    dbTrackerKindAllowed
      ? assertSuperset({
          name: "workspace_settings.tracker_kind ⊇ TRACKER_KINDS",
          allowed: dbTrackerKindAllowed,
          required: platformTrackerKinds,
        })
      : true,
  ].every(Boolean);
  if (!dbTrackerKindAllowed) {
    console.warn(
      "  warning: skipping workspace_settings.tracker_kind DB coverage until harper-server adds the CHECK constraint",
    );
  }

  console.log("Fetching parallel-agent-runtime Elixir sources…");
  const runtimeProfile = await fetchText(
    `${RUNTIME_RAW}/${RUNTIME_EXECUTION_PROFILE}`,
  );
  const runtimeTracker = await fetchText(`${RUNTIME_RAW}/${RUNTIME_TRACKER}`);
  const runtimeAgentProbe = await fetchText(
    `${RUNTIME_RAW}/${RUNTIME_AGENT_PROBE}`,
  );
  const runtimeAgentInventory = await fetchText(
    `${RUNTIME_RAW}/${RUNTIME_AGENT_INVENTORY}`,
  );
  const runtimeScheduledTaskDelivery = await fetchText(
    `${RUNTIME_RAW}/${RUNTIME_SCHEDULED_TASK_DELIVERY}`,
  );
  const runtimePolicyEvaluatorRegistry = await fetchText(
    `${RUNTIME_RAW}/${RUNTIME_POLICY_EVALUATOR_REGISTRY}`,
  );
  const runtimeRunnerKinds = extractElixirAttrList(
    runtimeProfile,
    "supported_runner_kinds",
  );
  const runtimeProviders = extractElixirAttrList(
    runtimeProfile,
    "supported_providers",
  );
  const runtimeTrackerKinds = extractRuntimeTrackerKinds(
    runtimeProfile,
    runtimeTracker,
  );
  const runtimeDiagnosticErrorCodes = extractElixirAtomUnionType(
    runtimeAgentProbe,
    "reason",
  );
  const runtimeLearningDeliveryKinds = extractRuntimeLearningDeliveryKinds(
    runtimeScheduledTaskDelivery,
  );
  const runtimeAgentTypes = extractElixirAttrList(
    runtimeAgentInventory,
    "supported_kinds",
  );
  const runtimePolicyKinds = extractElixirAttrList(
    runtimePolicyEvaluatorRegistry,
    "policy_kinds",
  );

  console.log("\nRuntime allowlist coverage of platform writes:");
  const runtimeOk = [
    assertSuperset({
      name: "execution_profile.ex @supported_providers ⊇ KNOWN_EXECUTION_PROVIDER_IDS",
      allowed: runtimeProviders,
      required: platformExecutionProviders,
    }),
    assertRuntimeRunnerKindCoverage({
      allowed: runtimeRunnerKinds,
      required: platformRunnerKinds,
    }),
    assertSuperset({
      name: "runtime execution_profile.ex @supported_providers ⊇ MANAGER_PROVIDER_IDS",
      // The old manager/session_resolver provider allowlist was removed when
      // manager routing moved onto the generic execution-profile path. The
      // runtime's enforced provider gate now lives in ExecutionProfileSchema,
      // so the manager subset must remain covered by that list.
      allowed: runtimeProviders,
      required: platformManagerProviders,
    }),
    assertSuperset({
      name: `runtime ${runtimeTrackerKinds.source} ⊇ platform TRACKER_KINDS`,
      allowed: runtimeTrackerKinds.values,
      required: platformTrackerKinds,
    }),
    assertNoUnexpectedRuntimeValues({
      name: "platform DiagnosticErrorCodes ⊇ runtime agent_probe reason",
      platform: platformDiagnosticErrorCodes,
      runtime: runtimeDiagnosticErrorCodes,
    }),
    assertSameSet({
      name: "runtime scheduled_task delivery @learning_kinds = platform learning delivery kinds",
      left: platformLearningDeliveryKinds,
      right: runtimeLearningDeliveryKinds,
    }),
    assertSameSet({
      name: "runtime AgentInventory @supported_kinds = platform AgentTypeSchema",
      left: platformAgentTypes,
      right: runtimeAgentTypes,
    }),
    assertSameSet({
      name: "runtime Policy.EvaluatorRegistry @policy_kinds = platform POLICY_KINDS",
      left: platformPolicyKinds,
      right: runtimePolicyKinds,
    }),
  ].every(Boolean);

  if (!dbOk || !runtimeOk) {
    console.error(
      "\nDrift detected. Update the corresponding source-of-truth and re-run.\n" +
        "See docs/active/unified-execution-profile-scope.md for the inventory.",
    );
    process.exit(1);
  }
  console.log("\nAll cross-repo enum allowlists are aligned. ✓");
}

main().catch((error) => {
  console.error(`check-cross-repo-enums failed: ${error.message}`);
  process.exit(1);
});
