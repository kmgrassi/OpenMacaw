export function describeSignInError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");

  if (message.toLowerCase().includes("invalid login credentials")) {
    return "Email or password is incorrect. Try again or reset your password.";
  }

  return message || "Unable to sign in. Please try again.";
}
