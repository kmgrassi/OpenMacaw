import type { AgentRuntimeProfile } from "../../../../../../contracts/agents";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/Select";
import {
  credentialOptionsForProvider,
  credentialRefFromValue,
  FALLBACK_PROVIDER_OPTIONS,
  firstModelForProvider,
  modelOptionsForProvider,
} from "./agent-runtime-editor-shared";
import { credentialRefValue } from "../credential-picker/credential-picker-utils";
import type { RuntimeCredentialState } from "./types";

type FallbackChainBuilderProps = {
  agentId: string;
  workspaceId: string | null | undefined;
  fallbacks: AgentRuntimeProfile["fallbacks"];
  disabled: boolean;
  credentialState: RuntimeCredentialState | null;
  onChange: (value: AgentRuntimeProfile["fallbacks"]) => void;
};

export function FallbackChainBuilder({
  agentId,
  workspaceId,
  fallbacks,
  disabled,
  credentialState,
  onChange,
}: FallbackChainBuilderProps) {
  const updateLink = (
    index: number,
    patch: Partial<AgentRuntimeProfile["fallbacks"][number]>,
  ) => {
    onChange(
      fallbacks.map((fallback, candidateIndex) =>
        candidateIndex === index ? { ...fallback, ...patch } : fallback,
      ),
    );
  };

  const moveLink = (index: number, direction: -1 | 1) => {
    const next = [...fallbacks];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    const current = next[index];
    const targetFallback = next[target];
    if (!current || !targetFallback) return;
    next[index] = targetFallback;
    next[target] = current;
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {fallbacks.length === 0 && (
        <p className="text-xs text-slate-500">No fallback links configured.</p>
      )}
      {fallbacks.map((fallback, index) => (
        <div
          key={`${fallback.provider}:${fallback.model}:${index}`}
          className="grid gap-2 rounded-md border border-white/5 bg-surface-raised p-2 md:grid-cols-[2rem_1fr_1.4fr_1.3fr_auto]"
        >
          <div
            className="flex h-9 items-center justify-center rounded border border-border text-slate-500"
            title="Drag handle"
          >
            ::
          </div>
          <Select
            label={index === 0 ? "Provider" : undefined}
            aria-label={`Fallback ${index + 1} provider`}
            value={fallback.provider}
            onChange={(event) => {
              const provider = event.target.value;
              updateLink(index, {
                provider,
                model: firstModelForProvider(provider),
                credentialRef: null,
              });
            }}
            options={FALLBACK_PROVIDER_OPTIONS}
            disabled={disabled}
          />
          <Select
            label={index === 0 ? "Model" : undefined}
            aria-label={`Fallback ${index + 1} model`}
            value={fallback.model}
            onChange={(event) =>
              updateLink(index, { model: event.target.value })
            }
            options={modelOptionsForProvider(fallback.provider)}
            disabled={disabled}
          />
          <Select
            label={index === 0 ? "Credential" : undefined}
            aria-label={`Fallback ${index + 1} credential`}
            value={credentialRefValue(fallback.credentialRef)}
            onChange={(event) =>
              updateLink(index, {
                credentialRef: credentialRefFromValue(event.target.value),
              })
            }
            options={credentialOptionsForProvider(
              credentialState,
              fallback.provider,
            )}
            disabled={!workspaceId || disabled}
          />
          <div className="flex items-end gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled || index === 0}
              onClick={() => moveLink(index, -1)}
              title="Move fallback up"
            >
              Up
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled || index === fallbacks.length - 1}
              onClick={() => moveLink(index, 1)}
              title="Move fallback down"
            >
              Down
            </Button>
            <Button
              type="button"
              size="sm"
              variant="danger"
              disabled={disabled}
              onClick={() =>
                onChange(
                  fallbacks.filter(
                    (_fallback, candidateIndex) => candidateIndex !== index,
                  ),
                )
              }
            >
              Remove
            </Button>
          </div>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={disabled}
        onClick={() => {
          const provider = FALLBACK_PROVIDER_OPTIONS[0]?.value ?? "openai";
          onChange([
            ...fallbacks,
            {
              provider,
              model: firstModelForProvider(provider),
              credentialRef: null,
            },
          ]);
        }}
      >
        Add fallback
      </Button>
      {!agentId && <span className="sr-only">Agent unavailable</span>}
    </div>
  );
}
