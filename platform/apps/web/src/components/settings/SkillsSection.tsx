import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { queryClient } from "../../api/query-client";
import { queryKeys } from "../../api/query-keys";
import {
  listSkills,
  updateSkill,
  type Skill,
  type SkillStatus,
  type SkillUpdateRequest,
} from "../../api/skills";
import { useAgentsQuery } from "../../hooks/useAgents";
import { useAuthStore } from "../../stores/auth";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { Input } from "../ui/Input";
import { PageHeader } from "../ui/PageHeader";
import { Select } from "../ui/Select";
import { Textarea } from "../ui/Textarea";

const statusOptions: Array<{ value: "all" | SkillStatus; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "approved", label: "Approved" },
  { value: "archived", label: "Archived" },
];

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function shortId(value: string | null) {
  return value ? value.slice(0, 8) : null;
}

function statusTone(status: SkillStatus) {
  if (status === "approved") return "success";
  if (status === "archived") return "default";
  return "warning";
}

function skillStatusPatch(status: SkillStatus): SkillUpdateRequest {
  return { status };
}

function SkillRow({
  skill,
  agentName,
  selected,
  onSelect,
}: {
  skill: Skill;
  agentName: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full border-b border-border/50 px-3 py-3 text-left transition-colors last:border-b-0 ${
        selected ? "bg-blue-600/15" : "hover:bg-surface-raised/60"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-medium text-slate-100">
          {skill.name}
        </span>
        <Badge variant={statusTone(skill.status)}>{skill.status}</Badge>
      </div>
      <p className="mt-1 line-clamp-2 text-sm text-slate-400">
        {skill.description}
      </p>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
        <span>{agentName}</span>
        <span>Updated {formatDate(skill.updatedAt)}</span>
        {skill.sourceRunId && (
          <span className="font-mono">Run {shortId(skill.sourceRunId)}</span>
        )}
      </div>
    </button>
  );
}

function SkillProvenance({
  skill,
  agentName,
}: {
  skill: Skill;
  agentName: string;
}) {
  const rows = [
    ["Owner", agentName],
    ["Source run", shortId(skill.sourceRunId) ?? "-"],
    ["Created by agent", shortId(skill.createdByAgentId) ?? "-"],
    ["Created by user", shortId(skill.createdByUserId) ?? "-"],
    ["Copied from", shortId(skill.copiedFromSkillId) ?? "-"],
    ["Created", formatDate(skill.createdAt)],
    ["Updated", formatDate(skill.updatedAt)],
  ];

  return (
    <dl className="grid gap-2 text-xs md:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="text-slate-500">{label}</dt>
          <dd className="mt-0.5 break-all font-mono text-slate-300">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SkillsSection() {
  const workspaceId = useAuthStore((state) => state.workspaceId);
  const agentsQuery = useAgentsQuery(workspaceId);
  const [agentFilter, setAgentFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | SkillStatus>(
    "draft",
  );
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const filters = useMemo(
    () => ({
      agentId: agentFilter === "all" ? undefined : agentFilter,
      status: statusFilter === "all" ? undefined : statusFilter,
      limit: 100,
    }),
    [agentFilter, statusFilter],
  );

  const skillsQuery = useQuery({
    queryKey: queryKeys.skills.list(workspaceId ?? "", filters),
    queryFn: async () => {
      if (!workspaceId) return [];
      const response = await listSkills(workspaceId, filters);
      return response.skills;
    },
    enabled: Boolean(workspaceId),
  });

  const agents = agentsQuery.data ?? [];
  const agentNames = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.name])),
    [agents],
  );
  const agentOptions = [
    { value: "all", label: "All agents" },
    ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
  ];

  const skills = skillsQuery.data ?? [];
  const selectedSkill =
    skills.find((skill) => skill.id === selectedSkillId) ?? skills[0] ?? null;
  const selectedAgentName = selectedSkill
    ? (agentNames.get(selectedSkill.agentId) ??
      shortId(selectedSkill.agentId) ??
      "Agent")
    : "Agent";

  useEffect(() => {
    if (!selectedSkill) {
      setSelectedSkillId(null);
      setName("");
      setDescription("");
      setBody("");
      return;
    }
    setSelectedSkillId(selectedSkill.id);
    setName(selectedSkill.name);
    setDescription(selectedSkill.description);
    setBody(selectedSkill.body);
    setMessage(null);
  }, [selectedSkill?.id]);

  const mutation = useMutation({
    mutationFn: async ({
      skill,
      patch,
    }: {
      skill: Skill;
      patch: SkillUpdateRequest;
    }) => {
      if (!workspaceId) throw new Error("No workspace selected");
      return updateSkill(workspaceId, skill.id, patch);
    },
    onSuccess: async (updatedSkill) => {
      setSelectedSkillId(updatedSkill.id);
      setMessage("Skill saved.");
      if (workspaceId) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.skills.lists(),
        });
      }
    },
  });

  const saveSelected = () => {
    if (!selectedSkill) return;
    mutation.mutate({
      skill: selectedSkill,
      patch: {
        name,
        description,
        body,
      },
    });
  };

  const setSelectedStatus = (status: SkillStatus) => {
    if (!selectedSkill) return;
    mutation.mutate({
      skill: selectedSkill,
      patch: skillStatusPatch(status),
    });
  };

  const error =
    skillsQuery.error instanceof Error
      ? skillsQuery.error.message
      : mutation.error instanceof Error
        ? mutation.error.message
        : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Skills"
        description="Review agent-authored skills before they are approved for future runs."
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void skillsQuery.refetch()}
            loading={skillsQuery.isFetching}
          >
            Refresh
          </Button>
        }
      />

      <div className="grid gap-3 md:grid-cols-[minmax(180px,1fr)_180px]">
        <Select
          label="Agent"
          value={agentFilter}
          onChange={(event) => setAgentFilter(event.target.value)}
          options={agentOptions}
        />
        <Select
          label="Status"
          value={statusFilter}
          onChange={(event) =>
            setStatusFilter(event.target.value as "all" | SkillStatus)
          }
          options={statusOptions}
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

      {message && !error && (
        <div className="rounded-md border border-emerald-600/30 bg-emerald-900/20 px-3 py-2 text-sm text-emerald-300">
          {message}
        </div>
      )}

      {workspaceId &&
        skills.length === 0 &&
        !skillsQuery.isLoading &&
        !error && (
          <EmptyState
            label="No skills match these filters."
            description="Draft skills appear here after agents propose reusable instructions."
            align="left"
          />
        )}

      {skills.length > 0 && (
        <div className="grid gap-4 xl:grid-cols-[minmax(320px,0.75fr)_minmax(520px,1.25fr)]">
          <Card padding="none" className="overflow-hidden">
            <div className="border-b border-border px-3 py-2 text-xs font-medium text-slate-400">
              {skills.length} skills
            </div>
            <div className="max-h-[720px] overflow-y-auto">
              {skills.map((skill) => (
                <SkillRow
                  key={skill.id}
                  skill={skill}
                  selected={skill.id === selectedSkill?.id}
                  agentName={
                    agentNames.get(skill.agentId) ??
                    shortId(skill.agentId) ??
                    "Agent"
                  }
                  onSelect={() => setSelectedSkillId(skill.id)}
                />
              ))}
            </div>
          </Card>

          {selectedSkill && (
            <Card className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold text-slate-100">
                      {selectedSkill.name}
                    </h3>
                    <Badge variant={statusTone(selectedSkill.status)}>
                      {selectedSkill.status}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-slate-400">
                    {selectedAgentName}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => setSelectedStatus("approved")}
                    disabled={selectedSkill.status === "approved"}
                    loading={mutation.isPending}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setSelectedStatus("draft")}
                    disabled={selectedSkill.status === "draft"}
                    loading={mutation.isPending}
                  >
                    Reopen
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setSelectedStatus("archived")}
                    disabled={selectedSkill.status === "archived"}
                    loading={mutation.isPending}
                  >
                    Archive
                  </Button>
                </div>
              </div>

              <SkillProvenance
                skill={selectedSkill}
                agentName={selectedAgentName}
              />

              <div className="grid gap-3">
                <Input
                  label="Name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="kebab-case-skill-name"
                />
                <Textarea
                  label="Description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={3}
                />
                <Textarea
                  label="SKILL.md body"
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  rows={18}
                  className="font-mono"
                />
              </div>

              <div className="flex justify-end">
                <Button onClick={saveSelected} loading={mutation.isPending}>
                  Save changes
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
