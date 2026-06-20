import type { AgentUpdateInput } from "../api/stored-agents";
import type {
  AgentType,
  LocalModelCodingConfig,
  PlanningDestination,
  StoredAgentConfigurationStatus,
} from "../../../../contracts/agents";

export type AgentIdentity = {
  name?: string;
  emoji?: string;
  avatar?: string;
  avatarUrl?: string;
  theme?: string;
};

export type Agent = {
  id: string;
  name: string;
  workspaceId?: string;
  agentType: AgentType;
  model: string | null;
  provider: string | null;
  context: string | null;
  runnerKind: string | null;
  hasCredentials: boolean;
  configurationStatus: StoredAgentConfigurationStatus | null;
  planningDestination: PlanningDestination | null;
  localModelCoding: LocalModelCodingConfig | null;
  customTarget: {
    backendType: string | null;
    baseUrl: string | null;
    agentId: string | null;
  } | null;
  identity: AgentIdentity;
};

export type AgentPatch = Partial<Omit<AgentUpdateInput, "customTarget">> & {
  customTarget?: AgentUpdateInput["customTarget"];
};
