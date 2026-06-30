#!/usr/bin/env node
// Phase-0 spike: prove the Claude Agent SDK invokes a `canUseTool` callback
// before each tool call, and that it AWAITS an async decision — i.e. the seam
// we need to (a) see what Claude Code is running and (b) gate it via an
// orchestrator round-trip.
//
// This is standalone (does NOT touch the real bridge). Run it with a key:
//
//   cd runtime/apps/orchestrator/priv/claude_agent_bridge
//   npm install                       # one-time (installs the SDK)
//   ANTHROPIC_API_KEY=sk-ant-... node canusetool-spike.mjs
//
// What to look for: a "[#N] permission request → tool=Bash/Write ..." line for
// each tool the agent tries, each followed by "decision → allow (after async
// round-trip)". If those appear, the seam works with our string-prompt form and
// we can wire it straight into bridge.js. If "canUseTool fired 0 time(s)", the
// SDK needs streaming-input mode and the bridge change is larger (noted below).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROMPT =
  "Do exactly two things and nothing else: " +
  "(1) run the shell command `echo hello-from-claude`; " +
  "(2) create a file named spike.txt containing the single word OK.";

const cwd = mkdtempSync(join(tmpdir(), "canusetool-spike-"));
const calls = [];

// THE SEAM. In the real bridge this body becomes: emit a permission-request
// event to the orchestrator and await its allow/deny decision. Here we just log
// it and sleep, to prove the SDK blocks on an async answer (duplex-capable).
const canUseTool = async (toolName, input) => {
  const n = calls.length + 1;
  console.log(`\n  [#${n}] permission request → tool=${toolName}`);
  console.log(`        input=${JSON.stringify(input).slice(0, 240)}`);
  await sleep(40); // simulate the orchestrator round-trip
  calls.push({ toolName });
  console.log(`        decision → allow (after async round-trip)`);
  return { behavior: "allow" };
};

console.log(`workspace: ${cwd}`);
console.log("running Claude Code (string prompt, isolated settings, permissionMode=default)...");

let resultText = "";
try {
  for await (const msg of query({
    prompt: PROMPT,
    options: {
      cwd,
      settingSources: [], // isolate the probe from user/project approvals
      permissionMode: "default", // so tool calls actually prompt → canUseTool fires
      canUseTool,
      maxTurns: 6,
    },
  })) {
    if (msg?.type === "assistant" && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block?.type === "text" && block.text) resultText += block.text;
      }
    }
    if (msg?.type === "result") resultText = msg.result || resultText;
  }
} catch (error) {
  console.log(`\nrun error: ${error?.message || error}`);
}

console.log("\n──────── result ────────");
console.log(`assistant: ${(resultText || "").trim().slice(0, 240)}`);
console.log(
  `canUseTool fired ${calls.length} time(s): ${calls.map((c) => c.toolName).join(", ") || "(none)"}`,
);
if (calls.length > 0) {
  console.log(
    "\n✅ Seam works: the SDK paused before each tool call and awaited our async decision.\n" +
      "   → wire this into bridge.js (emit a permission event, await the orchestrator's reply).",
  );
} else {
  console.log(
    "\n⚠️  canUseTool did not fire with a string prompt in this SDK version.\n" +
      "   → bridge.js must switch to streaming-input mode (prompt as an AsyncIterable<SDKUserMessage>).",
  );
}
