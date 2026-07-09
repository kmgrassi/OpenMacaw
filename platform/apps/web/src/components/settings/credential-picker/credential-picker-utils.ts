import {
  CREDENTIAL_PROVIDERS,
  type CredentialProvider,
} from "../../../../../../contracts/credentials";
import type {
  CredentialReference,
  SavedCredential,
} from "../../../api/credentials";
import { formatProviderLabel } from "../../../lib/provider-labels";

export function credentialRowId(credential: SavedCredential): string {
  return (
    credential.credentialRowId ??
    credential.id.split(":", 1)[0] ??
    credential.id
  );
}

export function credentialProviderLabel(
  credential: SavedCredential | null | undefined,
) {
  return formatProviderLabel(credential?.provider);
}

export function credentialValidationLabel(credential: SavedCredential) {
  switch (credential.validationState) {
    case "ok":
      return "validated";
    case "invalid":
      return "invalid";
    case "expired":
      return "expired";
    case "unknown":
      return "not validated";
  }
}

export function matchesProviderFilter(
  credential: SavedCredential | null | undefined,
  providerFilter?: string | null,
) {
  return !providerFilter || credential?.provider === providerFilter;
}

export function credentialRefValue(
  ref: CredentialReference | null | undefined,
) {
  return ref ? `${ref.type}:${ref.value}` : "";
}

export function asCredentialProvider(value: string | null | undefined) {
  return CREDENTIAL_PROVIDERS.some((provider) => provider.provider === value)
    ? (value as CredentialProvider)
    : null;
}

export function providerFilterLabel(providerFilter?: string | null) {
  if (!providerFilter) return null;
  return formatProviderLabel(providerFilter);
}
