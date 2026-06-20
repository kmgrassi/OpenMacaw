import type { Json } from "@kmgrassi/supabase-schema";

import { executeSupabaseRows, getServiceRoleSupabase } from "../../supabase-client.js";

export type OperabilityIssueSignature = {
  toolSlug: string;
  errorCode: string;
  agentType?: string | null;
};

export type OperabilityRemediationIssue = {
  signature: OperabilityIssueSignature;
  occurrenceCount: number;
  sourceMemoryIds: string[];
  examples?: Array<Record<string, unknown>>;
};

type WorkItemLinkRow = {
  id: string;
  workspace_id: string | null;
  plan_id: string | null;
  title: string | null;
  state: string;
  metadata: Json;
  updated_at: string;
};

type MemoryItemRow = {
  id: string;
  workspace_id: string;
  content: string;
  tags: Json;
  event_time: string | null;
  created_at: string;
  is_deleted: boolean;
};

type AgentToolGrantViewRow = {
  id: string;
  agent_id: string;
  tool_id: string;
  workspace_id: string;
  mode: string;
  source: string;
  reason: string | null;
  created_at?: string;
  updated_at?: string;
};

const TERMINAL_WORK_ITEM_STATES = new Set(["done", "completed", "complete", "closed", "cancelled", "canceled"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function operabilitySignatureKey(signature: OperabilityIssueSignature): string {
  const toolSlug = signature.toolSlug.trim() || "unknown_tool";
  const errorCode = signature.errorCode.trim() || "unknown_error";
  const agentType = signature.agentType?.trim() || "unknown_agent_type";
  return `tool:${toolSlug}|error:${errorCode}|agent:${agentType}`;
}

export function operabilityWorkItemMetadata(input: {
  signature: OperabilityIssueSignature;
  sourceMemoryIds: string[];
}): Record<string, unknown> {
  return {
    operability_remediation: {
      signature: operabilitySignatureKey(input.signature),
      signature_parts: {
        tool_slug: input.signature.toolSlug,
        error_code: input.signature.errorCode,
        agent_type: input.signature.agentType ?? null,
      },
      source_memory_ids: Array.from(new Set(input.sourceMemoryIds)),
    },
  };
}

export function buildOperabilityRemediationInstructions(input: {
  issues: OperabilityRemediationIssue[];
  maxNewWorkItems?: number;
}): string {
  const maxNewWorkItems = input.maxNewWorkItems ?? 3;
  const issuesJson = JSON.stringify(
    input.issues.map((issue) => ({
      signature: operabilitySignatureKey(issue.signature),
      signatureParts: issue.signature,
      occurrenceCount: issue.occurrenceCount,
      sourceMemoryIds: issue.sourceMemoryIds,
      examples: issue.examples ?? [],
    })),
    null,
    2,
  );

  return [
    "Review these recurring operability findings and decide whether each is a genuine defect or expected behavior.",
    "For deliberate policy denials or intended restrictions, take no action.",
    "For a missing grant to an existing catalog tool, use agent_tool_grant.create or agent_tool_grant.update with source handled by the tool and a reason that names the operability signature.",
    "For implementation bugs, missing catalog tools, wrong argument handling, wrong default templates, or repeated DB rejections, create remediation plan/work-items for the coding agent.",
    "Before creating work, query for an existing open work item with the same operability_remediation.signature metadata. If one exists, do not create a duplicate; escalate or comment instead.",
    `Create at most ${maxNewWorkItems} new remediation work items in this run.`,
    "Every remediation work item must include metadata.operability_remediation.signature and metadata.operability_remediation.source_memory_ids.",
    "If agent_tool_grant.create or agent_tool_grant.update returns system_tool_grant_backoff, stop retrying that grant and escalate.",
    "",
    "Recurring findings:",
    issuesJson,
  ].join("\n");
}

function metadataSignature(metadata: unknown): string | null {
  const remediation = asRecord(asRecord(metadata).operability_remediation);
  const signature = remediation.signature;
  return typeof signature === "string" && signature.trim() ? signature.trim() : null;
}

export async function findOpenOperabilityWorkItems(input: {
  workspaceId: string;
  signature: OperabilityIssueSignature;
}) {
  const rows = await executeSupabaseRows<WorkItemLinkRow>(
    "operability work_items query",
    getServiceRoleSupabase()
      .from("work_items")
      .select("id,workspace_id,plan_id,title,state,metadata,updated_at")
      .eq("workspace_id", input.workspaceId)
      .order("updated_at", { ascending: false }),
  );
  const signature = operabilitySignatureKey(input.signature);
  return rows.filter(
    (row) => !TERMINAL_WORK_ITEM_STATES.has(row.state) && metadataSignature(row.metadata) === signature,
  );
}

function signatureFromMemory(memory: MemoryItemRow): OperabilityIssueSignature | null {
  const tags = asRecord(memory.tags);
  if (tags.kind !== "operability" || tags.failure !== "tool_call") return null;
  const toolSlug = typeof tags.tool_slug === "string" ? tags.tool_slug : "";
  const errorCode = typeof tags.error_code === "string" ? tags.error_code : "";
  const agentType = typeof tags.agent_type === "string" ? tags.agent_type : null;
  if (!toolSlug || !errorCode) return null;
  return { toolSlug, errorCode, agentType };
}

export async function listOperabilityRemediationView(input: {
  workspaceId: string;
  threshold?: number;
  limit?: number;
}) {
  const threshold = input.threshold ?? 2;
  const limit = input.limit ?? 20;
  const memories = await executeSupabaseRows<MemoryItemRow>(
    "operability memory_items query",
    getServiceRoleSupabase()
      .from("memory_items")
      .select("id,workspace_id,content,tags,event_time,created_at,is_deleted")
      .eq("workspace_id", input.workspaceId)
      .eq("is_deleted", false)
      .order("event_time", { ascending: false })
      .limit(500),
  );

  const grouped = new Map<
    string,
    { signature: OperabilityIssueSignature; sourceMemoryIds: string[]; examples: Array<Record<string, unknown>> }
  >();
  for (const memory of memories) {
    const signature = signatureFromMemory(memory);
    if (!signature) continue;
    const key = operabilitySignatureKey(signature);
    const group = grouped.get(key) ?? { signature, sourceMemoryIds: [], examples: [] };
    group.sourceMemoryIds.push(memory.id);
    if (group.examples.length < 3) {
      group.examples.push({
        memoryId: memory.id,
        content: memory.content,
        eventTime: memory.event_time ?? memory.created_at,
      });
    }
    grouped.set(key, group);
  }

  const recurringIssues = await Promise.all(
    Array.from(grouped.values())
      .filter((group) => group.sourceMemoryIds.length >= threshold)
      .sort((left, right) => right.sourceMemoryIds.length - left.sourceMemoryIds.length)
      .slice(0, limit)
      .map(async (group) => ({
        signature: operabilitySignatureKey(group.signature),
        signatureParts: group.signature,
        occurrenceCount: group.sourceMemoryIds.length,
        sourceMemoryIds: group.sourceMemoryIds,
        examples: group.examples,
        openWorkItems: await findOpenOperabilityWorkItems({
          workspaceId: input.workspaceId,
          signature: group.signature,
        }),
      })),
  );

  const recentAutonomousGrants = await executeSupabaseRows<AgentToolGrantViewRow>(
    "operability autonomous grants query",
    getServiceRoleSupabase()
      .from("agent_tool_grant")
      .select("id,agent_id,tool_id,workspace_id,mode,source,reason,created_at,updated_at")
      .eq("workspace_id", input.workspaceId)
      .eq("source", "system")
      .order("updated_at", { ascending: false })
      .limit(25),
  );

  return {
    threshold,
    recurringIssues,
    recentAutonomousGrants,
  };
}
