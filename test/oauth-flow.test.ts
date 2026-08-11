import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { createDependencies } from "../src/dependencies.js";

const ISSUER = "https://fitness.test";
const RESOURCE = `${ISSUER}/mcp`;
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const REQUESTED_SCOPE = "fitness:read offline_access";
const ADMIN_USERNAME = "fitness-admin";
const ADMIN_PASSWORD = "a-test-password-longer-than-16-characters";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const servers = new Set<Server>();
const temporaryDirectories = new Set<string>();

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

function oauthEnvironment(storePath: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "error",
    MCP_AUTH_MODE: "oauth",
    MCP_ALLOWED_HOSTS: "fitness.test,127.0.0.1,localhost",
    MCP_ALLOWED_ORIGINS: "",
    OAUTH_ISSUER_URL: ISSUER,
    OAUTH_RESOURCE_URL: RESOURCE,
    OAUTH_STORE_PATH: storePath,
    OAUTH_DCR_ENABLED: "true",
    OAUTH_ALLOWED_REDIRECT_URIS: CALLBACK,
    FITNESS_ADMIN_USERNAME: ADMIN_USERNAME,
    FITNESS_ADMIN_PASSWORD: ADMIN_PASSWORD,
    ...overrides,
  };
}

async function temporaryStore(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fitness-mcp-oauth-"));
  temporaryDirectories.add(directory);
  return join(directory, `${name}.json`);
}

async function serve(environment: NodeJS.ProcessEnv): Promise<{ baseUrl: string; server: Server }> {
  const dependencies = createDependencies(loadConfig(environment));
  const server = createApp(dependencies).listen(0, "127.0.0.1");
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("OAuth test server did not bind to a TCP port.");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function stopServer(server: Server): Promise<void> {
  if (!servers.delete(server)) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

function decodedHtml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function inputValue(html: string, name: string): string {
  const inputs = html.match(/<input\b[^>]*>/giu) ?? [];
  for (const input of inputs) {
    const attributes = new Map<string, string>();
    for (const match of input.matchAll(/([\w-]+)="([^"]*)"/gu)) {
      const key = match[1];
      const value = match[2];
      if (key !== undefined && value !== undefined) attributes.set(key, decodedHtml(value));
    }
    if (attributes.get("name") === name) return attributes.get("value") ?? "";
  }
  throw new Error(`Input ${name} was not present in the OAuth HTML form.`);
}

function setCookieValues(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  return extended.getSetCookie?.() ?? (headers.get("set-cookie") ? [headers.get("set-cookie") as string] : []);
}

class BrowserSession {
  private readonly cookies = new Map<string, string>();

  constructor(private readonly baseUrl: string) {}

  async request(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
    const logicalUrl = new URL(pathOrUrl, ISSUER);
    if (logicalUrl.origin !== ISSUER) {
      throw new Error(`Refusing to follow an OAuth redirect outside the test issuer: ${logicalUrl.href}`);
    }
    const transportUrl = new URL(`${logicalUrl.pathname}${logicalUrl.search}`, this.baseUrl);
    const headers = new Headers(init.headers);
    headers.set("Host", "fitness.test");
    if (this.cookies.size > 0) {
      headers.set("Cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    }
    const response = await fetch(transportUrl, { ...init, headers, redirect: "manual" });
    for (const setCookie of setCookieValues(response.headers)) {
      const pair = /^([^=;]+)=([^;]*)/u.exec(setCookie);
      if (pair?.[1] !== undefined && pair[2] !== undefined) {
        if (pair[2] === "") this.cookies.delete(pair[1]);
        else this.cookies.set(pair[1], pair[2]);
      }
    }
    return response;
  }

  get(pathOrUrl: string): Promise<Response> {
    return this.request(pathOrUrl);
  }

  postJson(path: string, body: unknown): Promise<Response> {
    return this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  postForm(path: string, body: Record<string, string>): Promise<Response> {
    return this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
  }
}

function authorizationPath(clientId: string, overrides: Record<string, string | undefined> = {}): string {
  const values: Record<string, string | undefined> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CALLBACK,
    scope: REQUESTED_SCOPE,
    state: "opaque-state-value",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    resource: RESOURCE,
    ...overrides,
  };
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) query.set(name, value);
  }
  return `/authorize?${query.toString()}`;
}

async function expectJsonOAuthRejection(response: Response): Promise<void> {
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error?: unknown };
  expect(body.error).toEqual(expect.any(String));
  expect(response.headers.get("location")).toBeNull();
}

async function expectAuthorizationRejection(response: Response): Promise<void> {
  expect(response.status).toBe(400);
  expect(response.headers.get("location")).toBeNull();
  expect(await response.text()).not.toHaveLength(0);
}

