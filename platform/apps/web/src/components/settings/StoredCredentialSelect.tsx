import { useMemo } from "react";

import {
  normalizeCredentialProvider,
  type SavedCredential,
} from "../../../../../contracts/credentials";
import { Select } from "../ui/Select";

// Sentinel value used to represent "don't reuse a stored key — enter a new one".
export const NEW_CREDENTIAL_VALUE = "";

// The DB credential row id is what the backend reuses. `SavedCredential.id`
// is a per-env-var composite (`<rowId>:<envVar>`), so prefer `credentialRowId`.
export function storedCredentialId(credential: SavedCredential): string {
  return credential.credentialRowId ?? credential.id;
}

// Stored credentials that can back the given provider, de-duplicated by the
// underlying credential row (one row can surface under multiple env-var
// aliases via `toSavedCredentials`).
export function storedCredentialsForProvider(
  credentials: SavedCredential[],
  provider: string,
): SavedCredential[] {
  const target = normalizeCredentialProvider(provider);
  if (!target) return [];
  const seen = new Set<string>();
  const result: SavedCredential[] = [];
  for (const credential of credentials) {
    if (normalizeCredentialProvider(credential.provider ?? "") !== target) {
      continue;
    }
    const rowId = storedCredentialId(credential);
    if (seen.has(rowId)) continue;
    seen.add(rowId);
    result.push(credential);
  }
  return result;
}

type StoredCredentialSelectProps = {
  label?: string;
  credentials: SavedCredential[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};

// Lets the user reuse a stored API key (shown masked) for the selected
// provider, or fall back to entering a new one. Renders nothing when there
// are no stored keys for the provider.
export function StoredCredentialSelect({
  label = "API key",
  credentials,
  value,
  onChange,
  disabled,
}: StoredCredentialSelectProps) {
  const options = useMemo(
    () => [
      ...credentials.map((credential) => ({
        value: storedCredentialId(credential),
        label: credential.label,
      })),
      { value: NEW_CREDENTIAL_VALUE, label: "Enter a new key…" },
    ],
    [credentials],
  );

  if (credentials.length === 0) return null;

  return (
    <Select
      label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      options={options}
      disabled={disabled}
    />
  );
}
