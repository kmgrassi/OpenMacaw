import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  CREDENTIAL_PROVIDERS,
  type CredentialProvider,
  type SavedCredential,
} from "../../../../../contracts/credentials";
import { cn } from "../../lib/cn";
import { devApiKeyForProvider } from "../../lib/dev-credentials";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { SegmentedControl } from "../ui/SegmentedControl";
import { ConnectChatGPTButton } from "./ConnectChatGPTButton";
import {
  NEW_CREDENTIAL_VALUE,
  StoredCredentialSelect,
  storedCredentialId,
} from "./StoredCredentialSelect";

export type CredentialEditorFormat =
  | "api_key"
  | "oauth"
  | "secret_ref"
  | "compatible_endpoint";

type ApiKeyCredentialInput = {
  format: "api_key";
  provider: CredentialProvider;
  secret: string;
  label?: string;
  keyName: string;
};

type CredentialEditorProps = {
  agentId?: string | null;
  workspaceId?: string | null;
  className?: string;
  initialProvider?: CredentialProvider;
  onProviderChange?: (provider: CredentialProvider) => void;
  providerOptions?: CredentialProvider[];
  enabledFormats?: CredentialEditorFormat[];
  showLabelField?: boolean;
  defaultLabel?: string;
  submitLabel?: string;
  savingLabel?: string;
  successMessage?: string;
  disabledReason?: string | null;
  apiKeyExtraFields?: ReactNode;
  // Stored credentials for the currently selected provider. When present, the
  // user can reuse one (shown masked) instead of pasting a new key.
  existingCredentials?: SavedCredential[];
  onApiKeyCredential?: (input: ApiKeyCredentialInput) => Promise<void>;
  onUseExistingCredential?: (credentialId: string) => Promise<void>;
  onOAuthConnected?: () => Promise<void> | void;
  onSaved?: () => Promise<void> | void;
};

const FORMAT_LABELS: Record<CredentialEditorFormat, string> = {
  api_key: "API Key",
  oauth: "ChatGPT",
  secret_ref: "Secret Reference",
  compatible_endpoint: "OpenAI-Compatible Endpoint",
};

