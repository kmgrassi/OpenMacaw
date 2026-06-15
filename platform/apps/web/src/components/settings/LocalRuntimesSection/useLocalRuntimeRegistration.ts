import { useState } from "react";
import {
  type LocalModelProbeResponse,
  type LocalRuntimeRunnerInput,
  type LocalToolCallCapability,
  type RegisterLocalRuntimeResponse,
} from "../../../api/local-runtime";
import { pickDirectory } from "../../../api/local-directory";
import { useLocalRuntimeMutations } from "../../../hooks/useServerStateQueries";

type Args = {
  workspaceId: string;
  onConfigResultClear: () => void;
};

const DEFAULT_OPENAI_COMPATIBLE_ENDPOINT = "http://localhost:11434/v1";
const DEFAULT_OPENCLAW_ENDPOINT = "http://localhost:7100";
const DRAFT_PROBE_AVAILABLE = import.meta.env.DEV;

export function useLocalRuntimeRegistration({
  workspaceId,
  onConfigResultClear,
}: Args) {
  const mutations = useLocalRuntimeMutations(workspaceId);
  // Default to model-only registration. OpenClaw is opt-in via the checkbox.
  const [modelEnabled, setModelEnabled] = useState(true);
  const [openClawEnabled, setOpenClawEnabled] = useState(false);
  const [modelEndpoint, setModelEndpoint] = useState(
    DEFAULT_OPENAI_COMPATIBLE_ENDPOINT,
  );
  const [openClawEndpoint, setOpenClawEndpoint] = useState(
    DEFAULT_OPENCLAW_ENDPOINT,
  );
  const [modelName, setModelName] = useState("");
  const [provider, setProvider] = useState("openai_compatible");
  const [repositoryPath, setRepositoryPath] = useState("");
  const [modelApiKey, setModelApiKey] = useState("");
  const [openClawApiKey, setOpenClawApiKey] = useState("");
  const [toolCallCapability, setToolCallCapability] =
    useState<LocalToolCallCapability>("native_tools");
  const [registrationResult, setRegistrationResult] =
    useState<RegisterLocalRuntimeResponse | null>(null);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [pickingRepositoryPath, setPickingRepositoryPath] = useState(false);
  const [draftProbe, setDraftProbe] = useState<LocalModelProbeResponse | null>(
    null,
  );

  const handleModelEnabledChange = (next: boolean) => {
    setModelEnabled(next);
    setDraftProbe(null);
    setRegisterError(null);
  };
  const handleOpenClawEnabledChange = (next: boolean) => {
    setOpenClawEnabled(next);
    setRegisterError(null);
  };

  const handleModelEndpointChange = (value: string) => {
    setModelEndpoint(value);
    setDraftProbe(null);
  };

  const handleModelNameChange = (value: string) => {
    setModelName(value);
    setDraftProbe(null);
  };

  const handleProbeDraft = async () => {
    if (!DRAFT_PROBE_AVAILABLE) return;
    if (!modelEnabled) return;
    if (!modelEndpoint.trim() || !modelName.trim()) return;
    setRegisterError(null);
    try {
      setDraftProbe(
        await mutations.probeDraft.mutateAsync({
          endpoint: modelEndpoint.trim(),
          model: modelName.trim(),
        }),
      );
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePickRepositoryPath = async () => {
    setRegisterError(null);
    setPickingRepositoryPath(true);
    try {
      const result = await pickDirectory({
        defaultLocation: repositoryPath.trim() || undefined,
        prompt: "Choose the local repository directory for this runtime",
      });
      if (!result.cancelled) {
        setRepositoryPath(result.path);
      }
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : String(err));
    } finally {
      setPickingRepositoryPath(false);
    }
  };

  const canSubmit = (() => {
    if (!modelEnabled && !openClawEnabled) return false;
    if (modelEnabled) {
      if (!modelEndpoint.trim()) return false;
      if (!modelName.trim()) return false;
    }
    if (openClawEnabled) {
      if (!openClawEndpoint.trim()) return false;
    }
    return true;
  })();

  const handleRegister = async () => {
    if (!canSubmit) return;
    setRegisterError(null);
    try {
      const runners: LocalRuntimeRunnerInput[] = [];
      if (modelEnabled) {
        runners.push({
          kind: "openai_compatible",
          endpoint: modelEndpoint.trim(),
          model: modelName.trim(),
          provider: provider || undefined,
          apiKey: modelApiKey.trim() || undefined,
          workspaceRoot: repositoryPath.trim() || undefined,
          toolCallCapability,
        });
      }
      if (openClawEnabled) {
        runners.push({
          kind: "openclaw",
          endpoint: openClawEndpoint.trim(),
          apiKey: openClawApiKey.trim() || undefined,
        });
      }
      const result = await mutations.register.mutateAsync({ runners });
      setModelName("");
      setModelApiKey("");
      setOpenClawApiKey("");
      setDraftProbe(null);
      setRegistrationResult(result);
      onConfigResultClear();
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : String(err));
    }
  };

  return {
    modelEnabled,
    openClawEnabled,
    modelEndpoint,
    openClawEndpoint,
    modelName,
    provider,
    repositoryPath,
    modelApiKey,
    openClawApiKey,
    toolCallCapability,
    registrationResult,
    registering: mutations.register.isPending,
    registerError,
    pickingRepositoryPath,
    draftProbeAvailable: DRAFT_PROBE_AVAILABLE,
    probingDraft: mutations.probeDraft.isPending,
    draftProbe,
    canSubmit,
    setProvider,
    setRepositoryPath,
    setModelApiKey,
    setOpenClawApiKey,
    setToolCallCapability,
    setOpenClawEndpoint,
    setRegistrationResult,
    handleModelEnabledChange,
    handleOpenClawEnabledChange,
    handleModelEndpointChange,
    handleModelNameChange,
    handlePickRepositoryPath,
    handleProbeDraft,
    handleRegister,
  };
}

export type LocalRuntimeRegistrationState = ReturnType<
  typeof useLocalRuntimeRegistration
>;
