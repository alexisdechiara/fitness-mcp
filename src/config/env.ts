import { z } from "zod";

const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().url().optional(),
);

const integerFromEnvironment = (fallback: number, min: number, max: number) =>
  z.preprocess(
    (value) => (value === undefined || value === "" ? fallback : value),
    z.coerce.number().int().min(min).max(max),
  );

const booleanFromEnvironment = (fallback: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === "") return fallback;
    if (value === true || value === "true" || value === "1") return true;
    if (value === false || value === "false" || value === "0") return false;
    return value;
  }, z.boolean());

const DEFAULT_OAUTH_ISSUER_URL = "https://fitness.alexisdechiara.fr";
const DEFAULT_OAUTH_REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

const EnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: integerFromEnvironment(3000, 1, 65_535),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    LYFTA_API_KEY: optionalString,
    LYFTA_BASE_URL: z.string().url().default("https://my.lyfta.app"),
    YAZIO_USERNAME: optionalString,
    YAZIO_PASSWORD: optionalString,
    MCP_AUTH_MODE: z.enum(["oauth", "bearer", "none"]).default("oauth"),
    MCP_ACCESS_TOKEN: optionalString,
    MCP_ALLOWED_HOSTS: z.string().default("fitness.alexisdechiara.fr,localhost,127.0.0.1"),
    MCP_ALLOWED_ORIGINS: z.string().default(""),
    TRUST_PROXY_HOPS: integerFromEnvironment(0, 0, 5),
    OAUTH_ISSUER_URL: z.string().url().default(DEFAULT_OAUTH_ISSUER_URL),
    OAUTH_RESOURCE_URL: optionalUrl,
    OAUTH_STORE_PATH: z.string().trim().min(1).default("/data/oauth-store.json"),
    OAUTH_DCR_ENABLED: booleanFromEnvironment(true),
    OAUTH_ALLOWED_REDIRECT_URIS: z.string().default(DEFAULT_OAUTH_REDIRECT_URI),
    OAUTH_ACCESS_TOKEN_TTL_SECONDS: integerFromEnvironment(900, 60, 3_600),
    OAUTH_REFRESH_TOKEN_TTL_SECONDS: integerFromEnvironment(2_592_000, 3_600, 31_536_000),
    OAUTH_AUTH_CODE_TTL_SECONDS: integerFromEnvironment(90, 30, 600),
    OAUTH_SESSION_TTL_SECONDS: integerFromEnvironment(28_800, 300, 604_800),
    OAUTH_MAX_DYNAMIC_CLIENTS: integerFromEnvironment(100, 1, 10_000),
    FITNESS_ADMIN_USERNAME: optionalString,
    FITNESS_ADMIN_PASSWORD: optionalString,
    CLAUDE_CLIENT_ID: optionalString,
    CLAUDE_CLIENT_SECRET: optionalString,
    UPSTREAM_TIMEOUT_MS: integerFromEnvironment(15_000, 1_000, 120_000),
    UPSTREAM_RETRIES: integerFromEnvironment(2, 0, 4),
    UPSTREAM_CONCURRENCY: integerFromEnvironment(4, 1, 12),
    FITNESS_MAX_RANGE_DAYS: integerFromEnvironment(366, 1, 1_825),
    FITNESS_MAX_WORKOUTS: integerFromEnvironment(1_000, 100, 10_000),
  })
  .superRefine((env, context) => {
    if (env.MCP_AUTH_MODE === "bearer" && (!env.MCP_ACCESS_TOKEN || env.MCP_ACCESS_TOKEN.length < 32)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MCP_ACCESS_TOKEN"],
        message: "MCP_ACCESS_TOKEN must contain at least 32 characters in bearer mode.",
      });
    }

    if (env.NODE_ENV === "production" && env.MCP_AUTH_MODE === "none") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MCP_AUTH_MODE"],
        message: "MCP_AUTH_MODE=none is forbidden in production.",
      });
    }

    if ((env.CLAUDE_CLIENT_ID && !env.CLAUDE_CLIENT_SECRET) || (!env.CLAUDE_CLIENT_ID && env.CLAUDE_CLIENT_SECRET)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CLAUDE_CLIENT_ID"],
        message: "CLAUDE_CLIENT_ID and CLAUDE_CLIENT_SECRET must be configured together.",
      });
    }
    if (env.CLAUDE_CLIENT_SECRET && env.CLAUDE_CLIENT_SECRET.length < 32) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CLAUDE_CLIENT_SECRET"],
        message: "CLAUDE_CLIENT_SECRET must contain at least 32 characters.",
      });
    }

    if (env.MCP_AUTH_MODE !== "oauth") return;

    if (!env.FITNESS_ADMIN_USERNAME || !env.FITNESS_ADMIN_PASSWORD) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["FITNESS_ADMIN_USERNAME"],
        message: "FITNESS_ADMIN_USERNAME and FITNESS_ADMIN_PASSWORD are required in OAuth mode.",
      });
    } else if (env.FITNESS_ADMIN_PASSWORD.length < 16) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["FITNESS_ADMIN_PASSWORD"],
        message: "FITNESS_ADMIN_PASSWORD must contain at least 16 characters.",
      });
    }

    if (!env.OAUTH_DCR_ENABLED && (!env.CLAUDE_CLIENT_ID || !env.CLAUDE_CLIENT_SECRET)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["CLAUDE_CLIENT_ID"],
        message: "A pre-registered Claude client is required when OAUTH_DCR_ENABLED=false.",
      });
    }

    const issuer = new URL(env.OAUTH_ISSUER_URL);
    let resource: URL;
    try {
      resource = new URL(env.OAUTH_RESOURCE_URL ?? "/mcp", issuer);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OAUTH_ISSUER_URL"],
        message: "OAUTH_ISSUER_URL must be an HTTP(S) URL that can resolve /mcp.",
      });
      return;
    }
    if (issuer.protocol !== "http:" && issuer.protocol !== "https:") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OAUTH_ISSUER_URL"],
        message: "OAUTH_ISSUER_URL must use HTTP or HTTPS.",
      });
    }
    if (
      issuer.username ||
      issuer.password ||
      issuer.pathname !== "/" ||
      issuer.search ||
      issuer.hash
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OAUTH_ISSUER_URL"],
        message: "OAUTH_ISSUER_URL must be an origin URL without a path, userinfo, query, or fragment.",
      });
    }
    if (
      resource.origin !== issuer.origin ||
      resource.pathname !== "/mcp" ||
      resource.username ||
      resource.password ||
      resource.search ||
      resource.hash
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OAUTH_RESOURCE_URL"],
        message: "OAUTH_RESOURCE_URL must be the issuer's same-origin /mcp URL without userinfo, query, or fragment.",
      });
    }
    if (env.NODE_ENV === "production" && (issuer.protocol !== "https:" || resource.protocol !== "https:")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OAUTH_ISSUER_URL"],
        message: "OAuth issuer and resource URLs must use HTTPS in production.",
      });
    }

    const redirectUris = env.OAUTH_ALLOWED_REDIRECT_URIS.split(",").map((entry) => entry.trim()).filter(Boolean);
    if (redirectUris.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OAUTH_ALLOWED_REDIRECT_URIS"],
        message: "At least one OAuth redirect URI is required.",
      });
    }
    for (const redirectUri of redirectUris) {
      let parsed: URL;
      try {
        parsed = new URL(redirectUri);
      } catch {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["OAUTH_ALLOWED_REDIRECT_URIS"],
          message: `Invalid OAuth redirect URI: ${redirectUri}`,
        });
        continue;
      }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["OAUTH_ALLOWED_REDIRECT_URIS"],
          message: "OAuth redirect URIs must use HTTPS and must not contain userinfo or fragments.",
        });
      }
    }
  });

