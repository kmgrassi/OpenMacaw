import { useEffect, useMemo, useState } from "react";
import {
  listLocalRuntimes,
  type LocalRuntime,
} from "../../../api/local-runtime";
import { Select } from "../../ui/Select";
import { RUNTIME_FAMILY_PROVIDER_IDS } from "../../../../../../contracts/provider-registry";

const RUNTIME_FAMILY_LABELS: Record<string, string> = {
  openclaw: "OpenClaw",
  codex: "Codex",
  computer_use: "Computer use",
  local: "Local (generic)",
};

type Props = {
  workspaceId: string | null | undefined;
  value: string;
  onChange: (next: string) => void;
};

/**
 * Renders a dropdown picking the `provider` field of a local_relay routing
 * rule — i.e. which runner kind the registered workspace relay should dispatch
 * to. The options are the union of the kinds advertised by an online relay
 * for this workspace and the canonical runtime-family identifiers from
 * contracts/provider-registry.
 */
export function LocalRelayTargetSelector({
  workspaceId,
  value,
  onChange,
}: Props) {
  const [advertised, setAdvertised] = useState<string[]>([]);

  useEffect(() => {
    if (!workspaceId) {
      setAdvertised([]);
      return;
    }
    let cancelled = false;
    listLocalRuntimes(workspaceId)
      .then((response) => {
        if (cancelled) return;
        const kinds = response.runtimes
          .filter(
            (runtime: LocalRuntime) => runtime.localExecution.helperOnline,
          )
          .flatMap((runtime) => runtime.localExecution.advertisedRunnerKinds);
        setAdvertised(Array.from(new Set(kinds)));
      })
      .catch(() => {
        if (!cancelled) setAdvertised([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const options = useMemo(() => {
    const union = new Set<string>([
      ...advertised,
      ...RUNTIME_FAMILY_PROVIDER_IDS,
    ]);
    return [
      { value: "", label: "Select a target runner..." },
      ...Array.from(union)
        .sort()
        .map((kind) => ({
          value: kind,
          label: advertised.includes(kind)
            ? `${labelFor(kind)} (online)`
            : labelFor(kind),
        })),
    ];
  }, [advertised]);

  return (
    <Select
      label="Target runner"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      options={options}
      error={
        value
          ? undefined
          : "Pick which runner the registered workspace relay should dispatch to."
      }
    />
  );
}

function labelFor(kind: string) {
  return RUNTIME_FAMILY_LABELS[kind] ?? kind;
}
