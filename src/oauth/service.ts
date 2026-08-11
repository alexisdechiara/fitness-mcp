import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Request, type RequestHandler, type Response, type Router } from "express";
import type { AppConfig } from "../config/env.js";
import type { Logger } from "../logging/logger.js";
import { consentPage, errorPage, loginPage } from "./html.js";
import {
  OAuthStore,
  randomOAuthSecret,
  type StoredOAuthClient,
  type StoredRefreshToken,
} from "./store.js";

const FITNESS_SCOPE = "fitness:read";
const OFFLINE_SCOPE = "offline_access";
const SUPPORTED_SCOPES = new Set([FITNESS_SCOPE, OFFLINE_SCOPE]);
const ADMIN_COOKIE = "__Host-fitness_admin";
const MAX_FORM_BYTES = "32kb";
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/u;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u;
const OPAQUE_VALUE = /^[A-Za-z0-9_-]{32,256}$/u;

export interface VerifiedAccessToken {
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

export interface OAuthService {
  router(): RequestHandler;
  verifyAccessToken(token: string): Promise<VerifiedAccessToken>;
}

interface OAuthClient {
  clientId: string;
  clientSecret?: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none" | "client_secret_post";
  grantTypes: Array<"authorization_code" | "refresh_token">;
  responseTypes: ["code"];
  scope: string;
  issuedAt?: number;
}

class OAuthProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

class FixedWindowLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maximum: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    if (this.entries.size >= 1_024) {
      for (const [candidate, value] of this.entries) {
        if (value.resetAt <= now) this.entries.delete(candidate);
      }
    }
    const current = this.entries.get(key);
    if (!current && this.entries.size >= 10_000) return false;
    if (!current || current.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    current.count += 1;
    return current.count <= this.maximum;
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function secretEquals(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

function singleParameter(
  values: URLSearchParams,
  name: string,
  options: { required?: boolean; maximumLength?: number } = {},
): string | undefined {
  const all = values.getAll(name);
  if (all.length > 1) throw new OAuthProtocolError("invalid_request", `${name} is duplicated.`);
  const value = all[0];
  if ((value === undefined || value === "") && options.required) {
    throw new OAuthProtocolError("invalid_request", `${name} is required.`);
  }
  if (value !== undefined && value.length > (options.maximumLength ?? 2_048)) {
    throw new OAuthProtocolError("invalid_request", `${name} is too long.`);
  }
  return value === "" ? undefined : value;
}

function parseForm(request: Request): URLSearchParams {
  if (!request.is("application/x-www-form-urlencoded") || typeof request.body !== "string") {
    throw new OAuthProtocolError(
      "invalid_request",
      "Content-Type must be application/x-www-form-urlencoded.",
    );
  }
  return new URLSearchParams(request.body);
}

function parseCookies(request: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      // An invalid cookie is ignored and therefore cannot authenticate.
    }
  }
  return cookies;
}

function setAdminCookie(response: Response, value: string, maxAgeSeconds: number): void {
  response.setHeader(
    "Set-Cookie",
    `${ADMIN_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`,
  );
}

function clearAdminCookie(response: Response): void {
  response.setHeader(
    "Set-Cookie",
    `${ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
  );
}

function sendOAuthError(response: Response, error: unknown): void {
  const protocolError =
    error instanceof OAuthProtocolError
      ? error
      : new OAuthProtocolError("server_error", "The authorization server failed.", 500);
  response.status(protocolError.status).json({
    error: protocolError.code,
    error_description: protocolError.message,
  });
}

function redirectWithOAuthResult(
  response: Response,
  redirectUri: string,
  values: Record<string, string | undefined>,
): void {
  const destination = new URL(redirectUri);
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) destination.searchParams.set(name, value);
  }
  response.redirect(302, destination.href);
}

function normalizedScopes(value: string | undefined): string[] {
  const scopes = value ? value.split(" ").filter(Boolean) : [FITNESS_SCOPE];
  const unique = [...new Set(scopes)];
  if (!unique.includes(FITNESS_SCOPE) || unique.some((scope) => !SUPPORTED_SCOPES.has(scope))) {
    throw new OAuthProtocolError("invalid_scope", "Only fitness:read and offline_access are supported.");
  }
  return unique;
}

function clientFromStored(client: StoredOAuthClient): OAuthClient {
  return {
    clientId: client.clientId,
    clientName: client.clientName,
    redirectUris: [...client.redirectUris],
    tokenEndpointAuthMethod: "none",
    grantTypes: [...client.grantTypes],
    responseTypes: ["code"],
    scope: client.scope,
    issuedAt: client.issuedAt,
  };
}

function htmlSecurityHeaders(_request: Request, response: Response, next: () => void): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  next();
}

class EmbeddedOAuthService implements OAuthService {
  private readonly oauthRouter: Router;
  private readonly store: OAuthStore;
  private readonly issuer: string;
  private readonly resource: string;
  private readonly registrationLimiter = new FixedWindowLimiter(20, 60 * 60 * 1_000);
  private readonly authorizationLimiter = new FixedWindowLimiter(100, 15 * 60 * 1_000);
  private readonly tokenLimiter = new FixedWindowLimiter(50, 15 * 60 * 1_000);
  private readonly loginLimiter = new FixedWindowLimiter(5, 15 * 60 * 1_000);

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    if (
      !config.oauthIssuerUrl ||
      !config.oauthResourceUrl ||
      !config.oauthStorePath ||
      !config.fitnessAdminUsername ||
      !config.fitnessAdminPassword
    ) {
      throw new Error("OAuth configuration is incomplete.");
    }
    this.issuer = config.oauthIssuerUrl;
    this.resource = config.oauthResourceUrl;
    this.store = new OAuthStore(config.oauthStorePath);
    this.oauthRouter = this.createRouter();
  }

  router(): RequestHandler {
    return this.oauthRouter;
  }

  async verifyAccessToken(token: string): Promise<VerifiedAccessToken> {
    if (!OPAQUE_VALUE.test(token)) throw new Error("Invalid access token.");
    const record = this.store.getAccessToken(token);
    const now = Date.now();
    if (
      !record ||
      record.revokedAt !== undefined ||
      record.expiresAt <= now ||
      record.resource !== this.resource
    ) {
      throw new Error("Invalid access token.");
    }
    return {
      clientId: record.clientId,
      scopes: [...record.scopes],
      resource: record.resource,
      expiresAt: Math.floor(record.expiresAt / 1_000),
    };
  }

  private createRouter(): Router {
    const router = express.Router();
    router.use(htmlSecurityHeaders);

    router.get("/.well-known/oauth-protected-resource", (_request, response) => {
      response.json(this.protectedResourceMetadata());
    });
    router.get("/.well-known/oauth-protected-resource/mcp", (_request, response) => {
      response.json(this.protectedResourceMetadata());
    });
    router.get("/.well-known/oauth-authorization-server", (_request, response) => {
      response.json(this.authorizationServerMetadata());
    });

    router.get("/authorize", (request, response) => this.handleAuthorize(request, response));
    router.post(
      "/token",
      express.text({ type: "application/x-www-form-urlencoded", limit: MAX_FORM_BYTES }),
      (request, response) => this.handleToken(request, response),
    );
    router.post(
      "/revoke",
      express.text({ type: "application/x-www-form-urlencoded", limit: MAX_FORM_BYTES }),
      (request, response) => this.handleRevoke(request, response),
    );

    if (this.config.oauthDcrEnabled) {
      router.post(
        "/register",
        express.json({ limit: MAX_FORM_BYTES, strict: true }),
        (request, response) => this.handleRegister(request, response),
      );
    }

    router.get("/oauth/login", (request, response) => this.handleLoginPage(request, response));
    router.post(
      "/oauth/login",
      express.text({ type: "application/x-www-form-urlencoded", limit: MAX_FORM_BYTES }),
      (request, response) => this.handleLogin(request, response),
    );
    router.get("/oauth/consent", (request, response) =>
      this.handleConsentPage(request, response),
    );
    router.post(
      "/oauth/consent",
      express.text({ type: "application/x-www-form-urlencoded", limit: MAX_FORM_BYTES }),
      (request, response) => this.handleConsent(request, response),
    );
    router.post(
      "/oauth/logout",
      express.text({ type: "application/x-www-form-urlencoded", limit: "1kb" }),
      (request, response) => this.handleLogout(request, response),
    );

    router.use(((error: unknown, _request: Request, response: Response, _next: () => void) => {
      sendOAuthError(
        response,
        error instanceof OAuthProtocolError
          ? error
          : new OAuthProtocolError("invalid_request", "The request body is invalid."),
      );
    }) as express.ErrorRequestHandler);

    return router;
  }

  private protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: [FITNESS_SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "fitness-mcp",
    };
  }

  private authorizationServerMetadata(): Record<string, unknown> {
    const secretMethods = this.config.claudeClientSecret
      ? ["client_secret_post", "client_secret_basic"]
      : [];
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      ...(this.config.oauthDcrEnabled
        ? { registration_endpoint: `${this.issuer}/register` }
        : {}),
      revocation_endpoint: `${this.issuer}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none", ...secretMethods],
      revocation_endpoint_auth_methods_supported: ["none", ...secretMethods],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [FITNESS_SCOPE, OFFLINE_SCOPE],
      authorization_response_iss_parameter_supported: true,
      resource_indicators_supported: true,
    };
  }

