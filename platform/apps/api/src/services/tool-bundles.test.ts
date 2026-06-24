import { describe, expect, it } from "vitest";

import {
  AGENT_TOOL_GRANT_TOOL_SLUGS,
  GIT_COMMAND_TOOL_SLUG,
  DEFAULT_CODING_TOOL_SLUGS,
  DEFAULT_MANAGER_TOOL_SLUGS,
  SCHEDULED_TASK_TOOL_SLUGS,
  SKILL_TOOL_SLUGS,
  toolProfileForAgentType,
  toolSlugsForToolProfile,
} from "./tool-bundles.js";

describe("tool bundles", () => {
  it("maps agent types to tool profiles", () => {
    expect(toolProfileForAgentType("planning")).toBe("planning");
    expect(toolProfileForAgentType("coding")).toBe("coding");
    expect(toolProfileForAgentType("manager")).toBe("manager");
    expect(toolProfileForAgentType("custom")).toBe("none");
    expect(toolProfileForAgentType(null)).toBe("none");
  });

  it("expands planning tools from the canonical bundle", () => {
    expect(toolSlugsForToolProfile({ toolProfile: "planning" })).toEqual([
      "plan.create",
      "task.create",
      "task.update",
      "plans.read",
      "plan.read",
      "plan.delete",
      "task.read",
      ...SCHEDULED_TASK_TOOL_SLUGS,
      ...SKILL_TOOL_SLUGS,
      ...AGENT_TOOL_GRANT_TOOL_SLUGS,
    ]);
  });

  it("grants manager agents every default coding tool plus git.run", () => {
    expect(toolSlugsForToolProfile({ toolProfile: "coding" })).toEqual(DEFAULT_CODING_TOOL_SLUGS);
    expect(toolSlugsForToolProfile({ toolProfile: "manager" })).toEqual(DEFAULT_MANAGER_TOOL_SLUGS);
    expect(toolSlugsForToolProfile({ toolProfile: "manager" })).toEqual([
      GIT_COMMAND_TOOL_SLUG,
      ...DEFAULT_CODING_TOOL_SLUGS,
    ]);
  });

  it("uses the local model coding override for coding agents", () => {
    expect(
      toolSlugsForToolProfile({
        toolProfile: "coding",
        runnerKind: "local_model_coding",
      }),
    ).toEqual([
      GIT_COMMAND_TOOL_SLUG,
      "shell.exec",
      "apply_patch",
      ...SCHEDULED_TASK_TOOL_SLUGS,
      ...SKILL_TOOL_SLUGS,
    ]);
  });
});
