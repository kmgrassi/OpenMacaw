import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@kmgrassi/supabase-schema";

const DEFAULT_PROD_SUPABASE_URL = "";
const DEFAULT_PROD_SUPABASE_ANON_KEY = "";

function resolveSupabaseConfig() {
  const selectedEnv = import.meta.env.VITE_SUPABASE_ENV?.trim().toLowerCase();

  if (selectedEnv === "dev") {
    return {
      envName: "dev",
      url:
        import.meta.env.VITE_SUPABASE_DEV_URL?.trim() ||
        import.meta.env.VITE_SUPABASE_URL?.trim() ||
        DEFAULT_PROD_SUPABASE_URL,
      anonKey:
        import.meta.env.VITE_SUPABASE_DEV_ANON_KEY?.trim() ||
        import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ||
        DEFAULT_PROD_SUPABASE_ANON_KEY,
    };
  }

  if (selectedEnv === "prod") {
    return {
      envName: "prod",
      url:
        import.meta.env.VITE_SUPABASE_PROD_URL?.trim() ||
        import.meta.env.VITE_SUPABASE_URL?.trim() ||
        DEFAULT_PROD_SUPABASE_URL,
      anonKey:
        import.meta.env.VITE_SUPABASE_PROD_ANON_KEY?.trim() ||
        import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ||
        DEFAULT_PROD_SUPABASE_ANON_KEY,
    };
  }

  return {
    envName: "default",
    url: import.meta.env.VITE_SUPABASE_URL?.trim() || DEFAULT_PROD_SUPABASE_URL,
    anonKey:
      import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ||
      DEFAULT_PROD_SUPABASE_ANON_KEY,
  };
}

let client: SupabaseClient<Database> | null = null;

export class SupabaseConfigError extends Error {
  readonly code = "supabase_config_missing";

  constructor(message = supabaseConfigMissingMessage()) {
    super(message);
    this.name = "SupabaseConfigError";
  }
}

function supabaseProjectRefFromUrl(urlString: string): string {
  // Preferred path: pull the `<ref>` out of `<ref>.supabase.co`. Matches the
  // hosted-Supabase project URL pattern and keeps the storageKey short.
  try {
    const hostname = new URL(urlString).hostname.toLowerCase();
    const match = hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i);
    if (match?.[1]) return match[1];

    // Fallback for custom domains / local Supabase / anything that isn't
    // `<ref>.supabase.co`. If we returned a constant here (e.g. "unknown"),
    // two distinct non-`supabase.co` backends under the same
    // `VITE_SUPABASE_ENV` would collapse to the same storageKey — which
    // is exactly the stale-session-reuse bug this function is supposed
    // to prevent. Use a sanitized hostname instead so every distinct
    // backend gets its own key.
    return hostname.replace(/[^a-z0-9-]/g, "-") || "unknown";
  } catch {
    // URL couldn't even be parsed. Derive a stable-but-collision-resistant
    // identifier from the raw string so different malformed URLs still
    // get different keys.
    return (
      `raw-${urlString
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "-")
        .slice(0, 48)}` || "unknown"
    );
  }
}

function supabaseStorageKey() {
  const config = resolveSupabaseConfig();
  const projectRef = supabaseProjectRefFromUrl(config.url);
  return {
    envName: config.envName,
    projectRef,
    storageKey: `sb-${config.envName}-${projectRef}-auth-token`,
    url: config.url,
    anonKey: config.anonKey,
  };
}

function supabaseConfigMissingMessage() {
  return "Supabase is not configured. Set the Supabase URL and anon key in platform/.env, then restart ./openmacaw run.";
}

export function getSupabaseConfigStatus() {
  const config = supabaseStorageKey();
  const missing = [];

  if (!config.url) missing.push("Supabase URL");
  if (!config.anonKey) missing.push("Supabase anon key");

  return {
    ...config,
    configured: missing.length === 0,
    missing,
    message: missing.length > 0 ? supabaseConfigMissingMessage() : null,
  };
}

function isSupabaseAuthStorageKey(key: string): boolean {
  return /^sb-[a-z0-9-]+-auth-token$/i.test(key);
}

function clearSupabaseAuthStorage(shouldRemove: (key: string) => boolean) {
  if (typeof window === "undefined") return;
  try {
    const storage = window.localStorage;
    for (const key of Object.keys(storage)) {
      if (isSupabaseAuthStorageKey(key) && shouldRemove(key)) {
        storage.removeItem(key);
      }
    }
  } catch {
    // Some browser contexts block Web Storage entirely. Auth should still
    // proceed using Supabase's in-memory fallback instead of failing at boot.
  }
}

export function clearOtherSupabaseAuthStorage() {
  const { storageKey } = supabaseStorageKey();
  clearSupabaseAuthStorage((key) => key !== storageKey);
}

export function clearAllSupabaseAuthStorage() {
  clearSupabaseAuthStorage(() => true);
}

export function getSupabaseClient() {
  if (!client) {
    const config = getSupabaseConfigStatus();
    if (!config.configured) {
      throw new SupabaseConfigError(config.message ?? undefined);
    }
    clearOtherSupabaseAuthStorage();
    console.info(
      `[client-auth] Supabase env=${config.envName} project_ref=${config.projectRef}`,
    );
    // Namespace the localStorage key by env + project ref so tokens from a
    // prior `VITE_SUPABASE_ENV` (or different Supabase project) at this
    // origin never get reused by the current session. Without this, flipping
    // dev ↔ prod at the same origin (e.g. http://127.0.0.1:5173) could
    // leave a stale token that the API then validates against the wrong
    // project — the signature check fails and requests look like bad auth
    // rather than a stale session.
    client = createClient<Database>(config.url, config.anonKey, {
      auth: {
        storageKey: config.storageKey,
      },
    });
  }
  return client;
}

export async function getSupabaseAccessToken(): Promise<string> {
  const { data, error } = await getSupabaseClient().auth.getSession();
  const token = data.session?.access_token?.trim();
  if (error || !token) {
    throw error || new Error("No Supabase access token available");
  }
  return token;
}
