import { describe, expect, it } from "vitest";

import { resolveCodexAccessTokenExpiry, resolveCodexAuthIdentity } from "./openai-codex.js";

function jwtWithPayload(payload: unknown) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

describe("openai codex oauth typing boundaries", () => {
  it("extracts identity fields only when the jwt payload shape matches expectations", () => {
    const token = jwtWithPayload({
      "https://api.openai.com/profile": {
        email: "dev@example.com",
      },
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_123",
        chatgpt_plan_type: "pro",
      },
    });

    expect(resolveCodexAuthIdentity(token)).toEqual({
      accountId: "acct_123",
      chatgptPlanType: "pro",
      email: "dev@example.com",
    });
  });

  it("ignores malformed nested jwt fields instead of treating them as typed objects", () => {
    const token = jwtWithPayload({
      "https://api.openai.com/profile": "not-an-object",
      "https://api.openai.com/auth": ["unexpected"],
    });

    expect(resolveCodexAuthIdentity(token)).toEqual({});
  });

  it("parses expiry from number and numeric-string jwt claims", () => {
    const numericToken = jwtWithPayload({ exp: 1_725_000_000 });
    const stringToken = jwtWithPayload({ exp: "1725000001" });

    expect(resolveCodexAccessTokenExpiry(numericToken)).toBe(1_725_000_000_000);
    expect(resolveCodexAccessTokenExpiry(stringToken)).toBe(1_725_000_001_000);
  });

  it("rejects non-numeric expiry claims", () => {
    const token = jwtWithPayload({ exp: { seconds: 60 } });

    expect(resolveCodexAccessTokenExpiry(token)).toBeUndefined();
  });
});