const DEFAULT_PROVIDER_ORDER: CredentialProvider[] = [
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

function providerMetadata(provider: CredentialProvider) {
  const metadata =
    CREDENTIAL_PROVIDERS.find((entry) => entry.provider === provider) ??
    CREDENTIAL_PROVIDERS.find((entry) => entry.provider === "openai");
  if (!metadata) {
    throw new Error("Credential provider registry is empty");
  }
  return metadata;
}

function firstEnabledFormat(
  enabledFormats: CredentialEditorFormat[],
): CredentialEditorFormat {
  return enabledFormats[0] ?? "api_key";
}

function successTimeout(setSuccess: (success: boolean) => void) {
  window.setTimeout(() => setSuccess(false), 3000);
}

export function CredentialEditor({
  agentId,
  workspaceId,
  className,
  initialProvider = "openai",
  onProviderChange,
  providerOptions = DEFAULT_PROVIDER_ORDER,
  enabledFormats = ["api_key"],
  showLabelField = false,
  defaultLabel = "",
  submitLabel = "Save credentials",
  savingLabel = "Saving...",
  successMessage = "Credentials saved.",
  disabledReason,
  apiKeyExtraFields,
  existingCredentials,
  onApiKeyCredential,
  onUseExistingCredential,
  onOAuthConnected,
  onSaved,
}: CredentialEditorProps) {
  const [format, setFormat] = useState<CredentialEditorFormat>(
    firstEnabledFormat(enabledFormats),
  );
  const [provider, setProvider] = useState<CredentialProvider>(initialProvider);
  const [secret, setSecret] = useState("");
  const [label, setLabel] = useState(defaultLabel);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  // "" = enter a new key; otherwise the id of the stored credential to reuse.
  const [selectedExistingId, setSelectedExistingId] =
    useState<string>(NEW_CREDENTIAL_VALUE);

  const storedCredentials = existingCredentials ?? [];
  const canReuseExisting =
    storedCredentials.length > 0 && Boolean(onUseExistingCredential);

  useEffect(() => {
    setProvider(initialProvider);
  }, [initialProvider]);

  // When the provider (and therefore the stored-key list) changes, default to
  // reusing the first available key, or fall back to entering a new one.
  useEffect(() => {
    const first = storedCredentials[0];
    if (!canReuseExisting || !first) {
      setSelectedExistingId(NEW_CREDENTIAL_VALUE);
      return;
    }
    setSelectedExistingId((current) =>
      current &&
      storedCredentials.some(
        (credential) => storedCredentialId(credential) === current,
      )
        ? current
        : storedCredentialId(first),
    );
  }, [canReuseExisting, storedCredentials]);

  useEffect(() => {
    if (!enabledFormats.includes(format)) {
      setFormat(firstEnabledFormat(enabledFormats));
    }
  }, [enabledFormats, format]);

  const metadata = providerMetadata(provider);
  const devApiKey = devApiKeyForProvider(metadata);
  const providerSelectOptions = useMemo(
    () =>
      providerOptions.map((entry) => ({
        value: entry,
        label: providerMetadata(entry).label.replace(/ API key$/, ""),
      })),
    [providerOptions],
  );

  const reusingExistingCredential =
    canReuseExisting && selectedExistingId !== NEW_CREDENTIAL_VALUE;

  const canSubmitApiKey =
    format === "api_key" &&
    Boolean(workspaceId) &&
    !disabledReason &&
    (reusingExistingCredential
      ? Boolean(onUseExistingCredential)
      : Boolean(onApiKeyCredential) && secret.trim().length > 0);

  async function handleSubmit() {
    if (!canSubmitApiKey) return;
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      if (reusingExistingCredential) {
        await onUseExistingCredential!(selectedExistingId);
      } else {
        await onApiKeyCredential!({
          format: "api_key",
          provider,
          secret: secret.trim(),
          label: label.trim() || undefined,
          keyName: metadata.envVar,
        });
        setSecret("");
      }
      setSuccess(true);
      await onSaved?.();
      successTimeout(setSuccess);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className={cn("space-y-4", className)}
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <SegmentedControl
        ariaLabel="Credential format"
        value={format}
        onValueChange={(nextFormat) => {
          setFormat(nextFormat);
          setError(null);
          setSuccess(false);
        }}
        options={(Object.keys(FORMAT_LABELS) as CredentialEditorFormat[]).map(
          (candidate) => ({
            value: candidate,
            label: FORMAT_LABELS[candidate],
            disabled: !enabledFormats.includes(candidate),
          }),
        )}
        columns={4}
        fullWidth
        textSize="xs"
      />

      {format === "api_key" && (
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <Select
              label="Provider"
              value={provider}
              onChange={(event) => {
                const nextProvider = event.target.value as CredentialProvider;
                setProvider(nextProvider);
                onProviderChange?.(nextProvider);
                setError(null);
              }}
              options={providerSelectOptions}
            />
            {showLabelField ? (
              <Input
                label="Credential label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={defaultLabel || metadata.label}
              />
            ) : null}
          </div>
          {apiKeyExtraFields}
          {canReuseExisting && (
            <StoredCredentialSelect
              label={`${metadata.label.replace(/ API key$/, "")} key`}
              credentials={storedCredentials}
              value={selectedExistingId}
              onChange={(next) => {
                setSelectedExistingId(next);
                setError(null);
              }}
            />
          )}
          {!reusingExistingCredential && (
            <>
              <Input
                className="font-mono"
                label={metadata.label}
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                placeholder={metadata.envVar}
                autoComplete="off"
              />
              {devApiKey && (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => setSecret(devApiKey)}
                  >
                    Use dev credentials
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {format === "oauth" && (
        <div className="space-y-3">
          <ConnectChatGPTButton
            agentId={agentId ?? ""}
            workspaceId={workspaceId ?? null}
            onConnected={async () => {
              setSuccess(true);
              await onOAuthConnected?.();
              await onSaved?.();
              successTimeout(setSuccess);
            }}
          />
        </div>
      )}

      {(format === "secret_ref" || format === "compatible_endpoint") && (
        <div className="rounded-md border border-amber-600/30 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
          This credential format is available in the unified editor shell, but
          it will be wired to persistence with the unified credentials endpoint.
        </div>
      )}

      {disabledReason && (
        <p className="text-xs text-amber-400">{disabledReason}</p>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {success && <p className="text-xs text-green-400">{successMessage}</p>}

      {format === "api_key" && (
        <div className="flex justify-end">
          <Button type="submit" loading={saving} disabled={!canSubmitApiKey}>
            {saving ? savingLabel : submitLabel}
          </Button>
        </div>
      )}
    </form>
  );
}
