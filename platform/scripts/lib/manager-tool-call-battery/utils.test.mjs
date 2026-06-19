import assert from "node:assert/strict";
import test from "node:test";
import { evidenceText } from "./utils.mjs";

test("evidenceText exposes command hints from JSON-encoded argv output", () => {
  const text = evidenceText({
    input: {
      call_id: "call_git_status",
      input: {
        id: "call_git_status",
        name: "git.run",
      },
      tool_name: "git.run",
    },
    output: {
      output: {
        attempt: 1,
        output: JSON.stringify({
          argv: ["git", "status", "--short"],
          cwd: "/tmp/openmacaw",
          exit_code: 0,
          ok: true,
          tool: "git.run",
          tool_call_id: "call_git_status",
        }),
        success: true,
        tool_call_id: "call_git_status",
        tool_name: "git.run",
      },
      status: "ok",
    },
  });

  assert.match(text, /git status --short/);
});

test("evidenceText exposes joined primitive arrays in structured evidence", () => {
  const text = evidenceText({ argv: ["pnpm", "test", "--filter", "api"] });

  assert.match(text, /pnpm test --filter api/);
});