const csv = (value: string): string[] =>
  [...new Set(value.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean))];

const exactCsv = (value: string): string[] =>
  [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  lyftaApiKey?: string;
  lyftaBaseUrl: string;
  yazioUsername?: string;
  yazioPassword?: string;
  mcpAuthMode: "oauth" | "bearer" | "none";
  mcpAccessToken?: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  trustProxyHops: number;
  oauthIssuerUrl?: string;
  oauthResourceUrl?: string;
  oauthStorePath?: string;
  oauthDcrEnabled: boolean;
  oauthAllowedRedirectUris: string[];
  oauthAccessTokenTtlSeconds: number;
  oauthRefreshTokenTtlSeconds: number;
  oauthAuthCodeTtlSeconds: number;
  oauthSessionTtlSeconds: number;
  oauthMaxDynamicClients: number;
  fitnessAdminUsername?: string;
  fitnessAdminPassword?: string;
  claudeClientId?: string;
  claudeClientSecret?: string;
  upstreamTimeoutMs: number;
  upstreamRetries: number;
  upstreamConcurrency: number;
  maxRangeDays: number;
  maxWorkouts: number;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvironmentSchema.safeParse(environment);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }

  const env = parsed.data;
  const oauthIssuerUrl = new URL(env.OAUTH_ISSUER_URL).href.replace(/\/$/u, "");
  const oauthResourceUrl = new URL(env.OAUTH_RESOURCE_URL ?? "/mcp", oauthIssuerUrl).href;
  // Upstreams are optional. In particular, accounts created through Google do
  // not necessarily have a Yazio password: an incomplete pair therefore
  // disables Yazio instead of preventing the independent MCP/OAuth service and
  // the Lyfta tools from starting.
  const yazioConfigured = Boolean(env.YAZIO_USERNAME && env.YAZIO_PASSWORD);
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    ...(env.LYFTA_API_KEY ? { lyftaApiKey: env.LYFTA_API_KEY } : {}),
    lyftaBaseUrl: env.LYFTA_BASE_URL,
    ...(yazioConfigured ? { yazioUsername: env.YAZIO_USERNAME, yazioPassword: env.YAZIO_PASSWORD } : {}),
    mcpAuthMode: env.MCP_AUTH_MODE,
    ...(env.MCP_ACCESS_TOKEN ? { mcpAccessToken: env.MCP_ACCESS_TOKEN } : {}),
    allowedHosts: csv(env.MCP_ALLOWED_HOSTS),
    allowedOrigins: csv(env.MCP_ALLOWED_ORIGINS),
    trustProxyHops: env.TRUST_PROXY_HOPS,
    ...(env.MCP_AUTH_MODE === "oauth" ? { oauthIssuerUrl, oauthResourceUrl, oauthStorePath: env.OAUTH_STORE_PATH } : {}),
    oauthDcrEnabled: env.OAUTH_DCR_ENABLED,
    oauthAllowedRedirectUris: exactCsv(env.OAUTH_ALLOWED_REDIRECT_URIS),
    oauthAccessTokenTtlSeconds: env.OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    oauthRefreshTokenTtlSeconds: env.OAUTH_REFRESH_TOKEN_TTL_SECONDS,
    oauthAuthCodeTtlSeconds: env.OAUTH_AUTH_CODE_TTL_SECONDS,
    oauthSessionTtlSeconds: env.OAUTH_SESSION_TTL_SECONDS,
    oauthMaxDynamicClients: env.OAUTH_MAX_DYNAMIC_CLIENTS,
    ...(env.FITNESS_ADMIN_USERNAME ? { fitnessAdminUsername: env.FITNESS_ADMIN_USERNAME } : {}),
    ...(env.FITNESS_ADMIN_PASSWORD ? { fitnessAdminPassword: env.FITNESS_ADMIN_PASSWORD } : {}),
    ...(env.CLAUDE_CLIENT_ID ? { claudeClientId: env.CLAUDE_CLIENT_ID } : {}),
    ...(env.CLAUDE_CLIENT_SECRET ? { claudeClientSecret: env.CLAUDE_CLIENT_SECRET } : {}),
    upstreamTimeoutMs: env.UPSTREAM_TIMEOUT_MS,
    upstreamRetries: env.UPSTREAM_RETRIES,
    upstreamConcurrency: env.UPSTREAM_CONCURRENCY,
    maxRangeDays: env.FITNESS_MAX_RANGE_DAYS,
    maxWorkouts: env.FITNESS_MAX_WORKOUTS,
  };
}

export function configuredServices(config: AppConfig): { lyfta: boolean; yazio: boolean } {
  return {
    lyfta: Boolean(config.lyftaApiKey),
    yazio: Boolean(config.yazioUsername && config.yazioPassword),
  };
}
