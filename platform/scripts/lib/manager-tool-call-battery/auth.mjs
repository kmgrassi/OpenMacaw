import { normalizeUrl, parseResponse, requireValue } from "./utils.mjs";

export async function resolveAccessToken(args) {
  if (args.token) return args.token;

  const supabaseUrl = requireValue(
    process.env.SUPABASE_URL || process.env.VITE_SUPABASE_DEV_URL,
    "SUPABASE_URL",
  );
  const envName = (process.env.VITE_SUPABASE_ENV || "dev").trim();
  const anonKey =
    envName === "prod"
      ? process.env.VITE_SUPABASE_PROD_ANON_KEY ||
        process.env.VITE_SUPABASE_DEV_ANON_KEY
      : process.env.VITE_SUPABASE_DEV_ANON_KEY ||
        process.env.VITE_SUPABASE_PROD_ANON_KEY;
  const email =
    process.env.OPENMACAW_TEST_EMAIL ||
    (envName === "prod"
      ? process.env.VITE_PROD_LOGIN_EMAIL
      : process.env.VITE_DEV_LOGIN_EMAIL);
  const password =
    process.env.OPENMACAW_TEST_PASSWORD ||
    (envName === "prod"
      ? process.env.VITE_PROD_LOGIN_PASSWORD
      : process.env.VITE_DEV_LOGIN_PASSWORD);

  requireValue(anonKey, "VITE_SUPABASE_DEV_ANON_KEY or --api-token");
  requireValue(
    email,
    "VITE_DEV_LOGIN_EMAIL/OPENMACAW_TEST_EMAIL or --api-token",
  );
  requireValue(
    password,
    "VITE_DEV_LOGIN_PASSWORD/OPENMACAW_TEST_PASSWORD or --api-token",
  );

  const response = await fetch(
    `${normalizeUrl(supabaseUrl)}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        apikey: anonKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    },
  );
  const body = await parseResponse(response);
  if (!response.ok || !body.access_token) {
    throw new Error(`Supabase sign-in failed (${response.status})`);
  }
  return body.access_token;
}
