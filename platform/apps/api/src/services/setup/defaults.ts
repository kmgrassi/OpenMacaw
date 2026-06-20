import type { DefaultAgentRole } from "../../../../../contracts/setup.js";
import { DEFAULT_RUNNER_KIND_BY_AGENT_TYPE } from "../../../../../contracts/agent-runner-defaults.js";
import type { RunnerKind } from "../../../../../contracts/runner-kinds.js";
import type { CredentialProvider } from "../../../../../contracts/credentials.js";
import type { AgentType } from "../../../../../contracts/agents.js";

export const DEFAULT_AGENT_ROLES = ["planning", "coding"] as const satisfies readonly DefaultAgentRole[];

export type SetupDefaults = {
  agentRoles: typeof DEFAULT_AGENT_ROLES;
  workspaceName: string;
  workspaceMemberRole: "owner";
  agentStatus: "active";
  managerModel: string;
  demoPlanningLocalProfile: {
    enabled: boolean;
    provider: "local";
    model: string;
    runnerKind: Extract<RunnerKind, "local_relay">;
  };
  defaultAgentProvisioningSource: "platform_bootstrap";
  claimedAgentProvisioningSource: "claimed_existing";
};

export type OnboardingDefaultAgentRole = DefaultAgentRole | Extract<AgentType, "manager" | "learning">;

type ProviderAgentDefaults = Record<
  OnboardingDefaultAgentRole,
  {
    model: string;
  }
>;

const OPENAI_ONBOARDING_DEFAULTS: ProviderAgentDefaults = {
  planning: {
    model: "openai/gpt-5.2",
  },
  coding: {
    model: "openai/gpt-5.1-codex",
  },
  manager: {
    model: "openai/gpt-5.2",
  },
  learning: {
    model: "openai/gpt-5.2",
  },
};

const ANTHROPIC_ONBOARDING_DEFAULTS: ProviderAgentDefaults = {
  planning: {
    model: "anthropic/claude-opus-4-6",
  },
  coding: {
    model: "anthropic/claude-sonnet-4-6",
  },
  manager: {
    model: "anthropic/claude-sonnet-4-6",
  },
  learning: {
    model: "anthropic/claude-sonnet-4-6",
  },
};

const ONBOARDING_DEFAULTS_BY_PROVIDER: Partial<Record<CredentialProvider, ProviderAgentDefaults>> = {
  openai: OPENAI_ONBOARDING_DEFAULTS,
  anthropic: ANTHROPIC_ONBOARDING_DEFAULTS,
};

export function onboardingAgentDefaults(input: {
  provider: CredentialProvider;
  role: OnboardingDefaultAgentRole;
  modelOverride?: string;
}) {
  const model = input.modelOverride?.trim() || ONBOARDING_DEFAULTS_BY_PROVIDER[input.provider]?.[input.role]?.model;
  if (!model) return null;
  return {
    model,
    runnerKind: DEFAULT_RUNNER_KIND_BY_AGENT_TYPE[input.role],
  };
}

function envValue(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function envFlag(name: string, fallback: boolean) {
  const value = envValue(name);
  if (!value) return fallback;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export function getSetupDefaults(): SetupDefaults {
  const localPlannerEnabled = envFlag("SETUP_DEMO_PLANNING_LOCAL_ENABLED", process.env.NODE_ENV === "development");
  return {
    agentRoles: DEFAULT_AGENT_ROLES,
    workspaceName: envValue("SETUP_DEFAULT_WORKSPACE_NAME") ?? "Personal Workspace",
    workspaceMemberRole: "owner",
    agentStatus: "active",
    managerModel: envValue("SETUP_DEFAULT_MANAGER_MODEL") ?? "openai/gpt-5.2",
    demoPlanningLocalProfile: {
      enabled: localPlannerEnabled,
      provider: "local",
      model: envValue("SETUP_DEMO_PLANNING_LOCAL_MODEL") ?? "qwen2.5-coder:7b",
      runnerKind: "local_relay",
    },
    defaultAgentProvisioningSource: "platform_bootstrap",
    claimedAgentProvisioningSource: "claimed_existing",
  };
}
