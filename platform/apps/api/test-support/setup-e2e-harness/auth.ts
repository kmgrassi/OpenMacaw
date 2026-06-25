import { generateKeyPairSync } from "node:crypto";
import type { IncomingMessage } from "node:http";

import jwt from "jsonwebtoken";

import { TEST_USER_ID } from "./types.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

export const publicJwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "setup-e2e-kid",
  alg: "RS256",
  use: "sig",
};

export function createTestToken() {
  return jwt.sign({ email: "seeded@example.com", role: "authenticated" }, privateKey, {
    algorithm: "RS256",
    keyid: "setup-e2e-kid",
    issuer: `${process.env.SUPABASE_URL}/auth/v1`,
    audience: "authenticated",
    subject: TEST_USER_ID,
    expiresIn: "5m",
  });
}

export function restoreEnv(previousEnv: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

export function authorize(req: IncomingMessage) {
  return req.headers.authorization === `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`;
}
