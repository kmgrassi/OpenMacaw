import { describe, expect, it } from "vitest";

import { describeSignInError } from "./auth-error";

describe("describeSignInError", () => {
  it("gives invalid credentials a clear, actionable message", () => {
    expect(describeSignInError(new Error("Invalid login credentials"))).toBe(
      "Email or password is incorrect. Try again or reset your password.",
    );
  });

  it("preserves other sign-in errors", () => {
    expect(describeSignInError(new Error("Network request failed"))).toBe(
      "Network request failed",
    );
  });
});
