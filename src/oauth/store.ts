import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export interface StoredOAuthClient {
  clientId: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none";
  grantTypes: Array<"authorization_code" | "refresh_token">;
  responseTypes: ["code"];
  clientName: string;
  scope: string;
  issuedAt: number;
  authorizedAt?: number;
}

export interface StoredInteraction {
  key: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  resource: string;
  scopes: string[];
  csrfHash: string;
  sessionHash?: string;
  expiresAt: number;
}

export interface StoredAuthorizationCode {
  key: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: string[];
  grantId: string;
  expiresAt: number;
  usedAt?: number;
}

export interface StoredAccessToken {
  key: string;
  clientId: string;
  resource: string;
  scopes: string[];
  grantId: string;
  expiresAt: number;
  revokedAt?: number;
}

export interface StoredRefreshToken {
  key: string;
  clientId: string;
  resource: string;
  scopes: string[];
  grantId: string;
  expiresAt: number;
  status: "active" | "used" | "revoked";
  replacedAt?: number;
}

export interface StoredAdminSession {
  key: string;
  username: string;
  expiresAt: number;
}

interface OAuthStoreData {
  version: 1;
  clients: StoredOAuthClient[];
  interactions: StoredInteraction[];
  authorizationCodes: StoredAuthorizationCode[];
  accessTokens: StoredAccessToken[];
  refreshTokens: StoredRefreshToken[];
  adminSessions: StoredAdminSession[];
}

