export function parseArgs(argv) {
  const parsed = {
    json: false,
    verbose: false,
    agentId: null,
    workspaceId: null,
    apiBaseUrl: process.env.PLATFORM_API_BASE_URL ?? "http://127.0.0.1:3100",
    token: process.env.PLATFORM_API_TOKEN ?? process.env.API_AUTH_TOKEN ?? null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      continue;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--verbose") {
      parsed.verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--agent-id") {
      parsed.agentId = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--agent-id=")) {
      parsed.agentId = arg.slice("--agent-id=".length);
    } else if (arg === "--workspace-id") {
      parsed.workspaceId = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--workspace-id=")) {
      parsed.workspaceId = arg.slice("--workspace-id=".length);
    } else if (arg === "--api-base-url") {
      parsed.apiBaseUrl = argv[index + 1] ?? parsed.apiBaseUrl;
      index += 1;
    } else if (arg.startsWith("--api-base-url=")) {
      parsed.apiBaseUrl = arg.slice("--api-base-url=".length);
    } else if (arg === "--api-token") {
      parsed.token = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith("--api-token=")) {
      parsed.token = arg.slice("--api-token=".length);
    }
  }

  parsed.agentId = parsed.agentId?.trim() || null;
  parsed.workspaceId = parsed.workspaceId?.trim() || null;
  parsed.apiBaseUrl = parsed.apiBaseUrl.replace(/\/$/, "");

  return parsed;
}

export function usage() {
  return `Usage: pnpm run doctor -- [options]

Options:
  --agent-id <id>       Include scoped agent diagnostics
  --workspace-id <id>   Workspace context for scoped diagnostics
  --api-base-url <url>  Platform API base URL (default: http://127.0.0.1:3100)
  --api-token <token>   Bearer token for authenticated API health endpoints
  --json                Print machine-readable output
  --verbose             Include raw scoped diagnostic payloads in JSON output
`;
}

export function authHeaders(token) {
  return token ? { authorization: `Bearer ${token}` } : {};
}

export function apiPortTarget(apiBaseUrl) {
  const url = new URL(apiBaseUrl);
  const port =
    url.port ||
    (url.protocol === "https:"
      ? "443"
      : url.protocol === "http:"
        ? "80"
        : null);

  if (!port) {
    throw new Error(`Unsupported API base URL protocol: ${url.protocol}`);
  }

  return {
    host: url.hostname,
    port: Number(port),
  };
}

export function compactJson(value) {
  if (value === undefined || value === null || value === "") return "unknown";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

export function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