async function expectAuthorizationErrorRedirect(
  response: Response,
  error: "invalid_request" | "invalid_target",
  expectedState: string | null,
): Promise<void> {
  expect(response.status).toBe(302);
  const location = response.headers.get("location");
  expect(location).toEqual(expect.any(String));
  const callback = new URL(location as string);
  expect(callback.origin + callback.pathname).toBe(CALLBACK);
  expect(callback.searchParams.get("error")).toBe(error);
  expect(callback.searchParams.get("state")).toBe(expectedState);
  expect(callback.searchParams.get("code")).toBeNull();
}

async function openLoginPage(browser: BrowserSession, clientId: string): Promise<Response> {
  const authorization = await browser.get(authorizationPath(clientId));
  expect(authorization.status).toBe(302);
  const location = authorization.headers.get("location");
  expect(location).toMatch(/^\/oauth\/login\?interaction=/u);
  return browser.get(location as string);
}

async function expectUnauthorizedMcp(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
  expect(response.headers.get("www-authenticate")).toContain('scope="fitness:read"');
}

async function expectStoreOmits(storePath: string, secrets: string[]): Promise<void> {
  const persisted = await readFile(storePath, "utf8");
  for (const secret of secrets) {
    expect(secret).not.toHaveLength(0);
    expect(persisted).not.toContain(secret);
  }
}

async function mcpInitialize(
  browser: BrowserSession,
  accessToken?: string,
  path = "/mcp",
): Promise<Response> {
  return browser.request(path, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "oauth-flow-test", version: "1.0.0" },
      },
    }),
  });
}

afterEach(async () => {
  await Promise.all([...servers].map(stopServer));
  await Promise.all([...temporaryDirectories].map(async (directory) => rm(directory, { recursive: true, force: true })));
  temporaryDirectories.clear();
});

