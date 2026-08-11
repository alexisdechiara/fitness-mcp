import "dotenv/config";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import { createApp } from "./app.js";
import { loadConfig, type AppConfig } from "./config/env.js";
import { createDependencies } from "./dependencies.js";
import { installGlobalFetchPolicy } from "./http/fetch-policy.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface RunningApplication {
  server: Server;
  shutdown(signal?: string): Promise<void>;
}

export function startServer(config: AppConfig = loadConfig()): RunningApplication {
  const restoreFetch = installGlobalFetchPolicy({
    timeoutMs: config.upstreamTimeoutMs,
    retries: config.upstreamRetries,
  });

  let dependencies: ReturnType<typeof createDependencies>;
  try {
    dependencies = createDependencies(config);
  } catch (error) {
    restoreFetch();
    throw error;
  }

  const app = createApp(dependencies);
  const server = app.listen(config.port, "0.0.0.0", () => {
    dependencies.logger.info("server_started", {
      port: config.port,
      authentication: config.mcpAuthMode,
    });
  });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal = "application"): Promise<void> => {
    shutdownPromise ??= (async () => {
      dependencies.logger.info("server_stopping", { signal });

      let forced = false;
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections?.();
      });
      const timeout = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          forced = true;
          server.closeAllConnections?.();
          resolve();
        }, SHUTDOWN_TIMEOUT_MS);
        timer.unref?.();
      });

      try {
        await Promise.race([closed, timeout]);
        dependencies.logger.info("server_stopped", { forced });
      } finally {
        restoreFetch();
      }
    })();
    return shutdownPromise;
  };

  return { server, shutdown };
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntrypoint()) {
  try {
    const running = startServer();
    const onSignal = (signal: NodeJS.Signals): void => {
      void running.shutdown(signal).catch((error: unknown) => {
        process.stderr.write(
          `${JSON.stringify({ level: "error", event: "server_shutdown_failed", error: String(error) })}\n`,
        );
        process.exitCode = 1;
      });
    };

    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ level: "error", event: "server_start_failed", error: String(error) })}\n`,
    );
    process.exitCode = 1;
  }
}
