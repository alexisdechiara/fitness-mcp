import { request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config/env.js";
import { createDependencies } from "../src/dependencies.js";

const servers = new Set<Server>();

function testConfig(overrides: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    MCP_AUTH_MODE: "none",
    MCP_ALLOWED_HOSTS: "127.0.0.1,localhost",
    MCP_ALLOWED_ORIGINS: "",
    ...overrides,
  });
}

async function serve(config: AppConfig): Promise<{ baseUrl: string; server: Server }> {
  const app = createApp(createDependencies(config));
  const server = app.listen(0, "127.0.0.1");
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port.");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function requestWithHost(url: string, host: string): Promise<number | undefined> {
  const target = new URL(url);
  return await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        headers: { Host: host },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        }),
    ),
  );
  servers.clear();
});

describe("configuration", () => {
  it("disables Yazio instead of blocking startup when only one credential is present", () => {
    const usernameOnly = testConfig({ YAZIO_USERNAME: "person@example.test" });
    const passwordOnly = testConfig({ YAZIO_PASSWORD: "yazio-test-secret" });

    expect(usernameOnly).not.toHaveProperty("yazioUsername");
    expect(usernameOnly).not.toHaveProperty("yazioPassword");
    expect(passwordOnly).not.toHaveProperty("yazioUsername");
    expect(passwordOnly).not.toHaveProperty("yazioPassword");
  });

  it("requires a strong access token in bearer mode", () => {
    expect(() =>
      testConfig({
        MCP_AUTH_MODE: "bearer",
        MCP_ACCESS_TOKEN: "too-short",
      }),
    ).toThrow(/at least 32 characters/u);
  });

  it("forbids unauthenticated production mode", () => {
    expect(() =>
      testConfig({
        NODE_ENV: "production",
        MCP_AUTH_MODE: "none",
      }),
    ).toThrow(/forbidden in production/u);
  });

  it("requires administrator credentials in OAuth mode", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        MCP_AUTH_MODE: "oauth",
        OAUTH_DCR_ENABLED: "true",
      }),
    ).toThrow(/FITNESS_ADMIN_USERNAME/u);
  });

  it("requires a strong pre-registered client when DCR is disabled", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        MCP_AUTH_MODE: "oauth",
        OAUTH_DCR_ENABLED: "false",
        FITNESS_ADMIN_USERNAME: "admin",
        FITNESS_ADMIN_PASSWORD: "a-long-administrator-password",
      }),
    ).toThrow(/pre-registered Claude client/u);
  });

  it("rejects insecure OAuth URLs in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        MCP_AUTH_MODE: "oauth",
        OAUTH_DCR_ENABLED: "true",
        OAUTH_ISSUER_URL: "http://fitness.example",
        OAUTH_RESOURCE_URL: "http://fitness.example/mcp",
        OAUTH_ALLOWED_REDIRECT_URIS: "http://attacker.example/callback",
        FITNESS_ADMIN_USERNAME: "admin",
        FITNESS_ADMIN_PASSWORD: "a-long-administrator-password",
      }),
    ).toThrow(/HTTPS/u);
  });
});

describe("HTTP application", () => {
  it("serves a public root status without requiring either upstream", async () => {
    const { baseUrl } = await serve(testConfig());

    const response = await fetch(baseUrl);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      name: "fitness-mcp",
      status: "ok",
      endpoint: "/mcp",
      services: { lyfta: "not_configured", yazio: "not_configured" },
    });
  });

  it("starts in health-only mode when neither upstream is configured", async () => {
    const { baseUrl } = await serve(testConfig());

    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      services: { lyfta: "not_configured", yazio: "not_configured" },
    });
  });

  it("reports configured upstreams without checking their credentials", async () => {
    const config = testConfig({
      LYFTA_API_KEY: "lyfta-test-secret",
      YAZIO_USERNAME: "person@example.test",
      YAZIO_PASSWORD: "yazio-test-secret",
    });
    const { baseUrl } = await serve(config);

    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      services: { lyfta: "configured", yazio: "configured" },
    });
  });

  it("rejects untrusted Host and Origin headers", async () => {
    const config = testConfig({ MCP_ALLOWED_ORIGINS: "https://trusted.example" });
    const { baseUrl } = await serve(config);

    const badHostStatus = await requestWithHost(`${baseUrl}/healthz`, "attacker.example");
    const badOrigin = await fetch(`${baseUrl}/mcp`, {
      headers: { Origin: "https://attacker.example" },
    });

    expect(badHostStatus).toBe(403);
    expect(badOrigin.status).toBe(403);
  });

  it("returns 405 for stateful MCP methods", async () => {
    const { baseUrl } = await serve(testConfig());

    const [getResponse, deleteResponse] = await Promise.all([
      fetch(`${baseUrl}/mcp`),
      fetch(`${baseUrl}/mcp`, { method: "DELETE" }),
    ]);

    expect(getResponse.status).toBe(405);
    expect(deleteResponse.status).toBe(405);
    expect(getResponse.headers.get("allow")).toContain("POST");
  });

  it("protects POST /mcp with a bearer token", async () => {
    const token = "test-token-that-is-at-least-32-characters-long";
    const config = testConfig({
      MCP_AUTH_MODE: "bearer",
      MCP_ACCESS_TOKEN: token,
    });
    const { baseUrl } = await serve(config);

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/u);
    expect(body).not.toContain(token);
  });

  it("serves an MCP initialize request over stateless Streamable HTTP", async () => {
    const token = "test-token-that-is-at-least-32-characters-long";
    const config = testConfig({
      MCP_AUTH_MODE: "bearer",
      MCP_ACCESS_TOKEN: token,
    });
    const { baseUrl } = await serve(config);

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "fitness-mcp-test", version: "1.0.0" },
        },
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("fitness-mcp");
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(body).not.toContain(token);
  });
});
