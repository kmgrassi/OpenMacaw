#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const DEFAULT_AGENTS = [
  "Planning Agent",
  "Coding Agent",
  "Manager Agent",
  "Learning Agent",
  "Router Agent",
];

function parseArgs(argv) {
  const parsed = {
    appUrl: process.env.PLATFORM_WEB_BASE_URL ?? "http://127.0.0.1:5173",
    openaiApiKey: process.env.OPENAI_API_KEY ?? null,
    artifactsDir: path.join(
      rootDir,
      ".run-artifacts",
      "onboarded-agents-browser",
    ),
    timeoutMs: Number(
      process.env.ONBOARDED_AGENTS_BROWSER_TIMEOUT_MS ?? 180_000,
    ),
    headful: false,
    keepOpen: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === "--") {
      continue;
    } else if (arg === "--app-url") {
      parsed.appUrl = requireValue(arg, value);
      index += 1;
    } else if (arg.startsWith("--app-url=")) {
      parsed.appUrl = arg.slice("--app-url=".length);
    } else if (arg === "--artifacts-dir") {
      parsed.artifactsDir = requireValue(arg, value);
      index += 1;
    } else if (arg.startsWith("--artifacts-dir=")) {
      parsed.artifactsDir = arg.slice("--artifacts-dir=".length);
    } else if (arg === "--timeout-ms") {
      parsed.timeoutMs = Number(requireValue(arg, value));
      index += 1;
    } else if (arg.startsWith("--timeout-ms=")) {
      parsed.timeoutMs = Number(arg.slice("--timeout-ms=".length));
    } else if (arg === "--headful") {
      parsed.headful = true;
    } else if (arg === "--keep-open") {
      parsed.keepOpen = true;
      parsed.headful = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  parsed.appUrl = parsed.appUrl.replace(/\/$/, "");
  parsed.openaiApiKey = parsed.openaiApiKey?.trim() || null;

  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }

  return parsed;
}

