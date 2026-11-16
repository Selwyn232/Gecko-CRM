import type { ActorContext } from "../lib/context.js";
import type { User } from "../modules/auth/schema.js";

/**
 * Toegangsniveau per route (via `config.auth`):
 * - "public": geen login nodig
 * - "password": ingelogd met wachtwoord, 2FA mag nog ontbreken (alleen voor 2FA-instelling/verificatie)
 * - "full" (standaard): ingelogd én 2FA geverifieerd
 */
export type AuthLevel = "public" | "password" | "full";

export interface AuthState {
  sessionId: string;
  user: User;
  mfaVerified: boolean;
}

declare module "fastify" {
  interface FastifyContextConfig {
    auth?: AuthLevel;
  }
  interface FastifyRequest {
    auth: AuthState | null;
    actor: ActorContext;
  }
}
