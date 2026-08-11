import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import type { AppConfig } from "../config/env.js";
import type { Logger } from "../logging/logger.js";
import type { OAuthService } from "../oauth/service.js";

const FITNESS_READ_SCOPE = "fitness:read";

function bearerToken(request: Request): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "");
  return match?.[1]?.trim() || undefined;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function createMcpAuthMiddleware(
  config: AppConfig,
  logger: Logger,
  oauth?: Pick<OAuthService, "verifyAccessToken">,
): RequestHandler {
  if (config.mcpAuthMode === "none") {
    return (_request, _response, next) => next();
  }

  if (config.mcpAuthMode === "oauth") {
    return createOAuthMiddleware(config, logger, oauth);
  }

  const expected = digest(config.mcpAccessToken ?? "");
  return (request, response, next) => {
    const provided = bearerToken(request);
    const authenticated = provided ? timingSafeEqual(digest(provided), expected) : false;
    if (authenticated) {
      next();
      return;
    }

    logger.warn("mcp_auth_rejected", { requestId: response.locals.requestId });
    response.setHeader("WWW-Authenticate", 'Bearer realm="fitness-mcp"');
    response.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32_001, message: "Unauthorized" },
      id: null,
    });
  };
}

function protectedResourceMetadataUrl(resourceUrl: string): string {
  const resource = new URL(resourceUrl);
  return new URL(`/.well-known/oauth-protected-resource${resource.pathname}`, resource).href;
}

function sendOAuthChallenge(
  response: Parameters<RequestHandler>[1],
  metadataUrl: string,
  invalidToken: boolean,
): void {
  const error = invalidToken ? 'error="invalid_token", ' : "";
  response.setHeader(
    "WWW-Authenticate",
    `Bearer ${error}resource_metadata="${metadataUrl}", scope="${FITNESS_READ_SCOPE}"`,
  );
  response.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32_001, message: "Unauthorized" },
    id: null,
  });
}

function createOAuthMiddleware(
  config: AppConfig,
  logger: Logger,
  oauth?: Pick<OAuthService, "verifyAccessToken">,
): RequestHandler {
  if (!oauth || !config.oauthResourceUrl) {
    throw new Error("OAuth authentication is enabled but the OAuth service is unavailable.");
  }

  const resourceUrl = config.oauthResourceUrl;
  const metadataUrl = protectedResourceMetadataUrl(resourceUrl);
  return async (request, response, next) => {
    const provided = bearerToken(request);
    if (!provided) {
      logger.warn("mcp_auth_rejected", { requestId: response.locals.requestId });
      sendOAuthChallenge(response, metadataUrl, request.headers.authorization !== undefined);
      return;
    }

    try {
      const auth = await oauth.verifyAccessToken(provided);
      const valid =
        auth.clientId.length > 0 &&
        auth.scopes.includes(FITNESS_READ_SCOPE) &&
        auth.resource === resourceUrl &&
        Number.isFinite(auth.expiresAt) &&
        auth.expiresAt > Date.now() / 1_000;
      if (valid) {
        response.locals.oauth = auth;
        next();
        return;
      }
    } catch {
      // Token verification failures deliberately share one public response.
    }

    logger.warn("mcp_auth_rejected", { requestId: response.locals.requestId });
    sendOAuthChallenge(response, metadataUrl, true);
  };
}
