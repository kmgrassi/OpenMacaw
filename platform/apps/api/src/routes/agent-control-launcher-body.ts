import { resolveApprovedSkillsSnapshot } from "../repositories/skills.js";
import { attachRuntimeDispatchContext, buildRuntimeDispatchContext } from "../services/runtime-dispatch-context.js";

export async function buildLauncherStartBody(input: {
  accessToken: string;
  requesterUserId: string;
  agentId: string;
  workspaceId: string;
  requestBody: unknown;
}) {
  const dispatchContext = await buildRuntimeDispatchContext({
    accessToken: input.accessToken,
    requesterUserId: input.requesterUserId,
    agentId: input.agentId,
    requestBody: input.requestBody,
  });
  const attached = attachRuntimeDispatchContext(input.requestBody ?? {}, dispatchContext);
  const body = attached && typeof attached === "object" && !Array.isArray(attached) ? attached : {};
  const skillsSnapshot = await resolveApprovedSkillsSnapshot({
    agentId: input.agentId,
    workspaceId: input.workspaceId,
  });

  return {
    ...body,
    skills_snapshot: skillsSnapshot,
  };
}
