import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockSupabaseClient } from "../test-utils/supabase-client-mock.js";
import { ensureDefaultAgentToolsForAgent } from "./default-agent-tools.js";
import {
  DEFAULT_MANAGER_TOOL_SLUGS,
  GIT_COMMAND_TOOL_SLUG,
  SCHEDULED_TASK_TOOL_SLUGS,
  SKILL_TOOL_SLUGS,
} from "./tool-bundles.js";

const agentId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const userId = "11111111-1111-4111-8111-111111111111";

function tool(slug: string, id = slug) {
  return {
    id,
    workspace_id: null,
    slug,
    enabled: true,
  };
}

function template(slug: string, id = `template-${slug}`) {
  return {
    id,
    workspace_id: null,
    slug,
    enabled: true,
  };
}

function templateTool(templateSlug: string, toolId: string) {
  return {
    template_id: `template-${templateSlug}`,
    tool_id: toolId,
  };
}

const scheduledToolIds = SCHEDULED_TASK_TOOL_SLUGS.map((slug) => `tool-${slug.replaceAll(".", "-")}`);
const skillToolIds = SKILL_TOOL_SLUGS.map((slug) => `tool-${slug.replaceAll(".", "-")}`);
const sortedScheduledToolSlugs = [...SCHEDULED_TASK_TOOL_SLUGS].sort();
const sortedScheduledToolIds = [...scheduledToolIds].sort();
const sortedManagerToolSlugs = [...DEFAULT_MANAGER_TOOL_SLUGS].sort();

function scheduledTemplateTools(templateSlug: string) {
  return scheduledToolIds.map((toolId) => templateTool(templateSlug, toolId));
}

function skillTemplateTools(templateSlug: string) {
  return skillToolIds.map((toolId) => templateTool(templateSlug, toolId));
}

