import { describe, expect, it } from "vitest";

import { ApiRouteError } from "../http.js";
import { assertLocalCodingToolsUseRuntimeTarget, hasLocalCodingTool } from "./local-coding-execution-target.js";

describe("assertLocalCodingToolsUseRuntimeTarget", () => {
  it("rejects local coding tools configured for Platform database execution", () => {
    expect(() =>
      assertLocalCodingToolsUseRuntimeTarget([
        {
          id: "tool-1",
          slug: "shell.exec",
          executionKind: "database",
          runnerKind: "planner",
        },
      ]),
    ).toThrow(ApiRouteError);
  });

  it("allows local coding tools configured for the local model coding runner", () => {
    expect(() =>
      assertLocalCodingToolsUseRuntimeTarget([
        {
          id: "tool-1",
          slug: "apply_patch",
          executionKind: "filesystem",
          runnerKind: "local_model_coding",
        },
      ]),
    ).not.toThrow();
  });

  it("allows git.run to use non-helper filesystem execution", () => {
    expect(hasLocalCodingTool([{ slug: "git.run" }])).toBe(true);
    expect(() =>
      assertLocalCodingToolsUseRuntimeTarget([
        {
          id: "tool-2",
          slug: "git.run",
          executionKind: "filesystem",
          runnerKind: "local_relay",
        },
      ]),
    ).not.toThrow();
  });

  it("rejects git.run configured for Platform database execution", () => {
    expect(() =>
      assertLocalCodingToolsUseRuntimeTarget([
        {
          id: "tool-2",
          slug: "git.run",
          executionKind: "database",
          runnerKind: "planner",
        },
      ]),
    ).toThrow(ApiRouteError);
  });
});

describe("hasLocalCodingTool", () => {
  it("returns false when there are no tools", () => {
    expect(hasLocalCodingTool([])).toBe(false);
  });

  it("returns false when no tool slug is a local coding slug", () => {
    expect(hasLocalCodingTool([{ slug: "db.query.run" }, { slug: "http.fetch" }])).toBe(false);
  });

  it("returns true when at least one tool slug is a local coding slug", () => {
    expect(hasLocalCodingTool([{ slug: "db.query.run" }, { slug: "shell.exec" }])).toBe(true);
    expect(hasLocalCodingTool([{ slug: "apply_patch" }])).toBe(true);
    expect(hasLocalCodingTool([{ slug: "shell.exec" }])).toBe(true);
  });
});
