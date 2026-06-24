import type { SetupRequest } from "../../../../../../contracts/setup.js";
import { ApiRouteError } from "../../../http.js";
import { createSetupAgent } from "../../../repositories/agents.js";
import { createAgentCredential } from "../../../repositories/credentials.js";
import { resolveExecutionProfile } from "../../execution-profile-resolver.js";
import { syncCredentialIntoRoutingRuleForAgent } from "../../stored-agent-routing.js";
import type { LauncherClient } from "../../launcher.js";
import {
  agentType,
  buildCredentialJson,
  buildExecutionProfileBlock,
  buildGatewayConfig,
  buildModelSettings,
  buildToolPolicy,
  hashConfig,
} from "../builders.js";
import { createGatewayConfig, createGatewayConfigVersion } from "../gateway-config.js";
import { requireCurrentUser } from "../identity.js";
import { ensureLauncherStarted, type LauncherRequest, waitForEngineRunning } from "../launcher-orchestration.js";
import { assembleSetup } from "./assemble.js";

export async function createSetupImpl(
  accessToken: string,
  verifiedUserId: string,
  input: SetupRequest,
  launcherClient: LauncherClient,
  launcherRequest?: LauncherRequest,
) {
  const userId = requireCurrentUser(verifiedUserId);
  const type = agentType(input);

  const agent = await createSetupAgent({
    accessToken,
    workspaceId: input.workspaceId,
    userId,
    name: input.agentName,
    type,
    modelSettings: buildModelSettings(input.model),
    toolPolicy: buildToolPolicy(input, type),
    status: "active",
  });

  if (!agent) {
    throw new ApiRouteError(502, "agent_create_failed", "Agent creation returned no row");
  }

  // Track the most recently saved credential per provider so we can wire the
  // routing rule below. The setup flow accepts multiple credentials but
  // historically only one model-provider credential per agent ends up
  // referenced by the routing rule.
  const savedCredentials: { credentialId: string; provider: string }[] = [];
  for (const credential of input.credentials) {
    const credentialKey = buildCredentialJson(credential);
    const saved = await createAgentCredential({
      agentId: agent.id,
      workspaceId: input.workspaceId,
      userId,
      credentialKey,
      accessToken,
    });
    if (saved?.id) {
      savedCredentials.push({ credentialId: saved.id, provider: credentialKey.provider });
    }
  }

  // Wire each just-created credential into the agent's routing rule before
  // resolving the execution profile. Without this step the routing rule does
  // not yet reference the credential, so `resolveExecutionProfile` falls
  // through to a null profile and the inserted gateway_config omits
  // `execution_profile` — leaving the runtime on the legacy fallback path
  // until the next rewrite. Codex flagged this on the first round of #550.
  //
  // The sync is best-effort: if it fails (transient Supabase error, etc.)
  // we still want the agent + credential + gateway_config to be created.
  // The resolver below will return null in that case and the runtime falls
  // back to the legacy path — same behaviour as before this PR, just
  // without the upgrade. Matches the resilience pattern around
  // ensureGatewayConfigExists in stored-agent-credentials.ts.
  for (const saved of savedCredentials) {
    try {
      await syncCredentialIntoRoutingRuleForAgent({
        agent: {
          id: agent.id,
          workspaceId: input.workspaceId,
          agentType: type,
          model: input.model ?? null,
          provider: saved.provider,
        },
        credentialId: saved.credentialId,
        provider: saved.provider,
      });
    } catch (syncError) {
      console.error("[setup-create] Failed to sync credential into routing rule:", syncError);
    }
  }

  // Resolve the execution profile after the agent + credentials + routing
  // rules exist so the gateway_config row carries
  // `execution_profile.credential_id` for the runtime. Without the routing
  // rule wired in above, this resolver returns null and the runtime falls
  // back to the legacy gateway-config-runner path (see explicit_profile/1
  // in execution_profile.ex).
  const initialResolution = await resolveExecutionProfile({
    agentId: agent.id,
    accessToken,
    skipCredentialCheck: true,
  }).catch(() => null);
  const gatewayConfigJson = buildGatewayConfig(input, type, undefined, buildExecutionProfileBlock(initialResolution));
  const gatewayConfigHash = hashConfig(gatewayConfigJson);

  const gatewayConfig = await createGatewayConfig({
    accessToken,
    agentId: agent.id,
    userId,
    configHash: gatewayConfigHash,
    configJson: gatewayConfigJson,
  });

  if (!gatewayConfig) {
    throw new ApiRouteError(502, "gateway_config_create_failed", "Gateway config creation returned no row");
  }

  await createGatewayConfigVersion({
    accessToken,
    gatewayConfigId: gatewayConfig.id,
    version: gatewayConfig.version,
    configHash: gatewayConfig.config_hash,
    configJson: gatewayConfig.config_json,
    userId,
    changeSummary: { created: true },
  });

  await ensureLauncherStarted(launcherClient, agent, accessToken);
  await waitForEngineRunning(accessToken, agent.id, launcherRequest);
  return assembleSetup(accessToken, userId, agent.id, launcherRequest);
}