describe.sequential("OAuth HTTP flow", () => {
  it("discovers, authorizes, rotates, protects MCP, and revokes a dynamic public client", async () => {
    const storePath = await temporaryStore("dynamic");
    const environment = oauthEnvironment(storePath);
    const running = await serve(environment);
    const baseUrl = running.baseUrl;
    let browser = new BrowserSession(baseUrl);
    const rawSecrets = [ADMIN_PASSWORD];

    const [rootResourceMetadata, pathResourceMetadata, authorizationMetadata] = await Promise.all([
      browser.get("/.well-known/oauth-protected-resource"),
      browser.get("/.well-known/oauth-protected-resource/mcp"),
      browser.get("/.well-known/oauth-authorization-server"),
    ]);
    expect(rootResourceMetadata.status).toBe(200);
    expect(pathResourceMetadata.status).toBe(200);
    const rootMetadata = (await rootResourceMetadata.json()) as {
      scopes_supported?: string[];
    };
    expect(rootMetadata).toMatchObject({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      scopes_supported: ["fitness:read"],
    });
    expect(rootMetadata.scopes_supported).not.toContain("offline_access");
    await expect(pathResourceMetadata.json()).resolves.toMatchObject({ resource: RESOURCE });
    expect(authorizationMetadata.status).toBe(200);
    const serverMetadata = (await authorizationMetadata.json()) as {
      scopes_supported?: string[];
    };
    expect(serverMetadata).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      registration_endpoint: `${ISSUER}/register`,
      revocation_endpoint: `${ISSUER}/revoke`,
      code_challenge_methods_supported: ["S256"],
    });
    expect(serverMetadata.scopes_supported).toContain("offline_access");

    const unauthenticatedMcp = await mcpInitialize(browser);
    await expectUnauthorizedMcp(unauthenticatedMcp);
    expect(unauthenticatedMcp.headers.get("www-authenticate")).toContain(
      `resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`,
    );

    const clientMetadata = {
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Fitness OAuth test client",
      scope: REQUESTED_SCOPE,
    };
    const registration = await browser.postJson("/register", clientMetadata);
    expect(registration.status).toBe(201);
    expect(registration.headers.get("cache-control")).toBe("no-store");
    const registered = (await registration.json()) as { client_id?: unknown; client_secret?: unknown };
    expect(registered.client_id).toEqual(expect.any(String));
    expect(registered.client_secret).toBeUndefined();
    const clientId = registered.client_id as string;

    await expectJsonOAuthRejection(
      await browser.postJson("/register", {
        ...clientMetadata,
        redirect_uris: ["https://attacker.example/callback"],
      }),
    );
    await expectJsonOAuthRejection(
      await browser.postJson("/register", { ...clientMetadata, grant_types: ["client_credentials"] }),
    );
    await expectJsonOAuthRejection(
      await browser.postJson("/register", { ...clientMetadata, token_endpoint_auth_method: "client_secret_basic" }),
    );

    const invalidAuthorizationRequests = [
      { path: authorizationPath(clientId, { state: undefined }), error: "invalid_request" as const, state: null },
      { path: authorizationPath(clientId, { resource: undefined }), error: "invalid_request" as const, state: "opaque-state-value" },
      { path: authorizationPath(clientId, { resource: `${ISSUER}/other` }), error: "invalid_target" as const, state: "opaque-state-value" },
      { path: authorizationPath(clientId, { code_challenge: undefined }), error: "invalid_request" as const, state: "opaque-state-value" },
      { path: authorizationPath(clientId, { code_challenge_method: "plain" }), error: "invalid_request" as const, state: "opaque-state-value" },
    ];
    for (const invalid of invalidAuthorizationRequests) {
      await expectAuthorizationErrorRedirect(
        await browser.get(invalid.path),
        invalid.error,
        invalid.state,
      );
    }
    for (const redirectUri of [
      `${CALLBACK}?unexpected=1`,
      `${CALLBACK}/`,
      "https://CLAUDE.ai/api/mcp/auth_callback",
    ]) {
      await expectAuthorizationRejection(
        await browser.get(authorizationPath(clientId, { redirect_uri: redirectUri })),
      );
    }

    const csrfBrowser = new BrowserSession(baseUrl);
    const csrfLoginPage = await openLoginPage(csrfBrowser, clientId);
    expect(csrfLoginPage.status).toBe(200);
    const csrfLoginHtml = await csrfLoginPage.text();
    const csrfInteraction = inputValue(csrfLoginHtml, "interaction");
    const missingCsrf = await csrfBrowser.postForm("/oauth/login", {
      interaction: csrfInteraction,
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
    });
    expect([400, 403]).toContain(missingCsrf.status);
    expect(missingCsrf.headers.get("set-cookie")).toBeNull();

    const loginPage = await openLoginPage(browser, clientId);
    expect(loginPage.status).toBe(200);
    const loginHtml = await loginPage.text();
    const login = await browser.postForm("/oauth/login", {
      interaction: inputValue(loginHtml, "interaction"),
      csrf: inputValue(loginHtml, "csrf"),
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
    });
    expect([302, 303]).toContain(login.status);
    const sessionCookie = setCookieValues(login.headers).join("; ");
    expect(sessionCookie).toMatch(/HttpOnly/iu);
    expect(sessionCookie).toMatch(/Secure/iu);
    expect(sessionCookie).toMatch(/SameSite=Lax/iu);
    const sessionSecret = /__Host-fitness_admin=([^;]+)/u.exec(sessionCookie)?.[1];
    expect(sessionSecret).toEqual(expect.any(String));
    rawSecrets.push(decodeURIComponent(sessionSecret as string));
    await expectStoreOmits(storePath, rawSecrets);
    const consentLocation = login.headers.get("location");
    expect(consentLocation).toEqual(expect.any(String));

    const consentPage = await browser.get(consentLocation as string);
    expect(consentPage.status).toBe(200);
    const consentHtml = await consentPage.text();
    expect(consentHtml).toContain("fitness:read");
    const consentInteraction = inputValue(consentHtml, "interaction");
    const consentCsrf = inputValue(consentHtml, "csrf");
    const consentWithoutSession = await new BrowserSession(baseUrl).postForm("/oauth/consent", {
      interaction: consentInteraction,
      csrf: consentCsrf,
      decision: "allow",
    });
    expect([400, 401, 403]).toContain(consentWithoutSession.status);
    expect(consentWithoutSession.headers.get("location")).toBeNull();

    const consent = await browser.postForm("/oauth/consent", {
      interaction: consentInteraction,
      csrf: consentCsrf,
      decision: "allow",
    });
    expect([302, 303]).toContain(consent.status);
    const callback = new URL(consent.headers.get("location") as string);
    expect(callback.origin + callback.pathname).toBe(CALLBACK);
    expect(callback.searchParams.get("state")).toBe("opaque-state-value");
    expect(callback.searchParams.get("error")).toBeNull();
    const code = callback.searchParams.get("code");
    expect(code).toEqual(expect.any(String));
    rawSecrets.push(code as string);
    await expectStoreOmits(storePath, rawSecrets);

    const tokenRequest = {
      grant_type: "authorization_code",
      code: code as string,
      redirect_uri: CALLBACK,
      client_id: clientId,
      code_verifier: VERIFIER,
      resource: RESOURCE,
    };
    const wrongTokenRedirect = await browser.postForm("/token", {
      ...tokenRequest,
      redirect_uri: `${CALLBACK}/`,
    });
    expect(wrongTokenRedirect.status).toBe(400);
    await expect(wrongTokenRedirect.json()).resolves.toMatchObject({ error: "invalid_grant" });

    const malformedVerifier = await browser.postForm("/token", {
      ...tokenRequest,
      code_verifier: "too-short",
    });
    expect(malformedVerifier.status).toBe(400);
    await expect(malformedVerifier.json()).resolves.toMatchObject({ error: "invalid_grant" });

    const wrongVerifier = await browser.postForm("/token", {
      ...tokenRequest,
      code_verifier: `${VERIFIER}x`,
    });
    expect(wrongVerifier.status).toBe(400);
    await expect(wrongVerifier.json()).resolves.toMatchObject({ error: "invalid_grant" });

    const tokenExchange = await browser.postForm("/token", tokenRequest);
    expect(tokenExchange.status).toBe(200);
    const tokens = (await tokenExchange.json()) as TokenResponse;
    expect(tokens).toMatchObject({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      token_type: "Bearer",
      expires_in: expect.any(Number),
      scope: REQUESTED_SCOPE,
    });
    rawSecrets.push(tokens.access_token, tokens.refresh_token);
    await expectStoreOmits(storePath, rawSecrets);

    const codeReplay = await browser.postForm("/token", tokenRequest);
    expect(codeReplay.status).toBe(400);
    await expect(codeReplay.json()).resolves.toMatchObject({ error: "invalid_grant" });

    const authorizedMcp = await mcpInitialize(browser, tokens.access_token);
    expect(authorizedMcp.status).toBe(200);
    expect(await authorizedMcp.text()).toContain("fitness-mcp");

    const queryToken = await mcpInitialize(
      browser,
      undefined,
      `/mcp?access_token=${encodeURIComponent(tokens.access_token)}`,
    );
    await expectUnauthorizedMcp(queryToken);

    await stopServer(running.server);
    const restarted = await serve(environment);
    browser = new BrowserSession(restarted.baseUrl);
    const persistedMcp = await mcpInitialize(browser, tokens.access_token);
    expect(persistedMcp.status).toBe(200);
    expect(await persistedMcp.text()).toContain("fitness-mcp");

    const refresh = await browser.postForm("/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      resource: RESOURCE,
    });
    expect(refresh.status).toBe(200);
    const rotated = (await refresh.json()) as TokenResponse;
    expect(rotated.access_token).not.toBe(tokens.access_token);
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    rawSecrets.push(rotated.access_token, rotated.refresh_token);
    await expectStoreOmits(storePath, rawSecrets);

    const revocation = await browser.postForm("/revoke", {
      token: tokens.access_token,
      token_type_hint: "access_token",
      client_id: clientId,
    });
    expect(revocation.status).toBe(200);
    const revokedMcp = await mcpInitialize(browser, tokens.access_token);
    await expectUnauthorizedMcp(revokedMcp);
    expect(revokedMcp.headers.get("www-authenticate")).toContain('error="invalid_token"');

    const refreshReplay = await browser.postForm("/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      resource: RESOURCE,
    });
    expect(refreshReplay.status).toBe(400);
    await expect(refreshReplay.json()).resolves.toMatchObject({ error: "invalid_grant" });
    await expectUnauthorizedMcp(await mcpInitialize(browser, rotated.access_token));
    await expectStoreOmits(storePath, rawSecrets);
  });

  it("disables DCR while accepting the configured confidential Claude client", async () => {
    const clientId = "pre-registered-claude-client";
    const clientSecret = "pre-registered-client-secret-with-at-least-32-characters";
    const storePath = await temporaryStore("pre-registered");
    const { baseUrl } = await serve(
      oauthEnvironment(storePath, {
        OAUTH_DCR_ENABLED: "false",
        CLAUDE_CLIENT_ID: clientId,
        CLAUDE_CLIENT_SECRET: clientSecret,
      }),
    );
    const browser = new BrowserSession(baseUrl);

    const metadataResponse = await browser.get("/.well-known/oauth-authorization-server");
    expect(metadataResponse.status).toBe(200);
    const metadata = (await metadataResponse.json()) as { registration_endpoint?: unknown };
    expect(metadata.registration_endpoint).toBeUndefined();
    expect((await browser.postJson("/register", {})).status).toBe(404);

    const authorization = await openLoginPage(browser, clientId);
    expect(authorization.status).toBe(200);
    expect(await authorization.text()).toContain('action="/oauth/login"');
    await expectStoreOmits(storePath, [ADMIN_PASSWORD, clientSecret]);
  });
});
