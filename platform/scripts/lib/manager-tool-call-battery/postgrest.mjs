import { normalizeUrl, parseResponse, requireValue } from "./utils.mjs";

function serviceRoleConfig() {
  const supabaseUrl = requireValue(process.env.SUPABASE_URL, "SUPABASE_URL");
  const serviceRoleKey = requireValue(
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    "SUPABASE_SERVICE_ROLE_KEY",
  );
  return { supabaseUrl, serviceRoleKey };
}

export async function postgrestGet(table, params) {
  const { supabaseUrl, serviceRoleKey } = serviceRoleConfig();
  const url = new URL(`${normalizeUrl(supabaseUrl)}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
    },
  });
  const body = await parseResponse(response);
  if (!response.ok) {
    throw new Error(
      `PostgREST ${table} failed (${response.status}): ${JSON.stringify(body)}`,
    );
  }
  return body;
}

export async function postgrestInsert(table, value) {
  const { supabaseUrl, serviceRoleKey } = serviceRoleConfig();
  const response = await fetch(
    `${normalizeUrl(supabaseUrl)}/rest/v1/${table}`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        "content-type": "application/json",
        prefer: "return=representation",
      },
      body: JSON.stringify(value),
    },
  );
  const body = await parseResponse(response);
  if (!response.ok) {
    throw new Error(
      `PostGREST ${table} insert failed (${response.status}): ${JSON.stringify(body)}`,
    );
  }
  return Array.isArray(body) ? body : [];
}

export async function postgrestPatch(table, params, value) {
  const { supabaseUrl, serviceRoleKey } = serviceRoleConfig();
  const url = new URL(`${normalizeUrl(supabaseUrl)}/rest/v1/${table}`);
  for (const [key, paramValue] of Object.entries(params)) {
    url.searchParams.set(key, paramValue);
  }
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(value),
  });
  const body = await parseResponse(response);
  if (!response.ok) {
    throw new Error(
      `PostGREST ${table} patch failed (${response.status}): ${JSON.stringify(body)}`,
    );
  }
  return body;
}
