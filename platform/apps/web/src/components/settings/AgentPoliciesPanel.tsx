import type {
  PolicyKind,
  UpsertAgentPolicyRequest,
} from "../../../../../contracts/policy";
import {
  useAgentPoliciesQuery,
  useDeleteAgentPolicyMutation,
  useSaveAgentPolicyMutation,
} from "../../hooks/usePolicies";
import { PolicyPanel } from "../policies/PolicyPanel";

type Props = {
  agentId: string;
  workspaceId?: string | null;
};

export function AgentPoliciesPanel({ agentId, workspaceId }: Props) {
  const policies = useAgentPoliciesQuery(agentId, workspaceId);
  const savePolicy = useSaveAgentPolicyMutation(agentId, workspaceId);
  const deletePolicy = useDeleteAgentPolicyMutation(agentId, workspaceId);
  const saving = savePolicy.isPending || deletePolicy.isPending;
  const error =
    (policies.error as Error | null)?.message ??
    (savePolicy.error as Error | null)?.message ??
    (deletePolicy.error as Error | null)?.message ??
    null;

  return (
    <PolicyPanel
      title="Policies"
      description="Configure workspace and agent-tier policy rules that apply when this agent runs."
      policies={policies.data?.policies ?? []}
      availableKinds={policies.data?.availableKinds}
      loading={policies.isLoading}
      saving={saving}
      error={error}
      onSave={async (draft) => {
        if (!workspaceId) throw new Error("Workspace context is required.");
        await savePolicy.mutateAsync({
          policyId: draft.id,
          request: {
            workspaceId,
            kind: draft.kind as PolicyKind,
            params: draft.params as UpsertAgentPolicyRequest["params"],
            priority: draft.priority,
            enabled: draft.enabled,
            reason: draft.reason,
          },
        });
      }}
      onDelete={async (policyId) => {
        await deletePolicy.mutateAsync(policyId);
      }}
    />
  );
}
