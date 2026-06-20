import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  listMemoryItems,
  type MemoryItem,
  type MemoryItemFilters,
  type MemoryScope,
} from "../../api/memory-items";
import { queryKeys } from "../../api/query-keys";
import { useAgentsQuery } from "../../hooks/useAgents";
import { useAuthStore } from "../../stores/auth";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { Input } from "../ui/Input";
import { PageHeader } from "../ui/PageHeader";
import { Select } from "../ui/Select";

const scopeOptions: Array<{ value: "all" | MemoryScope; label: string }> = [
  { value: "all", label: "All scopes" },
  { value: "long_term", label: "Long term" },
  { value: "daily", label: "Daily" },
  { value: "project", label: "Project" },
  { value: "run_summary", label: "Run summary" },
  { value: "scratch", label: "Scratch" },
];

const importanceOptions = Array.from({ length: 10 }, (_, index) => {
  const value = String(index + 1);
  return { value, label: `${value}+` };
});

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatTags(tags: unknown) {
  if (Array.isArray(tags)) {
    return tags
      .filter(
        (tag): tag is string =>
          typeof tag === "string" && tag.trim().length > 0,
      )
      .slice(0, 4);
  }
  if (tags && typeof tags === "object") {
    return Object.entries(tags)
      .filter(([, value]) => value === true)
      .map(([key]) => key)
      .slice(0, 4);
  }
  return [];
}

function shortId(value: string | null) {
  return value ? value.slice(0, 8) : null;
}

function MemoryRow({
  item,
  agentName,
}: {
  item: MemoryItem;
  agentName: string;
}) {
  const tags = formatTags(item.tags);
  return (
    <tr className="border-b border-border/50 align-top hover:bg-surface-raised/50">
      <td className="px-3 py-3">
        <div className="max-w-[520px] whitespace-pre-wrap text-sm text-slate-200">
          {item.content}
        </div>
        {tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </div>
        )}
      </td>
      <td className="px-3 py-3 text-sm text-slate-400">{agentName}</td>
      <td className="px-3 py-3">
        <Badge>{item.scope}</Badge>
      </td>
      <td className="px-3 py-3 text-sm text-slate-300">{item.importance}</td>
      <td className="px-3 py-3 text-xs font-mono text-slate-500">
        {shortId(item.sourceRunId) ?? "-"}
      </td>
      <td className="px-3 py-3 text-xs text-slate-500">
        {formatDate(item.eventTime)}
      </td>
    </tr>
  );
}

export function MemorySection() {
  const workspaceId = useAuthStore((state) => state.workspaceId);
  const agentsQuery = useAgentsQuery(workspaceId);
  const [agentFilter, setAgentFilter] = useState("all");
  const [scope, setScope] = useState<"all" | MemoryScope>("all");
  const [importanceMin, setImportanceMin] = useState("1");
  const [sourceRunId, setSourceRunId] = useState("");

  const filters = useMemo<MemoryItemFilters>(() => {
    const trimmedSourceRunId = sourceRunId.trim();
    return {
      agentId:
        agentFilter === "all"
          ? undefined
          : agentFilter === "workspace"
            ? null
            : agentFilter,
      scope: scope === "all" ? undefined : scope,
      importanceMin: Number(importanceMin),
      sourceRunId: trimmedSourceRunId || undefined,
      limit: 100,
    };
  }, [agentFilter, importanceMin, scope, sourceRunId]);

  const memoryQuery = useQuery({
    queryKey: queryKeys.memoryItems.list(workspaceId ?? "", filters),
    queryFn: async () => {
      if (!workspaceId) return [];
      const response = await listMemoryItems(workspaceId, filters);
      return response.memoryItems;
    },
    enabled: Boolean(workspaceId),
  });

  const agents = agentsQuery.data ?? [];
  const agentNames = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.name])),
    [agents],
  );
  const agentOptions = [
    { value: "all", label: "All memories" },
    { value: "workspace", label: "Workspace only" },
    ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
  ];
  const items = memoryQuery.data ?? [];
  const error =
    memoryQuery.error instanceof Error ? memoryQuery.error.message : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Memory"
        description="Read-only inspector for workspace and agent memories."
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void memoryQuery.refetch()}
            loading={memoryQuery.isFetching}
          >
            Refresh
          </Button>
        }
      />

      <div className="grid gap-3 md:grid-cols-[minmax(180px,1fr)_minmax(160px,0.7fr)_120px_minmax(180px,1fr)]">
        <Select
          label="Agent"
          value={agentFilter}
          onChange={(event) => setAgentFilter(event.target.value)}
          options={agentOptions}
        />
        <Select
          label="Scope"
          value={scope}
          onChange={(event) =>
            setScope(event.target.value as "all" | MemoryScope)
          }
          options={scopeOptions}
        />
        <Select
          label="Importance"
          value={importanceMin}
          onChange={(event) => setImportanceMin(event.target.value)}
          options={importanceOptions}
        />
        <Input
          label="Source run"
          value={sourceRunId}
          onChange={(event) => setSourceRunId(event.target.value)}
          placeholder="Run id"
        />
      </div>

      {!workspaceId && (
        <EmptyState
          label="No workspace selected."
          align="left"
          density="compact"
        />
      )}

      {error && (
        <div className="rounded-md border border-red-600/30 bg-red-900/20 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {workspaceId &&
        items.length === 0 &&
        !memoryQuery.isLoading &&
        !error && (
          <EmptyState
            label="No memories match these filters."
            description="Memory rows appear here after agents save durable facts for this workspace."
            align="left"
          />
        )}

      {items.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[920px] text-left">
            <thead>
              <tr className="border-b border-border bg-surface-raised">
                <th className="px-3 py-2 text-xs font-medium text-slate-400">
                  Memory
                </th>
                <th className="px-3 py-2 text-xs font-medium text-slate-400">
                  Owner
                </th>
                <th className="px-3 py-2 text-xs font-medium text-slate-400">
                  Scope
                </th>
                <th className="px-3 py-2 text-xs font-medium text-slate-400">
                  Importance
                </th>
                <th className="px-3 py-2 text-xs font-medium text-slate-400">
                  Source run
                </th>
                <th className="px-3 py-2 text-xs font-medium text-slate-400">
                  Event time
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <MemoryRow
                  key={item.id}
                  item={item}
                  agentName={
                    item.agentId
                      ? (agentNames.get(item.agentId) ??
                        shortId(item.agentId) ??
                        "Agent")
                      : "Workspace"
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
