import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  fingerprintSignedWebhookPayload,
  isRecentLinearWebhookTimestamp,
  normalizeGitHubWebhook,
  normalizeLinearWebhook,
  normalizeManualWorkItem,
  verifyGithubSignature,
  verifyLinearSignature,
} from "./work-item-ingest.js";

const routing = {
  defaultWorkspaceId: "workspace-default",
  githubRepoWorkspaceMap: {
    "acme/widgets": "workspace-github",
  },
  linearProjectWorkspaceMap: {
    "project-1": "workspace-linear-project",
  },
  linearTeamWorkspaceMap: {
    "team-1": "workspace-linear-team",
  },
};

describe("work-item ingest helpers", () => {
  it("normalizes manual work items", () => {
    const normalized = normalizeManualWorkItem({
      workspaceId: "workspace-1",
      title: " Investigate flaky test ",
      description: " Happens on CI ",
      labels: ["bug", " ci "],
      metadata: {
        url: "https://example.com/items/123",
      },
      priority: "High",
    });

    expect(normalized.source).toBe("api");
    expect(normalized.title).toBe("Investigate flaky test");
    expect(normalized.description).toBe("Happens on CI");
    expect(normalized.labels).toEqual(["bug", "ci"]);
    expect(normalized.priority).toBe("high");
    expect(normalized.metadata.url).toBe("https://example.com/items/123");
    expect(normalized.externalId.startsWith("api:")).toBe(true);
  });

  it("normalizes GitHub issue payloads", () => {
    const normalized = normalizeGitHubWebhook(
      {
        eventName: "issues",
        deliveryId: "delivery-1",
        action: "opened",
        payload: {
          repository: {
            full_name: "acme/widgets",
            html_url: "https://github.com/acme/widgets",
          },
          issue: {
            number: 42,
            title: "Fix race condition",
            body: "Repro steps",
            html_url: "https://github.com/acme/widgets/issues/42",
            node_id: "ISSUE_node",
            state: "open",
            labels: [{ name: "bug" }, { name: "urgent" }],
          },
        },
      },
      routing,
    );

    expect(normalized).not.toBeNull();
    expect(normalized?.workspaceId).toBe("workspace-github");
    expect(normalized?.externalId).toBe("acme/widgets:issue:42");
    expect(normalized?.state).toBe("todo");
    expect(normalized?.labels).toEqual(["bug", "urgent"]);
    expect(normalized?.metadata.url).toBe("https://github.com/acme/widgets/issues/42");
  });

  it("keeps closed GitHub issues in done state on follow-up events", () => {
    const normalized = normalizeGitHubWebhook(
      {
        eventName: "issues",
        deliveryId: "delivery-2",
        action: "edited",
        payload: {
          repository: {
            full_name: "acme/widgets",
          },
          issue: {
            number: 77,
            title: "Document PL-4 follow-up",
            html_url: "https://github.com/acme/widgets/issues/77",
            state: "closed",
            labels: [],
          },
        },
      },
      routing,
    );

    expect(normalized?.state).toBe("done");
  });

  it("normalizes Linear issue payloads using project routing", () => {
    const normalized = normalizeLinearWebhook(
      {
        eventName: "Issue",
        deliveryId: "linear-delivery",
        payload: {
          action: "update",
          type: "Issue",
          url: "https://linear.app/acme/issue/ENG-101/fix-race-condition",
          data: {
            id: "issue-1",
            identifier: "ENG-101",
            title: "Fix race condition",
            description: "Investigate worker startup",
            priority: 2,
            labels: {
              nodes: [{ name: "backend" }],
            },
            state: {
              type: "started",
              name: "In Progress",
            },
            team: {
              id: "team-1",
              key: "ENG",
              name: "Engineering",
            },
            project: {
              id: "project-1",
              name: "Launcher Integration",
            },
          },
        },
      },
      routing,
    );

    expect(normalized).not.toBeNull();
    expect(normalized?.workspaceId).toBe("workspace-linear-project");
    expect(normalized?.externalId).toBe("issue:issue-1");
    expect(normalized?.state).toBe("in_progress");
    expect(normalized?.priority).toBe("high");
    expect(normalized?.labels).toEqual(["backend"]);
    expect(normalized?.metadata.identifier).toBe("ENG-101");
  });

  it("verifies GitHub webhook signatures", () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }));
    const secret = "github-secret";
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

    expect(fingerprintSignedWebhookPayload(body)).toHaveLength(64);
    expect(verifyGithubSignature(body, secret, signature)).toBe(true);
    expect(verifyGithubSignature(body, secret, "sha256=deadbeef")).toBe(false);
  });

  it("verifies Linear webhook signatures and timestamp freshness", () => {
    const body = Buffer.from(JSON.stringify({ hello: "world" }));
    const secret = "linear-secret";
    const signature = createHmac("sha256", secret).update(body).digest("hex");

    expect(verifyLinearSignature(body, secret, signature)).toBe(true);
    expect(verifyLinearSignature(body, secret, "deadbeef")).toBe(false);
    expect(isRecentLinearWebhookTimestamp(Date.now())).toBe(true);
    expect(isRecentLinearWebhookTimestamp(Date.now() - 120_000)).toBe(false);
  });
});
