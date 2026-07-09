import { useMemo, useState } from "react";
import type {
  Policy,
  PolicyKind,
  PolicyKindDefinition,
  PolicySessionState,
} from "../../../../../contracts/policy";
import { POLICY_KIND_DEFINITIONS } from "../../../../../contracts/policy";
import { Alert } from "../ui/Alert";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Checkbox } from "../ui/Checkbox";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Textarea } from "../ui/Textarea";

type DraftPolicy = {
  id: string;
  kind: PolicyKind;
  paramsText: string;
  priority: number;
  enabled: boolean;
  reason: string;
};

type Props = {
  title: string;
  description?: string;
  policies: Policy[];
  availableKinds?: PolicyKindDefinition[];
  loading?: boolean;
  saving?: boolean;
  error?: string | null;
  state?: PolicySessionState[];
  createLabel?: string;
  onSave: (draft: {
    id: string;
    kind: PolicyKind;
    params: Record<string, unknown>;
    priority: number;
    enabled: boolean;
    reason: string | null;
  }) => Promise<void>;
  onDelete: (policyId: string) => Promise<void>;
};

function defaultDraft(kind: PolicyKind): DraftPolicy {
  const definition =
    POLICY_KIND_DEFINITIONS.find((item) => item.kind === kind) ??
    POLICY_KIND_DEFINITIONS[0]!;
  return {
    id: crypto.randomUUID(),
    kind,
    paramsText: JSON.stringify(definition.defaultParams, null, 2),
    priority: 0,
    enabled: true,
    reason: "",
  };
}

function draftFromPolicy(policy: Policy): DraftPolicy {
  return {
    id: policy.id,
    kind: policy.kind,
    paramsText: JSON.stringify(policy.params, null, 2),
    priority: policy.priority,
    enabled: policy.enabled,
    reason: policy.reason ?? "",
  };
}

function kindLabel(kind: PolicyKind, kinds: PolicyKindDefinition[]) {
  return kinds.find((definition) => definition.kind === kind)?.label ?? kind;
}

function formatStateValue(state: PolicySessionState) {
  if (state.valueNumeric !== null) return String(state.valueNumeric);
  if (state.valueJson !== null) return JSON.stringify(state.valueJson);
  return "empty";
}

export function PolicyPanel({
  title,
  description,
  policies,
  availableKinds = [...POLICY_KIND_DEFINITIONS],
  loading = false,
  saving = false,
  error,
  state = [],
  createLabel = "Add policy",
  onSave,
  onDelete,
}: Props) {
  const [draft, setDraft] = useState<DraftPolicy | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const kindOptions = useMemo(
    () =>
      availableKinds.map((definition) => ({
        value: definition.kind,
        label: definition.label,
      })),
    [availableKinds],
  );

  const beginCreate = () => {
    setFormError(null);
    setDraft(
      defaultDraft(availableKinds[0]?.kind ?? "max_tool_calls_per_session"),
    );
  };

  const beginEdit = (policy: Policy) => {
    setFormError(null);
    setDraft(draftFromPolicy(policy));
  };

  const updateKind = (kind: PolicyKind) => {
    const definition =
      availableKinds.find((item) => item.kind === kind) ??
      POLICY_KIND_DEFINITIONS.find((item) => item.kind === kind);
    setDraft((current) =>
      current
        ? {
            ...current,
            kind,
            paramsText: JSON.stringify(
              definition?.defaultParams ?? {},
              null,
              2,
            ),
          }
        : current,
    );
  };

  const saveDraft = async () => {
    if (!draft) return;
    let params: Record<string, unknown>;
    try {
      const parsed = JSON.parse(draft.paramsText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Params must be a JSON object.");
      }
      params = parsed as Record<string, unknown>;
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Params JSON is invalid.",
      );
      return;
    }

    setFormError(null);
    await onSave({
      id: draft.id,
      kind: draft.kind,
      params,
      priority: draft.priority,
      enabled: draft.enabled,
      reason: draft.reason.trim() || null,
    });
    setDraft(null);
  };

  return (
    <Card>
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h3 className="text-base font-semibold text-slate-200">{title}</h3>
          {description && (
            <p className="mt-1 text-sm text-slate-400">{description}</p>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={saving}
          onClick={beginCreate}
        >
          {createLabel}
        </Button>
      </div>

      {(error || formError) && (
        <Alert tone="error" className="mb-4">
          {formError ?? error}
        </Alert>
      )}

      {state.length > 0 && (
        <div className="mb-4 grid gap-2 sm:grid-cols-3">
          {state.map((item) => (
            <div
              key={item.key}
              className="rounded-md border border-border bg-surface-raised px-3 py-2"
            >
              <div className="text-xs text-slate-500">{item.key}</div>
              <div className="mt-1 truncate text-sm font-medium text-slate-200">
                {formatStateValue(item)}
              </div>
            </div>
          ))}
        </div>
      )}

      {draft && (
        <div className="mb-4 space-y-3 rounded-md border border-border bg-surface-raised p-3">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_120px]">
            <Select
              label="Policy kind"
              value={draft.kind}
              options={kindOptions}
              onChange={(event) => updateKind(event.target.value as PolicyKind)}
            />
            <Input
              label="Priority"
              type="number"
              value={draft.priority}
              onChange={(event) =>
                setDraft((current) =>
                  current
                    ? { ...current, priority: Number(event.target.value) }
                    : current,
                )
              }
            />
          </div>
          <Textarea
            label="Params JSON"
            value={draft.paramsText}
            rows={6}
            spellCheck={false}
            onChange={(event) =>
              setDraft((current) =>
                current
                  ? { ...current, paramsText: event.target.value }
                  : current,
              )
            }
          />
          <Input
            label="Reason"
            value={draft.reason}
            onChange={(event) =>
              setDraft((current) =>
                current ? { ...current, reason: event.target.value } : current,
              )
            }
            placeholder="Optional review context"
          />
          <Checkbox
            label="Enabled"
            checked={draft.enabled}
            onChange={(event) =>
              setDraft((current) =>
                current
                  ? { ...current, enabled: event.target.checked }
                  : current,
              )
            }
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDraft(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              loading={saving}
              disabled={saving}
              onClick={() => void saveDraft()}
            >
              Save
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="py-4 text-sm text-slate-400">Loading policies...</p>
      ) : policies.length === 0 ? (
        <p className="py-4 text-sm text-slate-500">No policies configured.</p>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border">
          {policies.map((policy) => (
            <div
              key={policy.id}
              className="flex flex-col gap-3 p-3 md:flex-row md:items-start md:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-slate-200">
                    {kindLabel(policy.kind, availableKinds)}
                  </span>
                  <Badge value={policy.scope} />
                  <Badge value={policy.source} />
                  {!policy.enabled && <Badge tone="warning">disabled</Badge>}
                </div>
                <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded bg-slate-950/50 p-2 text-xs text-slate-300">
                  {JSON.stringify(policy.params, null, 2)}
                </pre>
                {policy.reason && (
                  <p className="mt-2 text-xs text-slate-500">{policy.reason}</p>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  onClick={() => beginEdit(policy)}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  onClick={() => void onDelete(policy.id)}
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