  private getClient(clientId: string): OAuthClient | undefined {
    if (this.config.claudeClientId === clientId && this.config.claudeClientSecret) {
      return {
        clientId,
        clientSecret: this.config.claudeClientSecret,
        clientName: "Claude",
        redirectUris: [...this.config.oauthAllowedRedirectUris],
        tokenEndpointAuthMethod: "client_secret_post",
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        scope: `${FITNESS_SCOPE} ${OFFLINE_SCOPE}`,
      };
    }
    const dynamic = this.store.getDynamicClient(clientId);
    return dynamic ? clientFromStored(dynamic) : undefined;
  }

  private handleAuthorize(request: Request, response: Response): void {
    if (!this.authorizationLimiter.allow(request.ip ?? "unknown")) {
      sendOAuthError(response, new OAuthProtocolError("temporarily_unavailable", "Too many requests.", 429));
      return;
    }

    const query = new URL(request.originalUrl, this.issuer).searchParams;
    let client: OAuthClient | undefined;
    let redirectUri: string | undefined;
    let state: string | undefined;
    try {
      const clientId = singleParameter(query, "client_id", { required: true, maximumLength: 256 });
      if (!clientId || !(client = this.getClient(clientId))) {
        throw new OAuthProtocolError("invalid_client", "Unknown OAuth client.");
      }
      redirectUri = singleParameter(query, "redirect_uri", { required: true, maximumLength: 2_048 });
      if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
        throw new OAuthProtocolError("invalid_request", "Unregistered redirect_uri.");
      }

      state = singleParameter(query, "state", { required: true, maximumLength: 1_024 });
      if (!state || /[\u0000-\u001f\u007f]/u.test(state)) {
        throw new OAuthProtocolError("invalid_request", "state is required and must be opaque.");
      }
      const responseType = singleParameter(query, "response_type", { required: true });
      if (responseType !== "code") {
        throw new OAuthProtocolError("unsupported_response_type", "Only response_type=code is supported.");
      }
      const challengeMethod = singleParameter(query, "code_challenge_method", { required: true });
      const challenge = singleParameter(query, "code_challenge", { required: true, maximumLength: 128 });
      if (challengeMethod !== "S256" || !challenge || !PKCE_CHALLENGE.test(challenge)) {
        throw new OAuthProtocolError("invalid_request", "PKCE S256 is required.");
      }
      const resource = singleParameter(query, "resource", { required: true, maximumLength: 2_048 });
      if (resource !== this.resource) {
        throw new OAuthProtocolError("invalid_target", "The requested resource is invalid.");
      }
      const scopes = normalizedScopes(singleParameter(query, "scope", { maximumLength: 512 }));
      const registeredScopes = new Set(client.scope.split(" ").filter(Boolean));
      if (scopes.some((scope) => !registeredScopes.has(scope))) {
        throw new OAuthProtocolError("invalid_scope", "The client did not register this scope.");
      }
      const created = this.store.createInteraction({
        clientId: client.clientId,
        redirectUri,
        state,
        codeChallenge: challenge,
        resource,
        scopes,
        expiresAt: Date.now() + Math.min(this.config.oauthSessionTtlSeconds, 600) * 1_000,
      });
      response.redirect(302, `/oauth/login?interaction=${encodeURIComponent(created.interaction)}`);
    } catch (error) {
      if (client && redirectUri && client.redirectUris.includes(redirectUri)) {
        const protocolError =
          error instanceof OAuthProtocolError
            ? error
            : new OAuthProtocolError("server_error", "The authorization server failed.");
        redirectWithOAuthResult(response, redirectUri, {
          error: protocolError.code,
          error_description: protocolError.message,
          state,
          iss: this.issuer,
        });
      } else {
        sendOAuthError(response, error);
      }
    }
  }

  private handleLoginPage(request: Request, response: Response): void {
    try {
      const query = new URL(request.originalUrl, this.issuer).searchParams;
      const interaction = singleParameter(query, "interaction", { required: true, maximumLength: 256 });
      if (!interaction || !OPAQUE_VALUE.test(interaction) || !this.store.getInteraction(interaction)) {
        throw new OAuthProtocolError("invalid_request", "This authorization request is invalid or expired.");
      }
      const csrf = this.store.rotateInteractionCsrf(interaction);
      if (!csrf) throw new OAuthProtocolError("invalid_request", "This authorization request has expired.");
      response.type("html").send(loginPage({ interaction, csrf }));
    } catch (error) {
      const message = error instanceof OAuthProtocolError ? error.message : "Authorization failed.";
      response.status(400).type("html").send(errorPage(message));
    }
  }

  private handleLogin(request: Request, response: Response): void {
    try {
      const form = parseForm(request);
      const interaction = singleParameter(form, "interaction", { required: true, maximumLength: 256 });
      const csrf = singleParameter(form, "csrf", { required: true, maximumLength: 256 });
      const username = singleParameter(form, "username", { required: true, maximumLength: 128 });
      const password = singleParameter(form, "password", { required: true, maximumLength: 1_024 });
      if (!interaction || !csrf || !username || !password || !OPAQUE_VALUE.test(interaction)) {
        throw new OAuthProtocolError("invalid_request", "Invalid login request.");
      }
      const nextCsrf = this.store.rotateInteractionCsrf(interaction, csrf);
      if (!nextCsrf) throw new OAuthProtocolError("invalid_request", "Invalid or expired CSRF token.", 403);

      const usernameMatches = secretEquals(username, this.config.fitnessAdminUsername ?? "");
      const passwordMatches = secretEquals(password, this.config.fitnessAdminPassword ?? "");
      const authenticated = usernameMatches && passwordMatches;
      if (!authenticated) {
        if (!this.loginLimiter.allow(request.ip ?? "unknown")) {
          throw new OAuthProtocolError("temporarily_unavailable", "Too many login attempts.", 429);
        }
        this.logger.warn("oauth_admin_login_rejected", { requestId: response.locals.requestId });
        response.status(401).type("html").send(loginPage({ interaction, csrf: nextCsrf, error: true }));
        return;
      }

      const session = this.store.createSession(
        username,
        Date.now() + this.config.oauthSessionTtlSeconds * 1_000,
      );
      if (!this.store.bindInteractionToSession(interaction, nextCsrf, session)) {
        this.store.deleteSession(session);
        throw new OAuthProtocolError("invalid_request", "This authorization request has expired.");
      }
      setAdminCookie(response, session, this.config.oauthSessionTtlSeconds);
      this.logger.info("oauth_admin_login_succeeded", { requestId: response.locals.requestId });
      response.redirect(303, `/oauth/consent?interaction=${encodeURIComponent(interaction)}`);
    } catch (error) {
      sendOAuthError(response, error);
    }
  }

  private handleConsentPage(request: Request, response: Response): void {
    try {
      const query = new URL(request.originalUrl, this.issuer).searchParams;
      const interaction = singleParameter(query, "interaction", { required: true, maximumLength: 256 });
      const session = parseCookies(request).get(ADMIN_COOKIE);
      if (!interaction || !session || !this.store.getSession(session)) {
        if (interaction && OPAQUE_VALUE.test(interaction)) {
          response.redirect(303, `/oauth/login?interaction=${encodeURIComponent(interaction)}`);
          return;
        }
        throw new OAuthProtocolError("invalid_request", "Authentication is required.");
      }
      const pending = this.store.getInteraction(interaction);
      const csrf = this.store.rotateInteractionCsrf(interaction, undefined, session);
      if (!pending || !csrf) {
        throw new OAuthProtocolError("invalid_request", "This authorization request is invalid or expired.");
      }
      const client = this.getClient(pending.clientId);
      if (!client) throw new OAuthProtocolError("invalid_client", "The OAuth client no longer exists.");
      response.type("html").send(
        consentPage({
          interaction,
          csrf,
          clientName: client.clientName,
          redirectUri: pending.redirectUri,
          resource: pending.resource,
          scopes: pending.scopes,
        }),
      );
    } catch (error) {
      const message = error instanceof OAuthProtocolError ? error.message : "Authorization failed.";
      response.status(400).type("html").send(errorPage(message));
    }
  }

  private handleConsent(request: Request, response: Response): void {
    try {
      const form = parseForm(request);
      const interaction = singleParameter(form, "interaction", { required: true, maximumLength: 256 });
      const csrf = singleParameter(form, "csrf", { required: true, maximumLength: 256 });
      const decision = singleParameter(form, "decision", { required: true, maximumLength: 16 });
      const session = parseCookies(request).get(ADMIN_COOKIE);
      if (!interaction || !csrf || !session || !this.store.getSession(session)) {
        throw new OAuthProtocolError("access_denied", "Authentication is required.", 401);
      }
      if (decision !== "allow" && decision !== "deny") {
        throw new OAuthProtocolError("invalid_request", "Invalid consent decision.");
      }
      const pending = this.store.consumeInteraction(interaction, csrf, session);
      if (!pending) {
        throw new OAuthProtocolError("invalid_request", "Invalid, expired, or replayed consent.", 403);
      }

      if (decision === "deny") {
        redirectWithOAuthResult(response, pending.redirectUri, {
          error: "access_denied",
          state: pending.state,
          iss: this.issuer,
        });
        return;
      }

      const code = this.store.createAuthorizationCode({
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        resource: pending.resource,
        scopes: pending.scopes,
        expiresAt: Date.now() + this.config.oauthAuthCodeTtlSeconds * 1_000,
      });
      this.store.markDynamicClientAuthorized(pending.clientId, Date.now());
      this.logger.info("oauth_consent_granted", {
        requestId: response.locals.requestId,
        clientId: pending.clientId,
      });
      redirectWithOAuthResult(response, pending.redirectUri, {
        code,
        state: pending.state,
        iss: this.issuer,
      });
    } catch (error) {
      sendOAuthError(response, error);
    }
  }

  private handleLogout(request: Request, response: Response): void {
    const session = parseCookies(request).get(ADMIN_COOKIE);
    if (session) this.store.deleteSession(session);
    clearAdminCookie(response);
    response.status(204).end();
  }

  private handleRegister(request: Request, response: Response): void {
    try {
      if (!this.registrationLimiter.allow(request.ip ?? "unknown")) {
        throw new OAuthProtocolError("too_many_requests", "Too many registrations.", 429);
      }
      if (!request.is("application/json") || request.body === null || typeof request.body !== "object" || Array.isArray(request.body)) {
        throw new OAuthProtocolError("invalid_client_metadata", "A JSON object is required.");
      }
      if (this.store.countDynamicClients() >= this.config.oauthMaxDynamicClients) {
        throw new OAuthProtocolError("invalid_client_metadata", "Dynamic client quota reached.");
      }
      const body = request.body as Record<string, unknown>;
      if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0 || body.redirect_uris.some((value) => typeof value !== "string")) {
        throw new OAuthProtocolError("invalid_redirect_uri", "redirect_uris must be a non-empty string array.");
      }
      const redirectUris = body.redirect_uris as string[];
      if (redirectUris.some((uri) => !this.config.oauthAllowedRedirectUris.includes(uri))) {
        throw new OAuthProtocolError("invalid_redirect_uri", "Every redirect URI must be explicitly allowed.");
      }
      const authenticationMethod = body.token_endpoint_auth_method ?? "none";
      if (authenticationMethod !== "none") {
        throw new OAuthProtocolError("invalid_client_metadata", "DCR is restricted to public clients.");
      }
      const grantTypes = body.grant_types ?? ["authorization_code", "refresh_token"];
      if (
        !Array.isArray(grantTypes) ||
        !grantTypes.includes("authorization_code") ||
        grantTypes.some((grant) => grant !== "authorization_code" && grant !== "refresh_token")
      ) {
        throw new OAuthProtocolError("invalid_client_metadata", "Unsupported grant_types.");
      }
      const responseTypes = body.response_types ?? ["code"];
      if (!Array.isArray(responseTypes) || responseTypes.length !== 1 || responseTypes[0] !== "code") {
        throw new OAuthProtocolError("invalid_client_metadata", "Only response_type code is supported.");
      }
      if (body.application_type !== undefined && body.application_type !== "web") {
        throw new OAuthProtocolError("invalid_client_metadata", "Only web clients are supported.");
      }
      if (body.scope !== undefined && typeof body.scope !== "string") {
        throw new OAuthProtocolError("invalid_client_metadata", "scope must be a string.");
      }
      const scopes =
        typeof body.scope === "string"
          ? normalizedScopes(body.scope)
          : [FITNESS_SCOPE, OFFLINE_SCOPE];
      if (scopes.includes(OFFLINE_SCOPE) && !grantTypes.includes("refresh_token")) {
        throw new OAuthProtocolError(
          "invalid_client_metadata",
          "offline_access requires the refresh_token grant.",
        );
      }
      const clientName =
        typeof body.client_name === "string" && body.client_name.trim()
          ? body.client_name.trim().slice(0, 128)
          : "Claude MCP client";
      const stored = this.store.addDynamicClient({
        redirectUris,
        tokenEndpointAuthMethod: "none",
        grantTypes: grantTypes as Array<"authorization_code" | "refresh_token">,
        responseTypes: ["code"],
        clientName,
        scope: scopes.join(" "),
      });
      response.status(201).json({
        client_id: stored.clientId,
        client_id_issued_at: stored.issuedAt,
        client_name: stored.clientName,
        redirect_uris: stored.redirectUris,
        token_endpoint_auth_method: stored.tokenEndpointAuthMethod,
        grant_types: stored.grantTypes,
        response_types: stored.responseTypes,
        scope: stored.scope,
      });
    } catch (error) {
      sendOAuthError(response, error);
    }
  }

  private authenticateClient(request: Request, form: URLSearchParams): OAuthClient {
    const bodyClientId = singleParameter(form, "client_id", { maximumLength: 256 });
    const bodySecret = singleParameter(form, "client_secret", { maximumLength: 1_024 });
    let clientId = bodyClientId;
    let clientSecret = bodySecret;
    const authorization = request.headers.authorization;
    if (authorization !== undefined) {
      const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/u.exec(authorization);
      if (!match?.[1]) throw new OAuthProtocolError("invalid_client", "Invalid client authentication.", 401);
      let decoded: string;
      try {
        decoded = Buffer.from(match[1], "base64").toString("utf8");
      } catch {
        throw new OAuthProtocolError("invalid_client", "Invalid client authentication.", 401);
      }
      const separator = decoded.indexOf(":");
      if (separator < 1 || bodyClientId !== undefined || bodySecret !== undefined) {
        throw new OAuthProtocolError("invalid_client", "Ambiguous client authentication.", 401);
      }
      try {
        clientId = decodeURIComponent(decoded.slice(0, separator));
        clientSecret = decodeURIComponent(decoded.slice(separator + 1));
      } catch {
        throw new OAuthProtocolError("invalid_client", "Invalid client authentication.", 401);
      }
    }
    if (!clientId) throw new OAuthProtocolError("invalid_client", "client_id is required.", 401);
    const client = this.getClient(clientId);
    if (!client) throw new OAuthProtocolError("invalid_client", "Invalid client credentials.", 401);
    if (client.tokenEndpointAuthMethod === "none") {
      if (clientSecret !== undefined) {
        throw new OAuthProtocolError("invalid_client", "Public clients must not send a secret.", 401);
      }
    } else if (!client.clientSecret || !clientSecret || !secretEquals(clientSecret, client.clientSecret)) {
      throw new OAuthProtocolError("invalid_client", "Invalid client credentials.", 401);
    }
    return client;
  }

  private handleToken(request: Request, response: Response): void {
    try {
      if (!this.tokenLimiter.allow(request.ip ?? "unknown")) {
        throw new OAuthProtocolError("temporarily_unavailable", "Too many token requests.", 429);
      }
      const form = parseForm(request);
      const client = this.authenticateClient(request, form);
      const grantType = singleParameter(form, "grant_type", { required: true });
      if (!grantType || !client.grantTypes.includes(grantType as "authorization_code" | "refresh_token")) {
        throw new OAuthProtocolError("unauthorized_client", "The client cannot use this grant.");
      }
      if (grantType === "authorization_code") {
        this.exchangeAuthorizationCode(response, form, client);
      } else if (grantType === "refresh_token") {
        this.exchangeRefreshToken(response, form, client);
      } else {
        throw new OAuthProtocolError("unsupported_grant_type", "Unsupported grant type.");
      }
    } catch (error) {
      if (error instanceof OAuthProtocolError && error.code === "invalid_client") {
        response.setHeader("WWW-Authenticate", 'Basic realm="fitness-mcp-oauth"');
      }
      sendOAuthError(response, error);
    }
  }

  private exchangeAuthorizationCode(
    response: Response,
    form: URLSearchParams,
    client: OAuthClient,
  ): void {
    const code = singleParameter(form, "code", { required: true, maximumLength: 256 });
    const verifier = singleParameter(form, "code_verifier", { required: true, maximumLength: 128 });
    const redirectUri = singleParameter(form, "redirect_uri", { required: true, maximumLength: 2_048 });
    const resource = singleParameter(form, "resource", { required: true, maximumLength: 2_048 });
    if (!code || !verifier || !redirectUri || !resource || !OPAQUE_VALUE.test(code) || !PKCE_VERIFIER.test(verifier)) {
      throw new OAuthProtocolError("invalid_grant", "The authorization code or PKCE verifier is invalid.");
    }
    const record = this.store.getAuthorizationCode(code);
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    if (
      !record ||
      record.usedAt !== undefined ||
      record.expiresAt <= Date.now() ||
      record.clientId !== client.clientId ||
      record.redirectUri !== redirectUri ||
      record.resource !== resource ||
      resource !== this.resource ||
      !secretEquals(challenge, record.codeChallenge)
    ) {
      throw new OAuthProtocolError("invalid_grant", "The authorization code is invalid, expired, or already used.");
    }

    const now = Date.now();
    const accessToken = randomOAuthSecret();
    const refreshToken =
      record.scopes.includes(OFFLINE_SCOPE) && client.grantTypes.includes("refresh_token")
        ? randomOAuthSecret()
        : undefined;
    const consumed = this.store.consumeAuthorizationCodeAndIssue(
      code,
      now,
      accessToken,
      {
        clientId: client.clientId,
        resource: record.resource,
        scopes: record.scopes,
        expiresAt: now + this.config.oauthAccessTokenTtlSeconds * 1_000,
      },
      refreshToken
        ? {
            secret: refreshToken,
            record: {
              clientId: client.clientId,
              resource: record.resource,
              scopes: record.scopes,
              expiresAt: now + this.config.oauthRefreshTokenTtlSeconds * 1_000,
              status: "active",
            },
          }
        : undefined,
    );
    if (!consumed) throw new OAuthProtocolError("invalid_grant", "The authorization code was already used.");
    response.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.config.oauthAccessTokenTtlSeconds,
      scope: record.scopes.join(" "),
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    });
  }

  private exchangeRefreshToken(
    response: Response,
    form: URLSearchParams,
    client: OAuthClient,
  ): void {
    const secret = singleParameter(form, "refresh_token", { required: true, maximumLength: 256 });
    const resource = singleParameter(form, "resource", { required: true, maximumLength: 2_048 });
    if (!secret || !resource || !OPAQUE_VALUE.test(secret)) {
      throw new OAuthProtocolError("invalid_grant", "The refresh token is invalid.");
    }
    const current = this.store.getRefreshToken(secret);
    if (
      !current ||
      current.clientId !== client.clientId ||
      current.resource !== resource ||
      resource !== this.resource ||
      current.expiresAt <= Date.now() ||
      current.status === "revoked"
    ) {
      throw new OAuthProtocolError("invalid_grant", "The refresh token is invalid or expired.");
    }
    const requestedScopes = singleParameter(form, "scope", { maximumLength: 512 });
    const scopes = requestedScopes ? normalizedScopes(requestedScopes) : [...current.scopes];
    if (scopes.some((scope) => !current.scopes.includes(scope))) {
      throw new OAuthProtocolError("invalid_scope", "A refresh cannot increase scopes.");
    }

    const now = Date.now();
    const nextAccess = randomOAuthSecret();
    const nextRefresh = randomOAuthSecret();
    const accessRecord = {
      clientId: current.clientId,
      resource: current.resource,
      scopes,
      grantId: current.grantId,
      expiresAt: now + this.config.oauthAccessTokenTtlSeconds * 1_000,
    };
    const refreshRecord: Omit<StoredRefreshToken, "key"> = {
      clientId: current.clientId,
      resource: current.resource,
      scopes,
      grantId: current.grantId,
      expiresAt: current.expiresAt,
      status: "active",
    };
    const result = this.store.rotateRefreshToken(
      secret,
      accessRecord,
      refreshRecord,
      nextAccess,
      nextRefresh,
      now,
    );
    if (result !== "rotated") {
      throw new OAuthProtocolError(
        "invalid_grant",
        result === "reused"
          ? "Refresh token reuse detected; the grant was revoked."
          : "The refresh token is invalid or expired.",
      );
    }
    response.json({
      access_token: nextAccess,
      refresh_token: nextRefresh,
      token_type: "Bearer",
      expires_in: this.config.oauthAccessTokenTtlSeconds,
      scope: scopes.join(" "),
    });
  }

  private handleRevoke(request: Request, response: Response): void {
    try {
      const form = parseForm(request);
      const client = this.authenticateClient(request, form);
      const token = singleParameter(form, "token", { required: true, maximumLength: 256 });
      singleParameter(form, "token_type_hint", { maximumLength: 64 });
      if (!token) throw new OAuthProtocolError("invalid_request", "token is required.");
      this.store.revokeToken(token, client.clientId, Date.now());
      response.status(200).end();
    } catch (error) {
      if (error instanceof OAuthProtocolError && error.code === "invalid_client") {
        response.setHeader("WWW-Authenticate", 'Basic realm="fitness-mcp-oauth"');
      }
      sendOAuthError(response, error);
    }
  }
}

export function createOAuthService(config: AppConfig, logger: Logger): OAuthService {
  return new EmbeddedOAuthService(config, logger);
}
