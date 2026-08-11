import { randomUUID } from "node:crypto";
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type RequestHandler,
} from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpAuthMiddleware } from "./auth/authenticator.js";
import { configuredServices } from "./config/env.js";
import type { RuntimeDependencies } from "./dependencies.js";
import { createMcpServer } from "./mcp-server.js";
import { safeErrorMessage } from "./security/redaction.js";

const JSON_RPC_INTERNAL_ERROR = -32_603;
const MAX_JSON_BODY = "1mb";

function normalizeHostname(authority: string): string | undefined {
  const candidate = authority.trim();
  if (!candidate || /[\\/@\s]/u.test(candidate)) return undefined;

  try {
    const parsed = new URL(`http://${candidate}/`);
    if (parsed.username || parsed.password || parsed.pathname !== "/") return undefined;
    return parsed.hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function normalizeOrigin(origin: string): string | undefined {
  try {
    const parsed = new URL(origin);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return undefined;
    }
    return parsed.origin.toLowerCase();
  } catch {
    return undefined;
  }
}

function appendVary(response: express.Response, value: string): void {
  const current = response.getHeader("Vary");
  const values = new Set(
    (Array.isArray(current) ? current : String(current ?? "").split(","))
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  values.add(value);
  response.setHeader("Vary", [...values].join(", "));
}

function createHostGuard(dependencies: RuntimeDependencies): RequestHandler {
  const allowedHosts = new Set(
    dependencies.config.allowedHosts
      .map(normalizeHostname)
      .filter((host): host is string => host !== undefined),
  );
  return (request, response, next) => {
    const host = normalizeHostname(request.headers.host ?? "");
    if (!host || !allowedHosts.has(host)) {
      dependencies.logger.warn("http_host_rejected", {
        requestId: response.locals.requestId,
      });
      response.status(403).json({ error: "Forbidden" });
      return;
    }

    next();
  };
}

function createMcpOriginGuard(dependencies: RuntimeDependencies): RequestHandler {
  const allowedOrigins = new Set(
    dependencies.config.allowedOrigins
      .map(normalizeOrigin)
      .filter((origin): origin is string => origin !== undefined),
  );

  return (request, response, next) => {
    const suppliedOrigin = request.headers.origin;
    if (suppliedOrigin !== undefined) {
      const origin = normalizeOrigin(suppliedOrigin);
      if (!origin || !allowedOrigins.has(origin)) {
        dependencies.logger.warn("http_origin_rejected", {
          requestId: response.locals.requestId,
        });
        response.status(403).json({ error: "Forbidden" });
        return;
      }

      response.setHeader("Access-Control-Allow-Origin", suppliedOrigin);
      response.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
      appendVary(response, "Origin");
    }

    next();
  };
}

function requestIdMiddleware(): RequestHandler {
  return (_request, response, next) => {
    const requestId = randomUUID();
    response.locals.requestId = requestId;
    response.setHeader("X-Request-Id", requestId);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    next();
  };
}

function methodNotAllowed(_request: Request, response: express.Response): void {
  response.setHeader("Allow", "POST, OPTIONS");
  response.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32_000, message: "Method not allowed in stateless mode" },
    id: null,
  });
}

function jsonRpcRequestId(body: unknown): string | number | null {
  if (body === null || typeof body !== "object" || !("id" in body)) return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" || id === null ? id : null;
}

export function createApp(dependencies: RuntimeDependencies): Express {
  const app = express();
  app.disable("x-powered-by");
  if (dependencies.config.trustProxyHops > 0) {
    app.set("trust proxy", dependencies.config.trustProxyHops);
  }

  app.use(requestIdMiddleware());
  app.use(createHostGuard(dependencies));

  if (dependencies.oauth) {
    app.use(dependencies.oauth.router());
  }

  app.get("/healthz", (_request, response) => {
    const services = configuredServices(dependencies.config);
    response.json({
      status: "ok",
      services: {
        lyfta: services.lyfta ? "configured" : "not_configured",
        yazio: services.yazio ? "configured" : "not_configured",
      },
    });
  });

  app.use("/mcp", createMcpOriginGuard(dependencies));

  app.options("/mcp", (_request, response) => {
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, Accept, Mcp-Protocol-Version",
    );
    response.status(204).end();
  });

  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);
  app.post(
    "/mcp",
    createMcpAuthMiddleware(dependencies.config, dependencies.logger, dependencies.oauth),
    express.json({ limit: MAX_JSON_BODY }),
    async (request, response) => {
      const server = createMcpServer({
        fitness: dependencies.fitness,
        redactor: dependencies.redactor,
        ...(dependencies.lyfta ? { lyfta: dependencies.lyfta } : {}),
        ...(dependencies.yazio ? { yazio: dependencies.yazio } : {}),
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      let closed = false;

      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await Promise.allSettled([transport.close(), server.close()]);
      };
      response.once("close", () => {
        void close();
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(request, response, request.body);
      } catch (error) {
        dependencies.logger.error("mcp_request_failed", {
          requestId: response.locals.requestId,
          error: safeErrorMessage(error, dependencies.redactor),
        });
        if (!response.headersSent) {
          response.status(500).json({
            jsonrpc: "2.0",
            error: { code: JSON_RPC_INTERNAL_ERROR, message: "Internal server error" },
            id: jsonRpcRequestId(request.body),
          });
        } else if (!response.writableEnded) {
          response.end();
        }
        await close();
      }
    },
  );

  app.all("/mcp", methodNotAllowed);

  app.use((_request, response) => {
    response.status(404).json({ error: "Not found" });
  });

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    dependencies.logger.warn("http_request_rejected", {
      requestId: response.locals.requestId,
      error: safeErrorMessage(error, dependencies.redactor),
    });
    if (response.headersSent) {
      response.end();
      return;
    }
    response.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32_700, message: "Invalid JSON request" },
      id: null,
    });
  };
  app.use(errorHandler);

  return app;
}
