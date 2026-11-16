import { hash, verify } from "@node-rs/argon2";
import { badRequest } from "../../lib/errors.js";

/** Argon2id met aanbevolen parameters (OWASP). */
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const MIN_PASSWORD_LENGTH = 12;

export function assertPasswordPolicy(password: string) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw badRequest("weak_password", `Wachtwoord moet minimaal ${MIN_PASSWORD_LENGTH} tekens zijn`);
  }
  if (password.length > 256) throw badRequest("weak_password", "Wachtwoord is te lang");
}

export const hashPassword = (password: string) => hash(password, OPTIONS);

export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  try {
    return await verify(hashed, password);
  } catch {
    return false;
  }
}

/** Een geldige hash om tegen te verifiëren als de gebruiker niet bestaat (voorkomt timing-lekken). */
let dummyHash: Promise<string> | undefined;
export const getDummyHash = () => (dummyHash ??= hashPassword("dummy-password-for-timing"));
