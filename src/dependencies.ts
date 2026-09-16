import { LyftaClient } from "./clients/lyfta.js";
import { YazioClient } from "./clients/yazio.js";
import type { AppConfig } from "./config/env.js";
import { Logger, createRedactor } from "./logging/logger.js";
import type { McpServerDependencies } from "./mcp-server.js";
import { createOAuthService, type OAuthService } from "./oauth/service.js";
import { SecretRedactor } from "./security/redaction.js";
import { FitnessService } from "./services/fitness.js";

/**
 * Long-lived, immutable application dependencies. MCP server and transport
 * instances are deliberately not kept here: the HTTP layer creates one pair
 * per request so the endpoint remains stateless.
 */
export interface RuntimeDependencies extends McpServerDependencies {
  config: AppConfig;
  logger: Logger;
  redactor: SecretRedactor;
  oauth?: OAuthService;
}

export function createDependencies(config: AppConfig): RuntimeDependencies {
  const redactor = createRedactor(config);
  const logger = new Logger(config.logLevel, redactor);
  const oauth = config.mcpAuthMode === "oauth" ? createOAuthService(config, logger) : undefined;

  const lyfta = config.lyftaApiKey
    ? new LyftaClient(config.lyftaApiKey, {
        baseUrl: config.lyftaBaseUrl,
        timeoutMs: config.upstreamTimeoutMs,
      })
    : undefined;

  const yazio =
    config.yazioUsername && config.yazioPassword
      ? new YazioClient(config.yazioUsername, config.yazioPassword, {
          baseUrl: config.yazioBaseUrl,
          clientId: config.yazioClientId,
          clientSecret: config.yazioClientSecret,
          timeoutMs: config.upstreamTimeoutMs,
        })
      : undefined;

  const fitness = new FitnessService({
    ...(lyfta ? { lyfta } : {}),
    ...(yazio ? { yazio } : {}),
    maxRangeDays: config.maxRangeDays,
    maxWorkouts: config.maxWorkouts,
    concurrency: config.upstreamConcurrency,
  });

  return {
    config,
    logger,
    redactor,
    fitness,
    ...(oauth ? { oauth } : {}),
    ...(lyfta ? { lyfta } : {}),
    ...(yazio ? { yazio } : {}),
  };
}
