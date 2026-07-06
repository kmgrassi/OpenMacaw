#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs, usage } from "./lib/doctor-config.mjs";
import { runDoctorChecks } from "./lib/doctor-checks.mjs";
import { printCheckTable } from "./lib/platform-probes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
let checks = [];

async function main() {
  if (args.help) {
    console.log(usage());
    return;
  }

  const result = await runDoctorChecks({ rootDir, args });
  const { status, next } = result;
  checks = result.checks;

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          status,
          checkedAt: new Date().toISOString(),
          rootDir,
          checks,
          next,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`platform doctor: ${status}`);
    console.log("");
    printCheckTable(checks);
    console.log("");
    console.log(`next: ${next}`);
  }

  process.exitCode = status === "fail" ? 1 : 0;
}

main().catch((error) => {
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          status: "fail",
          checkedAt: new Date().toISOString(),
          rootDir,
          checks,
          next: "doctor crashed before completing checks",
          error: error.message,
        },
        null,
        2,
      ),
    );
  } else {
    console.error("platform doctor: fail");
    console.error("");
    console.error(`doctor crashed: ${error.message}`);
    console.error("");
    console.error(
      "next: inspect the doctor error above, fix it, then rerun pnpm run doctor",
    );
  }
  process.exitCode = 1;
});