describe("default agent tools", () => {
  let tables: Record<string, Array<Record<string, unknown>>>;

  beforeEach(() => {
    vi.restoreAllMocks();
    tables = {
      tool: [
        tool("repo.read_file", "tool-read"),
        tool("repo.list", "tool-list"),
        tool("repo.search", "tool-search"),
        tool("repo.read_symbols", "tool-symbols"),
        tool("plan.create", "tool-plan-create"),
        tool("task.create", "tool-task-create"),
        tool("task.update", "tool-task-update"),
        tool("plans.read", "tool-plans-read"),
        tool("plan.read", "tool-plan-read"),
        tool("plan.delete", "tool-plan-delete"),
        tool("task.read", "tool-task-read"),
        tool(GIT_COMMAND_TOOL_SLUG, "tool-git-run"),
        tool("shell.exec", "tool-shell-exec"),
        tool("apply_patch", "tool-apply-patch"),
        ...SCHEDULED_TASK_TOOL_SLUGS.map((slug, index) => tool(slug, scheduledToolIds[index])),
        ...SKILL_TOOL_SLUGS.map((slug, index) => tool(slug, skillToolIds[index])),
      ],
      tool_policy_template: [
        template("planner"),
        template("manager"),
        template("coding"),
        template("local_model_coding"),
      ],
      tool_policy_template_tool: [
        templateTool("planner", "tool-plan-create"),
        templateTool("planner", "tool-task-create"),
        templateTool("planner", "tool-task-update"),
        templateTool("planner", "tool-plans-read"),
        templateTool("planner", "tool-plan-read"),
        templateTool("planner", "tool-plan-delete"),
        templateTool("planner", "tool-task-read"),
        ...scheduledTemplateTools("planner"),
        ...skillTemplateTools("planner"),
        templateTool("manager", "tool-git-run"),
        templateTool("manager", "tool-task-read"),
        ...scheduledTemplateTools("manager"),
        ...skillTemplateTools("manager"),
        templateTool("coding", "tool-read"),
        templateTool("coding", "tool-list"),
        templateTool("coding", "tool-search"),
        templateTool("coding", "tool-symbols"),
        templateTool("coding", "tool-plan-create"),
        templateTool("coding", "tool-task-create"),
        templateTool("coding", "tool-task-update"),
        templateTool("coding", "tool-plans-read"),
        templateTool("coding", "tool-plan-read"),
        templateTool("coding", "tool-plan-delete"),
        templateTool("coding", "tool-task-read"),
        ...scheduledTemplateTools("coding"),
        ...skillTemplateTools("coding"),
        templateTool("local_model_coding", "tool-read"),
        templateTool("local_model_coding", "tool-list"),
        templateTool("local_model_coding", "tool-search"),
        templateTool("local_model_coding", "tool-git-run"),
        templateTool("local_model_coding", "tool-shell-exec"),
        templateTool("local_model_coding", "tool-apply-patch"),
        ...scheduledTemplateTools("local_model_coding"),
        ...skillTemplateTools("local_model_coding"),
      ],
      agent_tool: [{ id: "legacy-existing", agent_id: agentId, tool_id: "tool-read" }],
      agent_tool_grant: [
        {
          id: "existing",
          agent_id: agentId,
          workspace_id: workspaceId,
          tool_id: "tool-read",
          mode: "include",
          source: "template",
          source_tool_template_id: "template-coding",
          reason: "applied default coding tool policy template",
          created_by_user_id: userId,
        },
      ],
    };
  });

  it("creates missing coding default grants from the coding template without duplicating existing grants", async () => {
    const result = await ensureDefaultAgentToolsForAgent({
      agentId,
      workspaceId,
      agentType: "coding",
      userId,
      supabase: createMockSupabaseClient(tables) as never,
    });

    expect(result.changed).toBe(true);
    expect(result.assignedToolSlugs).toEqual([
      "plan.create",
      "plan.delete",
      "plan.read",
      "plans.read",
      "repo.list",
      "repo.read_symbols",
      "repo.search",
      ...sortedScheduledToolSlugs,
      ...SKILL_TOOL_SLUGS,
      "task.create",
      "task.read",
      "task.update",
    ]);
    expect(
      (tables.agent_tool_grant ?? [])
        .map((row) => ({
          agent_id: row.agent_id,
          tool_id: row.tool_id,
          workspace_id: row.workspace_id,
          mode: row.mode,
          source: row.source,
          source_tool_template_id: row.source_tool_template_id,
          created_by_user_id: row.created_by_user_id ?? null,
        }))
        .sort((left, right) => String(left.tool_id).localeCompare(String(right.tool_id))),
    ).toEqual([
      grantExpectation("tool-list", "template-coding"),
      grantExpectation("tool-plan-create", "template-coding"),
      grantExpectation("tool-plan-delete", "template-coding"),
      grantExpectation("tool-plan-read", "template-coding"),
      grantExpectation("tool-plans-read", "template-coding"),
      grantExpectation("tool-read", "template-coding"),
      ...sortedScheduledToolIds.map((toolId) => grantExpectation(toolId, "template-coding")),
      grantExpectation("tool-search", "template-coding"),
      grantExpectation("tool-skill-create", "template-coding"),
      grantExpectation("tool-symbols", "template-coding"),
      grantExpectation("tool-task-create", "template-coding"),
      grantExpectation("tool-task-read", "template-coding"),
      grantExpectation("tool-task-update", "template-coding"),
    ]);
    expect(tables.agent_tool_grant).toHaveLength(17);
    expect(tables.agent_tool).toEqual([{ id: "legacy-existing", agent_id: agentId, tool_id: "tool-read" }]);
  });

  it("does not overwrite an existing exclude grant when assigning defaults", async () => {
    tables.agent_tool_grant = [
      {
        id: "excluded-search",
        agent_id: agentId,
        workspace_id: workspaceId,
        tool_id: "tool-search",
        mode: "exclude",
        source: "manual",
        source_tool_template_id: null,
        reason: "Disabled by user",
        created_by_user_id: userId,
      },
    ];

    const result = await ensureDefaultAgentToolsForAgent({
      agentId,
      workspaceId,
      agentType: "coding",
      userId,
      supabase: createMockSupabaseClient(tables) as never,
    });

    expect(result.assignedToolSlugs).not.toContain("repo.search");
    expect(tables.agent_tool_grant).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool_id: "tool-search",
          mode: "exclude",
          source: "manual",
          reason: "Disabled by user",
        }),
      ]),
    );
  });

  it("assigns runtime-owned coding tools to local model coding agents", async () => {
    tables.agent_tool_grant = [];

    const result = await ensureDefaultAgentToolsForAgent({
      agentId,
      workspaceId,
      agentType: "coding",
      runnerKind: "local_model_coding",
      userId,
      supabase: createMockSupabaseClient(tables) as never,
    });

    expect(result.assignedToolSlugs).toEqual([
      "apply_patch",
      GIT_COMMAND_TOOL_SLUG,
      "repo.list",
      "repo.read_file",
      "repo.search",
      ...sortedScheduledToolSlugs,
      "shell.exec",
      ...SKILL_TOOL_SLUGS,
    ]);
    expect(tables.agent_tool_grant).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool_id: "tool-read", source_tool_template_id: "template-local_model_coding" }),
        expect.objectContaining({ tool_id: "tool-list", source_tool_template_id: "template-local_model_coding" }),
        expect.objectContaining({ tool_id: "tool-search", source_tool_template_id: "template-local_model_coding" }),
        expect.objectContaining({ tool_id: "tool-git-run", source_tool_template_id: "template-local_model_coding" }),
        expect.objectContaining({ tool_id: "tool-shell-exec", source_tool_template_id: "template-local_model_coding" }),
        expect.objectContaining({
          tool_id: "tool-apply-patch",
          source_tool_template_id: "template-local_model_coding",
        }),
        ...scheduledToolIds.map((toolId) =>
          expect.objectContaining({ tool_id: toolId, source_tool_template_id: "template-local_model_coding" }),
        ),
        ...skillToolIds.map((toolId) =>
          expect.objectContaining({ tool_id: toolId, source_tool_template_id: "template-local_model_coding" }),
        ),
      ]),
    );
    expect(tables.agent_tool_grant).toHaveLength(12);
  });

  it("assigns repo-read and planner database tools for planning agents", async () => {
    tables.agent_tool_grant = [];

    const result = await ensureDefaultAgentToolsForAgent({
      agentId,
      workspaceId,
      agentType: "planning",
      userId,
      supabase: createMockSupabaseClient(tables) as never,
    });

    expect(result.assignedToolSlugs).toEqual([
      "plan.create",
      "plan.delete",
      "plan.read",
      "plans.read",
      "repo.list",
      "repo.read_file",
      "repo.read_symbols",
      "repo.search",
      ...sortedScheduledToolSlugs,
      ...SKILL_TOOL_SLUGS,
      "task.create",
      "task.read",
      "task.update",
    ]);
    expect(tables.agent_tool_grant.map((row) => row.tool_id).sort()).toEqual([
      "tool-list",
      "tool-plan-create",
      "tool-plan-delete",
      "tool-plan-read",
      "tool-plans-read",
      "tool-read",
      ...sortedScheduledToolIds,
      "tool-search",
      "tool-skill-create",
      "tool-symbols",
      "tool-task-create",
      "tool-task-read",
      "tool-task-update",
    ]);
    expect(tables.agent_tool_grant.map((row) => row.tool_id)).not.toContain("tool-shell-exec");
    expect(tables.agent_tool_grant.map((row) => row.tool_id)).not.toContain("tool-apply-patch");
  });

  it("assigns canonical planning tools when the planner template row is missing", async () => {
    tables.agent_tool_grant = [];
    tables.tool_policy_template = (tables.tool_policy_template ?? []).filter((row) => row.slug !== "planner");

    const result = await ensureDefaultAgentToolsForAgent({
      agentId,
      workspaceId,
      agentType: "planning",
      userId,
      supabase: createMockSupabaseClient(tables) as never,
    });

    expect(result.assignedToolSlugs).toEqual([
      "plan.create",
      "plan.delete",
      "plan.read",
      "plans.read",
      "repo.list",
      "repo.read_file",
      "repo.read_symbols",
      "repo.search",
      ...sortedScheduledToolSlugs,
      ...SKILL_TOOL_SLUGS,
      "task.create",
      "task.read",
      "task.update",
    ]);
    expect(tables.agent_tool_grant).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool_id: "tool-read", source_tool_template_id: null }),
        expect.objectContaining({ tool_id: "tool-list", source_tool_template_id: null }),
        expect.objectContaining({ tool_id: "tool-search", source_tool_template_id: null }),
        expect.objectContaining({ tool_id: "tool-symbols", source_tool_template_id: null }),
      ]),
    );
    expect(tables.agent_tool_grant).toHaveLength(17);
  });

  it("assigns canonical planning tools when the planner template row is disabled", async () => {
    tables.agent_tool_grant = [];
    tables.tool_policy_template = (tables.tool_policy_template ?? []).map((row) =>
      row.slug === "planner" ? { ...row, enabled: false } : row,
    );

    const result = await ensureDefaultAgentToolsForAgent({
      agentId,
      workspaceId,
      agentType: "planning",
      userId,
      supabase: createMockSupabaseClient(tables) as never,
    });

    expect(result.changed).toBe(true);
    expect(tables.agent_tool_grant.map((row) => row.tool_id).sort()).toEqual([
      "tool-list",
      "tool-plan-create",
      "tool-plan-delete",
      "tool-plan-read",
      "tool-plans-read",
      "tool-read",
      ...sortedScheduledToolIds,
      "tool-search",
      "tool-skill-create",
      "tool-symbols",
      "tool-task-create",
      "tool-task-read",
      "tool-task-update",
    ]);
    expect(tables.agent_tool_grant).toEqual(
      expect.arrayContaining([expect.objectContaining({ source_tool_template_id: null })]),
    );
  });

  it("uses the resolved tool profile instead of re-deriving from agent type", async () => {
    tables.agent_tool_grant = [];

    const result = await ensureDefaultAgentToolsForAgent({
      agentId,
      workspaceId,
      toolProfile: "planning",
      agentType: "coding",
      userId,
      supabase: createMockSupabaseClient(tables) as never,
    });

    expect(result.assignedToolSlugs).toEqual([
      "plan.create",
      "plan.delete",
      "plan.read",
      "plans.read",
      "repo.list",
      "repo.read_file",
      "repo.read_symbols",
      "repo.search",
      ...sortedScheduledToolSlugs,
      ...SKILL_TOOL_SLUGS,
      "task.create",
      "task.read",
      "task.update",
    ]);
    expect(tables.agent_tool_grant.map((row) => row.tool_id)).toContain("tool-read");
    expect(tables.agent_tool_grant.map((row) => row.tool_id)).toContain("tool-search");
    expect(tables.agent_tool_grant.map((row) => row.tool_id)).toContain("tool-symbols");
  });

  it("assigns manager grants from the manager template", async () => {
    tables.agent_tool_grant = [];

    const result = await ensureDefaultAgentToolsForAgent({
      agentId,
      workspaceId,
      agentType: "manager",
      userId,
      supabase: createMockSupabaseClient(tables) as never,
    });

    expect(result).toEqual({
      changed: true,
      assignedToolSlugs: sortedManagerToolSlugs,
      missingToolSlugs: [],
    });
    expect(tables.agent_tool_grant).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent_id: agentId,
          tool_id: "tool-git-run",
          workspace_id: workspaceId,
          mode: "include",
          source: "template",
          source_tool_template_id: "template-manager",
          created_by_user_id: userId,
        }),
        expect.objectContaining({
          agent_id: agentId,
          tool_id: "tool-task-read",
          workspace_id: workspaceId,
          mode: "include",
          source: "template",
          source_tool_template_id: "template-manager",
          created_by_user_id: userId,
        }),
        ...scheduledToolIds.map((toolId) =>
          expect.objectContaining({
            agent_id: agentId,
            tool_id: toolId,
            workspace_id: workspaceId,
            mode: "include",
            source: "template",
            source_tool_template_id: "template-manager",
            created_by_user_id: userId,
          }),
        ),
        expect.objectContaining({
          agent_id: agentId,
          tool_id: "tool-read",
          workspace_id: workspaceId,
          mode: "include",
          created_by_user_id: userId,
        }),
        expect.objectContaining({
          agent_id: agentId,
          tool_id: "tool-symbols",
          workspace_id: workspaceId,
          mode: "include",
          created_by_user_id: userId,
        }),
        expect.objectContaining({
          agent_id: agentId,
          tool_id: "tool-plan-create",
          workspace_id: workspaceId,
          mode: "include",
          created_by_user_id: userId,
        }),
      ]),
    );
  });

  it("does not overwrite an existing manual exclude grant", async () => {
    tables.agent_tool_grant = [
      {
        agent_id: agentId,
        workspace_id: workspaceId,
        tool_id: "tool-task-read",
        mode: "exclude",
        source: "manual",
        source_tool_template_id: null,
        created_by_user_id: userId,
      },
    ];

    const result = await ensureDefaultAgentToolsForAgent({
      agentId,
      workspaceId,
      agentType: "manager",
      userId,
      supabase: createMockSupabaseClient(tables) as never,
    });

    expect(result).toEqual({
      changed: true,
      assignedToolSlugs: sortedManagerToolSlugs.filter((slug) => slug !== "task.read"),
      missingToolSlugs: [],
    });
    expect(tables.agent_tool_grant).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool_id: "tool-git-run",
          mode: "include",
          source_tool_template_id: "template-manager",
        }),
        expect.objectContaining({
          tool_id: "tool-task-read",
          mode: "exclude",
          source: "manual",
          source_tool_template_id: null,
        }),
        ...scheduledToolIds.map((toolId) =>
          expect.objectContaining({
            tool_id: toolId,
            mode: "include",
            source_tool_template_id: "template-manager",
          }),
        ),
      ]),
    );
  });
});

function grantExpectation(toolId: string, templateId: string) {
  return {
    agent_id: agentId,
    tool_id: toolId,
    workspace_id: workspaceId,
    mode: "include",
    source: "template",
    source_tool_template_id: templateId,
    created_by_user_id: userId,
  };
}
