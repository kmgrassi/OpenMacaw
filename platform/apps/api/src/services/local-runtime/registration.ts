import type { TablesInsert } from "@kmgrassi/supabase-schema";

import type { LocalRuntimeRunnerInput, LocalToolCallCapability } from "../../../../../contracts/local-runtime.js";
import { narrowSupabase } from "../../lib/narrow-supabase.js";
import { assertSupabaseSuccess } from "../../lib/supabase-errors.js";
import type { getServiceRoleSupabase } from "../../supabase-client.js";
import type { RunnerSnippet } from "./config-snippet.js";
import type { RunnerRow } from "./mappers.js";
import type { LocalRuntimeRunnerDetails } from "./routing-metadata.js";

type SupabaseClient = ReturnType<typeof getServiceRoleSupabase>;

export function defaultMachineDisplayName(runners: LocalRuntimeRunnerInput[]): string {
  const primary = runners[0];
  if (!primary) return "local-helper";
  if (primary.kind === "openclaw") {
    try {
      return `openclaw@${new URL(primary.endpoint).host}`;
    } catch {
      return `openclaw@${primary.endpoint}`;
    }
  }
  try {
    return `${primary.model}@${new URL(primary.endpoint).host}`;
  } catch {
    return `${primary.model}@${primary.endpoint}`;
  }
}

export function buildRunnerSnippets(runners: LocalRuntimeRunnerInput[]): RunnerSnippet[] {
  return runners.map((runner) => {
    if (runner.kind === "openclaw") {
      return {
        kind: "openclaw",
        endpoint: runner.endpoint,
        apiKey: runner.apiKey ?? null,
      } satisfies RunnerSnippet;
    }
    return {
      kind: "openai_compatible",
      endpoint: runner.endpoint,
      apiKey: runner.apiKey ?? null,
      model: runner.model,
      toolCallCapability: runner.toolCallCapability,
    } satisfies RunnerSnippet;
  });
}

export function runnerSnippetFromDetails(runner: LocalRuntimeRunnerDetails): RunnerSnippet {
  if (runner.kind === "openclaw") {
    return { kind: "openclaw", endpoint: runner.endpoint, apiKey: runner.apiKey };
  }
  return {
    kind: "openai_compatible",
    endpoint: runner.endpoint,
    apiKey: runner.apiKey,
    model: runner.model ?? "",
    toolCallCapability: runner.toolCallCapability ?? "native_tools",
  };
}

export type InsertedRunner = {
  ruleId: string;
  runner: LocalRuntimeRunnerInput;
  runnerKind: "local_relay";
  provider: string;
  toolCallCapability: LocalToolCallCapability | null;
};

export async function insertRunnerRoutingRules(input: {
  supabase: SupabaseClient;
  workspaceId: string;
  machineId: string;
  runners: LocalRuntimeRunnerInput[];
}): Promise<InsertedRunner[]> {
  const inserted: InsertedRunner[] = [];

  for (const runner of input.runners) {
    const ruleInsert =
      runner.kind === "openclaw"
        ? {
            workspace_id: input.workspaceId,
            name: `local:openclaw:${input.machineId}`,
            runner_kind: "local_relay" as const,
            provider: "openclaw",
            model: null,
            priority: 0,
            enabled: true,
          }
        : {
            workspace_id: input.workspaceId,
            name: `local:${runner.model}`,
            runner_kind: "local_relay" as const,
            provider: runner.provider,
            model: runner.model,
            priority: 0,
            enabled: true,
          };

    const { data: rule, error: ruleError } = await input.supabase
      .from("routing_rule")
      .insert(ruleInsert)
      .select("id, model, provider, runner_kind")
      .single();

    assertSupabaseSuccess("create routing rule for local runtime", rule, ruleError);

    const { error: machineColumnError } = await narrowSupabase(input.supabase)
      .from("routing_rule")
      .update({ machine_id: input.machineId })
      .eq("id", rule.id)
      .eq("workspace_id", input.workspaceId);
    if (machineColumnError) {
      assertSupabaseSuccess("persist local runtime machine column", null, machineColumnError);
    }

    const matches: Array<TablesInsert<"routing_rule_match">> = [
      {
        workspace_id: input.workspaceId,
        rule_id: rule.id,
        kind: "local_endpoint",
        key: "url",
        value: runner.endpoint,
      },
      {
        workspace_id: input.workspaceId,
        rule_id: rule.id,
        kind: "local_machine",
        key: "id",
        value: input.machineId,
      },
    ];
    if (runner.kind === "openai_compatible") {
      matches.push({
        workspace_id: input.workspaceId,
        rule_id: rule.id,
        kind: "local_model_capability",
        key: "tool_call",
        value: runner.toolCallCapability,
      });
      if (runner.workspaceRoot?.trim()) {
        matches.push({
          workspace_id: input.workspaceId,
          rule_id: rule.id,
          kind: "local_workspace_root",
          key: "path",
          value: runner.workspaceRoot.trim(),
        });
      }
    }

    const { error: matchError } = await input.supabase.from("routing_rule_match").insert(matches);
    if (matchError) {
      assertSupabaseSuccess("create routing rule metadata for local runtime", null, matchError);
    }

    inserted.push({
      ruleId: rule.id,
      runner,
      runnerKind: "local_relay",
      provider: rule.provider ?? (runner.kind === "openclaw" ? "openclaw" : "openai_compatible"),
      toolCallCapability: runner.kind === "openclaw" ? null : runner.toolCallCapability,
    });
  }

  return inserted;
}

export function insertedRunnerRows(inserted: InsertedRunner[]): RunnerRow[] {
  return inserted.map((entry) => ({
    id: entry.ruleId,
    kind: entry.runner.kind,
    runnerKind: entry.runnerKind,
    endpoint: entry.runner.endpoint,
    model: entry.runner.kind === "openclaw" ? null : entry.runner.model,
    provider: entry.provider,
    lastError: null,
    lastErrorAt: null,
    models: [],
    toolCallCapability: entry.toolCallCapability,
    agents: [],
  }));
}
