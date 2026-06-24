import { useMemo, useState } from "react";

import { type CredentialProvider } from "../../../../../contracts/credentials";
import type { SetupResponse } from "../../../../../contracts/setup";
import {
  activateManagerAgentCredentials,
  configureAgentCredentials,
  fetchSetup,
} from "../../api/setup";
import { invalidateAgentData, queryClient } from "../../api/query-client";
import { queryKeys } from "../../api/query-keys";
import { useWorkspaceCredentialsQuery } from "../../hooks/useServerStateQueries";
import { CredentialEditor } from "../settings/CredentialEditor";
import { HostedModelSelect } from "../settings/HostedModelSelect";
import { storedCredentialsForProvider } from "../settings/StoredCredentialSelect";

type InlineCredentialFormProps = {
  setup: SetupResponse;
  onConfigured: (setup: SetupResponse) => void;
};

const PROVIDER_ORDER: CredentialProvider[] = [
  "openai",
  "anthropic",
  "xai",
  "google",
  "mistral",
  "groq",
  "openrouter",
  "together",
  "perplexity",
  "azure",
];

function primaryModel(setup: SetupResponse) {
  if (
    !setup.agent.modelSettings ||
    typeof setup.agent.modelSettings !== "object"
  ) {
    return "";
  }
  const primary = (setup.agent.modelSettings as { primary?: unknown }).primary;
  return typeof primary === "string" ? primary.trim() : "";
}

export function InlineCredentialForm({
  setup,
  onConfigured,
}: InlineCredentialFormProps) {
  const existingModel = useMemo(() => primaryModel(setup), [setup]);
  const initialProvider = useMemo<CredentialProvider>(() => {
    const provider = existingModel.split("/", 1)[0] as CredentialProvider;
    return PROVIDER_ORDER.includes(provider) ? provider : "openai";
  }, [existingModel]);

  const [provider, setProvider] = useState<CredentialProvider>(initialProvider);
  const [model, setModel] = useState(existingModel);

  const workspaceCredentialsQuery = useWorkspaceCredentialsQuery(
    setup.agent.workspaceId,
  );
  const existingCredentials = useMemo(
    () =>
      storedCredentialsForProvider(
        workspaceCredentialsQuery.data ?? [],
        provider,
      ),
    [workspaceCredentialsQuery.data, provider],
  );

  function handleProviderChange(nextProvider: CredentialProvider) {
    setProvider(nextProvider);
    setModel("");
  }

  async function applyConfiguredSetup(configured: SetupResponse) {
    queryClient.setQueryData(
      queryKeys.setup.byAgent(configured.agent.id),
      configured,
    );
    await invalidateAgentData({
      agentId: configured.agent.id,
      workspaceId: configured.agent.workspaceId,
    });
    onConfigured(configured);
  }

  return (
    <div className="mt-4 border-t border-slate-800/80 pt-4">
      <CredentialEditor
        agentId={setup.agent.id}
        workspaceId={setup.agent.workspaceId}
        initialProvider={provider}
        onProviderChange={handleProviderChange}
        providerOptions={PROVIDER_ORDER}
        submitLabel="Save Credentials"
        disabledReason={!model.trim() ? "Model is required." : null}
        existingCredentials={existingCredentials}
        apiKeyExtraFields={
          <HostedModelSelect
            label="Model"
            value={model}
            workspaceId={setup.agent.workspaceId}
            provider={provider}
            allowCustomWhenEmpty
            customPlaceholder={`${provider}/model-name`}
            onChange={setModel}
          />
        }
        onUseExistingCredential={async (credentialId) => {
          const trimmedModel = model.trim();
          let configured: SetupResponse;
          if (setup.agent.type === "manager") {
            await activateManagerAgentCredentials({
              agentId: setup.agent.id,
              workspaceId: setup.agent.workspaceId,
              provider,
              model: trimmedModel,
              runnerKind: "llm_tool_runner",
              credentialRef: { type: "credential_id", value: credentialId },
            });
            configured = await fetchSetup(setup.agent.id);
          } else {
            configured = await configureAgentCredentials({
              agentId: setup.agent.id,
              workspaceId: setup.agent.workspaceId,
              provider,
              model: trimmedModel,
              credentialId,
            });
          }
          await applyConfiguredSetup(configured);
        }}
        onApiKeyCredential={async (credential) => {
          const trimmedModel = model.trim();
          let configured: SetupResponse;
          if (setup.agent.type === "manager") {
            await activateManagerAgentCredentials({
              agentId: setup.agent.id,
              workspaceId: setup.agent.workspaceId,
              provider: credential.provider,
              model: trimmedModel,
              runnerKind: "llm_tool_runner",
              newCredential: {
                apiKey: credential.secret,
                label: credential.label ?? `${credential.provider} API key`,
              },
            });
            configured = await fetchSetup(setup.agent.id);
          } else {
            configured = await configureAgentCredentials({
              agentId: setup.agent.id,
              workspaceId: setup.agent.workspaceId,
              provider: credential.provider,
              model: trimmedModel,
              label: credential.label ?? `${credential.provider} API key`,
              keyName: credential.keyName,
              secret: credential.secret,
            });
          }
          await applyConfiguredSetup(configured);
        }}
      />
    </div>
  );
}
