import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function fingerprintSignedWebhookPayload(rawBody: Buffer): string {
  return createHash("sha256").update(rawBody).digest("hex");
}

export function verifyGithubSignature(rawBody: Buffer, secret: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;

  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const provided = Buffer.from(signatureHeader, "utf8");
  const computed = Buffer.from(expected, "utf8");

  return provided.length === computed.length && timingSafeEqual(provided, computed);
}

export function verifyLinearSignature(rawBody: Buffer, secret: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;

  const provided = Buffer.from(signatureHeader, "hex");
  const computed = createHmac("sha256", secret).update(rawBody).digest();

  return provided.length === computed.length && timingSafeEqual(provided, computed);
}
