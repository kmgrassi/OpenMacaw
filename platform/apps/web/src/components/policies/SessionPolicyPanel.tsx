import type {
  CreateSessionPolicyRequest,
  PolicyKind,
} from "../../../../../contracts/policy";
import {
  useCreateSessionPolicyMutation,
  useDeleteSessionPolicyMutation,
  useSaveSessionPolicyMutation,
  useSessionPoliciesQuery,
  useSessionPolicyStateQuery,
} from "../../hooks/usePolicies";
import { Alert } from "../ui/Alert";
import { PolicyPanel } from "./PolicyPanel";

type Props = {
  sessionThreadId?: string | null;
  workspaceId?: string | null;
};

export function SessionPolicyPanel({ sessionThreadId, workspaceId }: Props) {
  const policies = useSessionPoliciesQuery(sessionThreadId, workspaceId);
  const state = useSessionPolicyStateQuery(sessionThreadId, workspaceId);
  const createPolicy = useCreateSessionPolicyMutation(
    sessionThreadId,
    workspaceId,
  );
  const savePolicy = useSaveSessionPolicyMutation(sessionThreadId, workspaceId);
  const deletePolicy = useDeleteSessionPolicyMutation(
    sessionThreadId,
    workspaceId,
  );
  const saving =
    createPolicy.isPending || savePolicy.isPending || deletePolicy.isPending;
  const error =
    (policies.error as Error | null)?.message ??
    (state.error as Error | null)?.message ??
    (createPolicy.error as Error | null)?.message ??
    (savePolicy.error as Error | null)?.message ??
    (deletePolicy.error as Error | null)?.message ??
    null;

  if (!sessionThreadId || !workspaceId) return null;

  return (
    <div className="mx-auto max-w-4xl pb-3">
      <PolicyPanel
        title="Session policies"
        description="Tighten this run while it is active and watch policy counters update."
        createLabel="Add session policy"
        policies={policies.data?.policies ?? []}
        availableKinds={policies.data?.availableKinds}
        state={state.data?.state ?? []}
        loading={policies.isLoading || state.isLoading}
        saving={saving}
        error={error}
        onSave={async (draft) => {
          if (!workspaceId) throw new Error("Workspace context is required.");
          const request = {
            workspaceId,
            kind: draft.kind as PolicyKind,
            params: draft.params as CreateSessionPolicyRequest["params"],
            priority: draft.priority,
            enabled: draft.enabled,
            reason: draft.reason,
          };

          if (
            (policies.data?.policies ?? []).some(
              (policy) => policy.id === draft.id,
            )
          ) {
            await savePolicy.mutateAsync({ policyId: draft.id, request });
          } else {
            await createPolicy.mutateAsync(request);
          }
        }}
        onDelete={async (policyId) => {
          await deletePolicy.mutateAsync(policyId);
        }}
      />
      <Alert tone="warning" className="mt-3">
        Policy approval actions appear here after the runtime exposes the
        policy_ask approve/refuse endpoint.
      </Alert>
    </div>
  );
}
