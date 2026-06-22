import type {
  LocalRuntimeRegistrationRequest,
  LocalRuntimeRunnerInput,
} from "../../../../../contracts/local-runtime.js";
import { toLocalRuntimeConfigResponse } from "./mappers.js";
import { buildRunnerSnippets, runnerSnippetFromDetails } from "./registration.js";
import type { LocalRuntimeRunnerDetails } from "./routing-metadata.js";

const DEFAULT_LOCAL_RELAY_WS_URL = "ws://127.0.0.1:4000";

type BaseConfigInput = {
  workspaceId: string;
  machineId: string;
  displayName: string;
  workspaceRoot: string | null;
  token: string;
};

export function localRelayRuntimeEndpoint() {
  return process.env.LOCAL_RELAY_WS_URL ?? DEFAULT_LOCAL_RELAY_WS_URL;
}

export function sharedWorkspaceRootFromRegistration(runners: LocalRuntimeRegistrationRequest["runners"]) {
  return (
    runners
      .find(
        (runner): runner is Extract<LocalRuntimeRunnerInput, { kind: "openai_compatible" }> =>
          runner.kind === "openai_compatible" && Boolean(runner.workspaceRoot?.trim()),
      )
      ?.workspaceRoot?.trim() ?? null
  );
}

export function buildRegistrationConfig(
  input: BaseConfigInput & { runners: LocalRuntimeRegistrationRequest["runners"] },
) {
  return {
    machineId: input.machineId,
    displayName: input.displayName,
    workspaceRoot: input.workspaceRoot,
    runtimeEndpoint: localRelayRuntimeEndpoint(),
    workspaceId: input.workspaceId,
    token: input.token,
    runners: buildRunnerSnippets(input.runners),
  };
}

export function buildLocalRuntimeConfigResponse(input: {
  workspaceId: string;
  machineId: string;
  machineDisplayName: string;
  workspaceRoot: string | null;
  token: string | null;
  tokenAvailable: boolean;
  runners: LocalRuntimeRunnerDetails[];
}) {
  return toLocalRuntimeConfigResponse({
    id: input.machineId,
    token: input.token,
    tokenAvailable: input.tokenAvailable,
    config: {
      machineId: input.machineId,
      displayName: input.machineDisplayName,
      workspaceRoot: input.workspaceRoot,
      runtimeEndpoint: localRelayRuntimeEndpoint(),
      workspaceId: input.workspaceId,
      token: input.token ?? "<rotate-token-to-generate-a-new-value>",
      runners: input.runners.map((runner) => runnerSnippetFromDetails(runner)),
    },
  });
}
