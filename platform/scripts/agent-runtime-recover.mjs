#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveAccessToken } from "./lib/manager-tool-call-battery/api.mjs";
import { loadEnvFile, normalizeUrl, parseResponse, requireArgValue, requireValue } from "./lib/manager-tool-call-battery/utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const platformRoot = path.resolve(__dirname, "..");
loadPlatformEnv();
const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (args.json) {
    console.log(JSON.stringify({ status: "failed", error: message }, null, 2));
  } else {
    console.error(`agent runtime recover failed: ${message}`);
  }
  process.exitCode = 1;
});

async function main() {
  if (args.help) {
    printHelp();
    return;
  }

  const agentId = requireValue(args.agentId, "agentId");
  const workspaceId = requireValue(args.workspaceId, "workspaceId");
  const apiBaseUrl = normalizeUrl(args.apiBaseUrl ?? "http://127.0.0.1:3100");
  const token = await resolveAccessToken({ token: args.token });

  const response = await fetch(`${apiBaseUrl}/api/agents/${encodeURIComponent(agentId)}/runtime/recover`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      workspaceId,
      mode: args.mode,
      reason: args.reason,
    }),
  });
  const body = await parseResponse(response);
  if (!response.ok) {
    throw new Error(`recover failed (${response.status}): ${JSON.stringify(body)}`);
  }

  if (args.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  console.log(`agent runtime recover ${body.status}`);
  console.log(`agent: ${body.agentId}`);
  console.log(`workspace: ${body.workspaceId}`);
  console.log(`mode: ${body.mode}`);
  console.log(`stopped: ${body.stoppedCount}`);
  if (body.restarted?.id) console.log(`restarted: ${body.restarted.id}`);
}

function loadPlatformEnv() {
  loadEnvFile(path.join(platformRoot, ".env"));
  loadEnvFile(path.join(platformRoot, "apps/api/.env"));
  loadEnvFile(path.join(platformRoot, "apps/web/.env"));
  loadEnvFile(path.join(platformRoot, "apps/web/.env.local"));
}

function parseArgs(argv) {
  const parsed = {
    agentId: process.env.OPENMACAW_AGENT_ID ?? process.env.MANAGER_AGENT_ID ?? null,
    workspaceId: process.env.OPENMACAW_WORKSPACE_ID ?? process.env.MANAGER_WORKSPACE_ID ?? null,
    apiBaseUrl: process.env.OPENMACAW_API_BASE_URL ?? process.env.PLATFORM_API_BASE_URL ?? null,
    token: process.env.OPENMACAW_ACCESS_TOKEN ?? process.env.PLATFORM_API_TOKEN ?? null,
    mode: "restart_runtime",
    reason: null,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    else if (arg === "--agent-id") parsed.agentId = requireArgValue(arg, argv[++index]);
    else if (arg.startsWith("--agent-id=")) parsed.agentId = arg.slice("--agent-id=".length);
    else if (arg === "--workspace-id") parsed.workspaceId = requireArgValue(arg, argv[++index]);
    else if (arg.startsWith("--workspace-id=")) parsed.workspaceId = arg.slice("--workspace-id=".length);
    else if (arg === "--api-base-url") parsed.apiBaseUrl = requireArgValue(arg, argv[++index]);
    else if (arg.startsWith("--api-base-url=")) parsed.apiBaseUrl = arg.slice("--api-base-url=".length);
    else if (arg === "--api-token") parsed.token = requireArgValue(arg, argv[++index]);
    else if (arg.startsWith("--api-token=")) parsed.token = arg.slice("--api-token=".length);
    else if (arg === "--mode") parsed.mode = requireArgValue(arg, argv[++index]);
    else if (arg.startsWith("--mode=")) parsed.mode = arg.slice("--mode=".length);
    else if (arg === "--reason") parsed.reason = requireArgValue(arg, argv[++index]);
    else if (arg.startsWith("--reason=")) parsed.reason = arg.slice("--reason=".length);
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!["restart_runtime", "stop_runtime", "full_recover"].includes(parsed.mode)) {
    throw new Error("--mode must be restart_runtime, stop_runtime, or full_recover");
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage:
  pnpm run agent:runtime:recover -- --agent-id <id> --workspace-id <id>
  pnpm run agent:runtime:recover -- --agent-id <id> --workspace-id <id> --api-base-url https://api.example.com

Options:
  --mode <mode>         restart_runtime, stop_runtime, or full_recover. Default: restart_runtime.
  --reason <text>       Human-readable audit reason sent to the API.
  --api-base-url <url>  Platform API URL. Defaults to OPENMACAW_API_BASE_URL or localhost.
  --api-token <token>   Bearer token. Otherwise signs in using local env login values.
  --json                Print JSON only.
`);
}