const emptyStore = (): OAuthStoreData => ({
  version: 1,
  clients: [],
  interactions: [],
  authorizationCodes: [],
  accessTokens: [],
  refreshTokens: [],
  adminSessions: [],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseStore(value: unknown): OAuthStoreData {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("Unsupported or invalid OAuth store format.");
  }

  const arrayFields = [
    "clients",
    "interactions",
    "authorizationCodes",
    "accessTokens",
    "refreshTokens",
    "adminSessions",
  ] as const;
  for (const field of arrayFields) {
    if (!Array.isArray(value[field])) {
      throw new Error(`Invalid OAuth store field: ${field}.`);
    }
  }

  // Records are validated again when they are consumed. This strict top-level
  // check makes a truncated or unrelated file fail closed at startup.
  return value as unknown as OAuthStoreData;
}

export function hashOAuthSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function randomOAuthSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Durable store for a single Node.js process. Every mutation is synchronously
 * persisted through a same-directory temporary file, so an OAuth response is
 * never returned before its backing state reaches disk.
 */
export class OAuthStore {
  private data: OAuthStoreData;

  constructor(private readonly filePath: string) {
    if (existsSync(filePath)) {
      try {
        this.data = parseStore(JSON.parse(readFileSync(filePath, "utf8")) as unknown);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Unable to load OAuth store: ${message}`);
      }
      this.purgeExpired(Date.now());
    } else {
      this.data = emptyStore();
      this.persist();
    }
  }

  getDynamicClient(clientId: string): StoredOAuthClient | undefined {
    const client = this.data.clients.find((entry) => entry.clientId === clientId);
    if (
      !client ||
      (client.authorizedAt === undefined && client.issuedAt * 1_000 <= Date.now() - 60 * 60 * 1_000)
    ) {
      return undefined;
    }
    return clone(client);
  }

  countDynamicClients(): number {
    const cutoff = Date.now() - 60 * 60 * 1_000;
    return this.data.clients.filter(
      (client) => client.authorizedAt !== undefined || client.issuedAt * 1_000 > cutoff,
    ).length;
  }

  addDynamicClient(client: Omit<StoredOAuthClient, "clientId" | "issuedAt">): StoredOAuthClient {
    const stored: StoredOAuthClient = {
      ...clone(client),
      clientId: `dcr_${randomOAuthSecret(24)}`,
      issuedAt: Math.floor(Date.now() / 1_000),
    };
    this.data.clients.push(stored);
    this.persist();
    return clone(stored);
  }

  markDynamicClientAuthorized(clientId: string, authorizedAt: number): void {
    const client = this.data.clients.find((entry) => entry.clientId === clientId);
    if (!client || client.authorizedAt !== undefined) return;
    client.authorizedAt = authorizedAt;
    this.persist();
  }

  createInteraction(
    interaction: Omit<StoredInteraction, "key" | "csrfHash">,
  ): { interaction: string; csrf: string } {
    const interactionSecret = randomOAuthSecret();
    const csrf = randomOAuthSecret();
    this.data.interactions.push({
      ...clone(interaction),
      key: hashOAuthSecret(interactionSecret),
      csrfHash: hashOAuthSecret(csrf),
    });
    this.persist();
    return { interaction: interactionSecret, csrf };
  }

  getInteraction(secret: string): StoredInteraction | undefined {
    const key = hashOAuthSecret(secret);
    return clone(this.data.interactions.find((entry) => entry.key === key));
  }

  rotateInteractionCsrf(
    secret: string,
    expectedCsrf?: string,
    session?: string,
  ): string | undefined {
    const key = hashOAuthSecret(secret);
    const record = this.data.interactions.find((entry) => entry.key === key);
    if (
      !record ||
      record.expiresAt <= Date.now() ||
      (expectedCsrf !== undefined && record.csrfHash !== hashOAuthSecret(expectedCsrf)) ||
      (session !== undefined && record.sessionHash !== hashOAuthSecret(session))
    ) {
      return undefined;
    }
    const nextCsrf = randomOAuthSecret();
    record.csrfHash = hashOAuthSecret(nextCsrf);
    this.persist();
    return nextCsrf;
  }

  bindInteractionToSession(secret: string, csrf: string, session: string): string | undefined {
    const key = hashOAuthSecret(secret);
    const record = this.data.interactions.find((entry) => entry.key === key);
    if (!record || record.csrfHash !== hashOAuthSecret(csrf) || record.expiresAt <= Date.now()) {
      return undefined;
    }
    const nextCsrf = randomOAuthSecret();
    record.sessionHash = hashOAuthSecret(session);
    record.csrfHash = hashOAuthSecret(nextCsrf);
    this.persist();
    return nextCsrf;
  }

  consumeInteraction(
    secret: string,
    csrf: string,
    session: string,
  ): StoredInteraction | undefined {
    const key = hashOAuthSecret(secret);
    const index = this.data.interactions.findIndex((entry) => entry.key === key);
    const record = this.data.interactions[index];
    if (
      !record ||
      record.expiresAt <= Date.now() ||
      record.csrfHash !== hashOAuthSecret(csrf) ||
      record.sessionHash !== hashOAuthSecret(session)
    ) {
      return undefined;
    }
    this.data.interactions.splice(index, 1);
    this.persist();
    return clone(record);
  }

  createSession(username: string, expiresAt: number): string {
    const secret = randomOAuthSecret();
    this.data.adminSessions.push({
      key: hashOAuthSecret(secret),
      username,
      expiresAt,
    });
    this.persist();
    return secret;
  }

  getSession(secret: string): StoredAdminSession | undefined {
    const key = hashOAuthSecret(secret);
    return clone(
      this.data.adminSessions.find(
        (entry) => entry.key === key && entry.expiresAt > Date.now(),
      ),
    );
  }

  deleteSession(secret: string): void {
    const key = hashOAuthSecret(secret);
    const before = this.data.adminSessions.length;
    this.data.adminSessions = this.data.adminSessions.filter((entry) => entry.key !== key);
    if (this.data.adminSessions.length !== before) this.persist();
  }

  createAuthorizationCode(
    input: Omit<StoredAuthorizationCode, "key" | "grantId">,
  ): string {
    const secret = randomOAuthSecret();
    this.data.authorizationCodes.push({
      ...clone(input),
      key: hashOAuthSecret(secret),
      grantId: randomUUID(),
    });
    this.persist();
    return secret;
  }

  getAuthorizationCode(secret: string): StoredAuthorizationCode | undefined {
    const key = hashOAuthSecret(secret);
    return clone(this.data.authorizationCodes.find((entry) => entry.key === key));
  }

  consumeAuthorizationCodeAndIssue(
    secret: string,
    usedAt: number,
    accessSecret: string,
    access: Omit<StoredAccessToken, "key" | "grantId">,
    refresh?: {
      secret: string;
      record: Omit<StoredRefreshToken, "key" | "grantId">;
    },
  ): boolean {
    const key = hashOAuthSecret(secret);
    const record = this.data.authorizationCodes.find((entry) => entry.key === key);
    if (!record || record.usedAt !== undefined || record.expiresAt <= usedAt) return false;
    record.usedAt = usedAt;
    this.addAccessToken({ ...clone(access), grantId: record.grantId }, accessSecret);
    if (refresh) {
      this.addRefreshToken(
        { ...clone(refresh.record), grantId: record.grantId },
        refresh.secret,
      );
    }
    this.persist();
    return true;
  }

  addAccessToken(input: Omit<StoredAccessToken, "key">, secret: string): void {
    this.data.accessTokens.push({ ...clone(input), key: hashOAuthSecret(secret) });
  }

  addRefreshToken(input: Omit<StoredRefreshToken, "key">, secret: string): void {
    this.data.refreshTokens.push({ ...clone(input), key: hashOAuthSecret(secret) });
  }

  persistIssuedTokens(): void {
    this.persist();
  }

  getAccessToken(secret: string): StoredAccessToken | undefined {
    const key = hashOAuthSecret(secret);
    return clone(this.data.accessTokens.find((entry) => entry.key === key));
  }

  getRefreshToken(secret: string): StoredRefreshToken | undefined {
    const key = hashOAuthSecret(secret);
    return clone(this.data.refreshTokens.find((entry) => entry.key === key));
  }

  rotateRefreshToken(
    oldSecret: string,
    access: Omit<StoredAccessToken, "key">,
    refresh: Omit<StoredRefreshToken, "key">,
    nextAccessSecret: string,
    nextRefreshSecret: string,
    now: number,
  ): "rotated" | "reused" | "invalid" {
    const key = hashOAuthSecret(oldSecret);
    const current = this.data.refreshTokens.find((entry) => entry.key === key);
    if (!current || current.expiresAt <= now || current.status === "revoked") return "invalid";
    if (current.status === "used") {
      this.revokeGrantInMemory(current.grantId, now);
      this.persist();
      return "reused";
    }
    current.status = "used";
    current.replacedAt = now;
    this.addAccessToken(access, nextAccessSecret);
    this.addRefreshToken(refresh, nextRefreshSecret);
    this.persist();
    return "rotated";
  }

  revokeToken(secret: string, clientId: string, now: number): void {
    const key = hashOAuthSecret(secret);
    const access = this.data.accessTokens.find(
      (entry) => entry.key === key && entry.clientId === clientId,
    );
    if (access) {
      access.revokedAt = now;
      this.persist();
      return;
    }

    const refresh = this.data.refreshTokens.find(
      (entry) => entry.key === key && entry.clientId === clientId,
    );
    if (refresh) {
      this.revokeGrantInMemory(refresh.grantId, now);
      this.persist();
    }
  }

  revokeGrant(grantId: string, now: number): void {
    this.revokeGrantInMemory(grantId, now);
    this.persist();
  }

  private revokeGrantInMemory(grantId: string, now: number): void {
    for (const token of this.data.accessTokens) {
      if (token.grantId === grantId) token.revokedAt = now;
    }
    for (const token of this.data.refreshTokens) {
      if (token.grantId === grantId) token.status = "revoked";
    }
  }

  private purgeExpired(now: number): void {
    const dynamicClientCutoff = now - 60 * 60 * 1_000;
    this.data.clients = this.data.clients.filter(
      (client) =>
        client.authorizedAt !== undefined || client.issuedAt * 1_000 > dynamicClientCutoff,
    );
    this.data.interactions = this.data.interactions.filter((entry) => entry.expiresAt > now);
    this.data.authorizationCodes = this.data.authorizationCodes.filter(
      (entry) => entry.expiresAt > now,
    );
    this.data.accessTokens = this.data.accessTokens.filter((entry) => entry.expiresAt > now);
    this.data.refreshTokens = this.data.refreshTokens.filter((entry) => entry.expiresAt > now);
    this.data.adminSessions = this.data.adminSessions.filter((entry) => entry.expiresAt > now);
  }

  private persist(): void {
    this.purgeExpired(Date.now());
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.data)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, this.filePath);
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // Windows ACLs do not implement POSIX modes. The parent directory and
      // container volume remain the security boundary on that platform.
    }
  }
}
