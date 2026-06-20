import {
  SkillListResponseSchema,
  SkillResponseSchema,
  type Skill,
  type SkillStatus,
  type SkillUpdateRequest,
} from "../../../../contracts/skills";
import { apiFetch } from "./client";
import { ROUTES } from "./routes";

export type { Skill, SkillStatus, SkillUpdateRequest };

export type SkillFilters = {
  agentId?: string;
  status?: SkillStatus;
  limit?: number;
};

export function listSkills(
  workspaceId: string,
  filters: SkillFilters,
): Promise<{ skills: Skill[] }> {
  return apiFetch(ROUTES.workspaceSkills(workspaceId, filters), {
    schema: SkillListResponseSchema,
    defaultErrorMessage: "Could not load skills.",
  });
}

export async function updateSkill(
  workspaceId: string,
  skillId: string,
  patch: SkillUpdateRequest,
): Promise<Skill> {
  const response = await apiFetch(ROUTES.workspaceSkill(workspaceId, skillId), {
    method: "PATCH",
    body: patch,
    schema: SkillResponseSchema,
    defaultErrorMessage: "Could not update skill.",
  });
  return response.skill;
}
