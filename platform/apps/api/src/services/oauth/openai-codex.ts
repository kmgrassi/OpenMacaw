/**
 * OpenAI Codex (ChatGPT) device-code OAuth client.
 *
 * Ported from openclaw `extensions/openai/openai-codex-device-code.ts` and
 * `openai-codex-auth-identity.ts`. The device-code flow is the only OAuth path
 * that works for a hosted web app: OpenAI's PKCE flow hardcodes a
 * `http://localhost:1455/auth/callback` redirect, which is unreachable from
 * this server.
 */

import { z } from "zod";

const OPENAI_AUTH_BASE_URL = "https://auth.openai.com";
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_TOKEN_URL = `${OPENAI_AUTH_BASE_URL}/oauth/token`;
const OPENAI_CODEX_DEVICE_CALLBACK_URL = `${OPENAI_AUTH_BASE_URL}/deviceauth/callback`;
const OPENAI_CODEX_DEVICE_VERIFICATION_URL = `${OPENAI_AUTH_BASE_URL}/codex/device`;

export const OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS = 15 * 60_000;
const OPENAI_CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const OPENAI_CODEX_DEVICE_CODE_MIN_INTERVAL_MS = 1_000;

export type OpenAICodexOAuthTokens = {
  access: string;
  refresh: string;
  expires: number;
};

export type OpenAICodexAuthIdentity = {
  accountId?: string;
  chatgptPlanType?: string;
  email?: string;
};

export type OpenAICodexDeviceCodeRequest = {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresInMs: number;
};

export type OpenAICodexDevicePollPending = { status: "pending" };
export type OpenAICodexDevicePollComplete = {
  status: "complete";
  tokens: OpenAICodexOAuthTokens;
};
export type OpenAICodexDevicePollFailed = { status: "failed"; error: string };
export type OpenAICodexDevicePollResult =
  | OpenAICodexDevicePollPending
  | OpenAICodexDevicePollComplete
  | OpenAICodexDevicePollFailed;

function buildHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    originator: "parallel-agent-platform",
    "User-Agent": "parallel-agent-platform",
  };
}

function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const JsonObjectSchema = z.record(z.string(), z.unknown());

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    return JsonObjectSchema.safeParse(JSON.parse(text)).data ?? null;
  } catch {
    return null;
  }
}

function normalizeIntervalMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value * 1000);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const seconds = Number.parseInt(value.trim(), 10);
    return seconds > 0 ? seconds * 1000 : undefined;
  }
  return undefined;
}

function normalizeExpiresInMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value * 1000);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10) * 1000;
  }
  return undefined;
}

function formatErrorBody(status: number, bodyText: string): string {
  const body = parseJsonObject(bodyText);
  const error = trimNonEmptyString(body?.error);
  const description = trimNonEmptyString(body?.error_description);
  if (error && description) return `${error} (${description})`;
  if (error) return error;
  return bodyText ? `HTTP ${status} ${bodyText.slice(0, 256)}` : `HTTP ${status}`;
}

type CodexJwtPayload = Record<string, unknown>;

function decodeJwtPayload(accessToken: string): CodexJwtPayload | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const decoded = Buffer.from(parts[1] ?? "", "base64url").toString("utf8");
    return JsonObjectSchema.safeParse(JSON.parse(decoded)).data ?? null;
  } catch {
    return null;
  }
}

function objectClaim(payload: CodexJwtPayload | null, key: string): Record<string, unknown> {
  const value = payload?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function resolveCodexAuthIdentity(accessToken: string): OpenAICodexAuthIdentity {
  const payload = decodeJwtPayload(accessToken);
  const auth = objectClaim(payload, "https://api.openai.com/auth");
  const profile = objectClaim(payload, "https://api.openai.com/profile");
  const accountId = trimNonEmptyString(auth?.chatgpt_account_id);
  const chatgptPlanType = trimNonEmptyString(auth?.chatgpt_plan_type);
  const email = trimNonEmptyString(profile.email);
  return {
    ...(accountId ? { accountId } : {}),
    ...(chatgptPlanType ? { chatgptPlanType } : {}),
    ...(email ? { email } : {}),
  };
}

export function resolveCodexAccessTokenExpiry(accessToken: string): number | undefined {
  const payload = decodeJwtPayload(accessToken);
  const exp = payload?.exp;
  if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) {
    return Math.trunc(exp) * 1000;
  }
  if (typeof exp === "string" && /^\d+$/.test(exp.trim())) {
    return Number.parseInt(exp.trim(), 10) * 1000;
  }
  return undefined;
}

