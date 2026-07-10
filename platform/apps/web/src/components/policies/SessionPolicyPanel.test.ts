import { describe, expect, it } from "vitest";
import { ApiClientError } from "../../api/client";
import {
  isSessionNotFoundError,
  sessionPoliciesRefetchInterval,
} from "../../hooks/usePolicies";

describe("isSessionNotFoundError", () => {
  it("recognizes the inactive-session API response", () => {
    const error = new ApiClientError({
      status: 404,
      code: "session_not_found",
      message: "Session was not found",
      body: {},
    });

    expect(isSessionNotFoundError(error)).toBe(true);
  });

  it("does not hide unrelated policy errors", () => {
    const error = new ApiClientError({
      status: 500,
      code: "policy_query_failed",
      message: "Could not load session policies",
      body: {},
    });

    expect(isSessionNotFoundError(error)).toBe(false);
  });

  it("keeps retrying while a session is being created", () => {
    const error = new ApiClientError({
      status: 404,
      code: "session_not_found",
      message: "Session was not found",
      body: {},
    });

    expect(sessionPoliciesRefetchInterval(error)).toBe(5000);
  });
});