function requireValue(name, value) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function usage() {
  return `Usage: OPENAI_API_KEY=... pnpm run smoke:onboarded-agents-browser -- [options]

Creates a fresh local signup account, configures the standardized agents with
the OpenAI key, opens each agent in the browser, and verifies a simple reply.

Options:
  --app-url <url>        Web app URL (default: http://127.0.0.1:5173)
  --artifacts-dir <dir>  Parent artifacts directory
  --timeout-ms <ms>      Per-agent reply timeout (default: 180000)
  --headful              Show the browser
  --keep-open            Leave the browser open after the run
  --json                 Print machine-readable output
`;
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function uniqueId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeAgentName(name) {
  return name.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function visibleText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function countToken(text, token) {
  return text.split(token).length - 1;
}

async function writeJson(filePath, value) {
  await fs.promises.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function captureScreenshot(page, artifactDir, name) {
  const filePath = path.join(artifactDir, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

async function signUp(page, options, steps) {
  const email = `agent-smoke-${uniqueId()}@example.test`;
  const password = `OpenMacaw-${uniqueId()}`;

  await page.goto(`${options.appUrl}/signup`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL((url) => url.pathname === "/onboarding", {
    timeout: options.timeoutMs,
  });

  steps.push({ step: "signedUp", email });
}

async function onboardWithOpenAI(page, options, steps) {
  await page.getByRole("button", { name: "Use a cloud model" }).click();
  await page.getByLabel("API Key").fill(options.openaiApiKey);
  await page.getByRole("button", { name: "Save key and continue" }).click();
  await page.getByRole("button", { name: "Go to dashboard" }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/dashboard/"), {
    timeout: options.timeoutMs,
  });

  steps.push({ step: "onboardedWithCloudKey", provider: "openai" });
}

async function readDashboardAgents(page) {
  const links = await page.getByRole("link").evaluateAll((nodes) =>
    nodes.map((node) => {
      const anchor = node instanceof HTMLAnchorElement ? node : null;
      return {
        name: node.textContent?.replace(/\s+/g, " ").trim() ?? "",
        href: anchor?.href ?? node.getAttribute("href") ?? "",
        title: node.getAttribute("title") ?? "",
      };
    }),
  );

  return links
    .map((link) => ({
      ...link,
      name: normalizeAgentName(link.name),
    }))
    .filter((link) => link.name && link.href);
}

async function waitForDashboardAgents(page, options) {
  for (const agentName of DEFAULT_AGENTS) {
    await page
      .getByRole("link", {
        name: new RegExp(`^${escapeRegExp(agentName)}\\b`, "i"),
      })
      .waitFor({ state: "visible", timeout: options.timeoutMs });
  }

  return readDashboardAgents(page);
}

async function openAgent(page, agentName, options) {
  const link = page.getByRole("link", {
    name: new RegExp(`^${escapeRegExp(agentName)}\\b`, "i"),
  });
  await link.waitFor({ state: "visible", timeout: options.timeoutMs });
  await link.click();
  await page.waitForURL((url) => url.pathname.startsWith("/dashboard/"), {
    timeout: options.timeoutMs,
  });
}

async function assertAgentReply(page, agentName, options) {
  if (!options.json) {
    process.stdout.write(`testing: ${agentName}\n`);
  }

  await openAgent(page, agentName, options);

  const token = `SMOKE_${agentName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${uniqueId().replace(/-/g, "")}`;
  const message = `Reply with exactly this token and no other text: ${token}`;
  const composer = page.getByPlaceholder("Type a message...");
  const sendButton = page.getByRole("button", { name: "Send" });

  await composer.waitFor({ state: "visible", timeout: options.timeoutMs });
  await sendButton.waitFor({ state: "visible", timeout: options.timeoutMs });
  await expectEnabled(page, composer, "message composer", options.timeoutMs);
  await composer.fill(message);
  await expectEnabled(page, sendButton, "send button", options.timeoutMs);
  await sendButton.click();

  await page.waitForFunction(
    ({ expectedToken }) => {
      return document.body.innerText.split(expectedToken).length - 1 >= 2;
    },
    { expectedToken: token },
    { timeout: options.timeoutMs },
  );

  return {
    agentName,
    status: "passed",
    token,
    tokenOccurrences: countToken(await page.locator("body").innerText(), token),
  };
}

async function expectEnabled(page, locator, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await locator.isEnabled().catch(() => false)) return;
    await page.waitForTimeout(250);
  }

  throw new Error(`${label} did not become enabled`);
}

async function runSmoke(options) {
  if (!options.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }

  const artifactDir = path.join(options.artifactsDir, timestampForPath());
  await fs.promises.mkdir(artifactDir, { recursive: true });

  const consoleEntries = [];
  const networkEntries = [];
  const steps = [];
  const agentResults = [];
  const failures = [];
  let browser = null;
  let context = null;
  let page = null;
  let finalScreenshot = null;
  let dashboardUrl = null;
  let status = "failed";

  try {
    browser = await chromium.launch({ headless: !options.headful });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    page = await context.newPage();
    page.setDefaultTimeout(options.timeoutMs);

    page.on("console", (message) => {
      consoleEntries.push({
        type: message.type(),
        text: message.text(),
        location: message.location(),
      });
    });
    page.on("pageerror", (error) => {
      failures.push(`page error: ${error.message}`);
    });
    page.on("requestfailed", (request) => {
      networkEntries.push({
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        failed: true,
        failure: request.failure()?.errorText ?? null,
      });
    });
    page.on("response", (response) => {
      const request = response.request();
      const summary = {
        method: request.method(),
        url: response.url(),
        status: response.status(),
        resourceType: request.resourceType(),
      };
      networkEntries.push(summary);
      const isAppRequest =
        summary.url.startsWith(options.appUrl) ||
        summary.url.startsWith("http://127.0.0.1:3100");
      const isApiLike =
        summary.resourceType === "fetch" || summary.resourceType === "xhr";
      if (isAppRequest && isApiLike && summary.status >= 500) {
        failures.push(
          `${summary.method} ${summary.url} returned ${summary.status}`,
        );
      }
    });

    await signUp(page, options, steps);
    await onboardWithOpenAI(page, options, steps);
    dashboardUrl = page.url();
    await captureScreenshot(page, artifactDir, "01-dashboard");

    const dashboardAgents = await waitForDashboardAgents(page, options);
    steps.push({ step: "dashboardAgentsRead", agents: dashboardAgents });

    const missingAgents = DEFAULT_AGENTS.filter(
      (name) => !dashboardAgents.some((agent) => agent.name.startsWith(name)),
    );
    if (missingAgents.length > 0) {
      throw new Error(
        `Dashboard missing expected agents: ${missingAgents.join(", ")}`,
      );
    }

    for (const agentName of DEFAULT_AGENTS) {
      const result = await assertAgentReply(page, agentName, options);
      agentResults.push(result);
      if (!options.json) {
        process.stdout.write(
          `passed: ${result.agentName} (${result.tokenOccurrences} token occurrences)\n`,
        );
      }
      await captureScreenshot(
        page,
        artifactDir,
        `agent-${agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      );
    }

    if (failures.length > 0) {
      throw new Error(failures[0]);
    }

    status = "passed";
    finalScreenshot = await captureScreenshot(page, artifactDir, "final");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(message);
    if (page) {
      finalScreenshot = await captureScreenshot(
        page,
        artifactDir,
        "failure",
      ).catch(() => null);
    }
  } finally {
    await writeJson(path.join(artifactDir, "console.json"), consoleEntries);
    await writeJson(path.join(artifactDir, "network.json"), networkEntries);
    if (!options.keepOpen) {
      await context?.close();
      await browser?.close();
    }
  }

  const result = {
    status,
    appUrl: options.appUrl,
    dashboardUrl,
    artifactDir,
    finalScreenshot,
    steps,
    agents: agentResults,
    failures,
    consoleErrorCount: consoleEntries.filter((entry) => entry.type === "error")
      .length,
    failedNetworkCount: networkEntries.filter((entry) => entry.failed).length,
    browserLeftOpen: Boolean(options.keepOpen),
  };
  await writeJson(path.join(artifactDir, "result.json"), result);
  return result;
}

function printHumanResult(result) {
  process.stdout.write(`browser onboarded agents smoke ${result.status}\n`);
  process.stdout.write(
    `dashboard: ${result.dashboardUrl ?? "(not reached)"}\n`,
  );
  process.stdout.write(
    `artifacts: ${path.relative(rootDir, result.artifactDir)}\n`,
  );

  for (const agent of result.agents) {
    process.stdout.write(
      `${agent.status}: ${agent.agentName} (${agent.tokenOccurrences} token occurrences)\n`,
    );
  }

  if (result.failures.length > 0) {
    process.stdout.write("\nFailures:\n");
    for (const failure of result.failures) {
      process.stdout.write(`- ${visibleText(failure)}\n`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const result = await runSmoke(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printHumanResult(result);
  }

  if (result.status !== "passed") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