export async function requestOpenAICodexDeviceCode(
  fetchFn: typeof fetch = fetch,
): Promise<OpenAICodexDeviceCodeRequest> {
  const response = await fetchFn(`${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: buildHeaders("application/json"),
    body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI device code request failed: ${formatErrorBody(response.status, bodyText)}`);
  }

  const body = parseJsonObject(bodyText);
  const deviceAuthId = trimNonEmptyString(body?.device_auth_id);
  const userCode = trimNonEmptyString(body?.user_code) ?? trimNonEmptyString(body?.usercode);
  if (!deviceAuthId || !userCode) {
    throw new Error("OpenAI device code response was missing the device code or user code.");
  }

  return {
    deviceAuthId,
    userCode,
    verificationUrl: OPENAI_CODEX_DEVICE_VERIFICATION_URL,
    intervalMs: normalizeIntervalMs(body?.interval) ?? OPENAI_CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS,
    expiresInMs: OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS,
  };
}

/**
 * Poll OpenAI once for an authorization code. Web UIs poll on their own cadence
 * via the API, so this helper returns one of three outcomes rather than
 * blocking the request thread until the device flow finishes.
 */
export async function pollOpenAICodexDeviceCode(params: {
  deviceAuthId: string;
  userCode: string;
  fetchFn?: typeof fetch;
}): Promise<
  | { status: "authorized"; authorizationCode: string; codeVerifier: string }
  | { status: "pending" }
  | { status: "failed"; error: string }
> {
  const fetchFn = params.fetchFn ?? fetch;
  const response = await fetchFn(`${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: buildHeaders("application/json"),
    body: JSON.stringify({
      device_auth_id: params.deviceAuthId,
      user_code: params.userCode,
    }),
  });

  const bodyText = await response.text();
  if (response.ok) {
    const body = parseJsonObject(bodyText);
    const authorizationCode = trimNonEmptyString(body?.authorization_code);
    const codeVerifier = trimNonEmptyString(body?.code_verifier);
    if (!authorizationCode || !codeVerifier) {
      return {
        status: "failed",
        error: "OpenAI device authorization response was missing the exchange code.",
      };
    }
    return { status: "authorized", authorizationCode, codeVerifier };
  }
  if (response.status === 403 || response.status === 404) {
    return { status: "pending" };
  }
  return {
    status: "failed",
    error: `OpenAI device authorization failed: ${formatErrorBody(response.status, bodyText)}`,
  };
}

export async function exchangeOpenAICodexDeviceCode(params: {
  authorizationCode: string;
  codeVerifier: string;
  fetchFn?: typeof fetch;
}): Promise<OpenAICodexOAuthTokens> {
  const fetchFn = params.fetchFn ?? fetch;
  const response = await fetchFn(OPENAI_CODEX_TOKEN_URL, {
    method: "POST",
    headers: buildHeaders("application/x-www-form-urlencoded"),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.authorizationCode,
      redirect_uri: OPENAI_CODEX_DEVICE_CALLBACK_URL,
      client_id: OPENAI_CODEX_CLIENT_ID,
      code_verifier: params.codeVerifier,
    }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI device token exchange failed: ${formatErrorBody(response.status, bodyText)}`);
  }

  const body = parseJsonObject(bodyText);
  const access = trimNonEmptyString(body?.access_token);
  const refresh = trimNonEmptyString(body?.refresh_token);
  if (!access || !refresh) {
    throw new Error("OpenAI token exchange did not return OAuth tokens.");
  }

  const expiresInMs = normalizeExpiresInMs(body?.expires_in);
  const expires =
    expiresInMs !== undefined
      ? Date.now() + expiresInMs
      : (resolveCodexAccessTokenExpiry(access) ?? Date.now() + 3600_000);

  return { access, refresh, expires };
}

export async function refreshOpenAICodexToken(
  refreshToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<OpenAICodexOAuthTokens> {
  const response = await fetchFn(OPENAI_CODEX_TOKEN_URL, {
    method: "POST",
    headers: buildHeaders("application/x-www-form-urlencoded"),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID,
    }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI Codex token refresh failed: ${formatErrorBody(response.status, bodyText)}`);
  }

  const body = parseJsonObject(bodyText);
  const access = trimNonEmptyString(body?.access_token);
  const refresh = trimNonEmptyString(body?.refresh_token);
  if (!access || !refresh) {
    throw new Error("OpenAI Codex token refresh response was missing tokens.");
  }
  const expiresInMs = normalizeExpiresInMs(body?.expires_in);
  const expires =
    expiresInMs !== undefined
      ? Date.now() + expiresInMs
      : (resolveCodexAccessTokenExpiry(access) ?? Date.now() + 3600_000);

  return { access, refresh, expires };
}

export const DEVICE_CODE_MIN_INTERVAL_MS = OPENAI_CODEX_DEVICE_CODE_MIN_INTERVAL_MS;
