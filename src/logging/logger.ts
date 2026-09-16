import type { AppConfig } from "../config/env.js";
import { SecretRedactor } from "../security/redaction.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type LogLevel = keyof typeof LEVELS;

export class Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly redactor: SecretRedactor,
  ) {}

  debug(event: string, fields: Record<string, unknown> = {}): void {
    this.write("debug", event, fields);
  }

  info(event: string, fields: Record<string, unknown> = {}): void {
    this.write("info", event, fields);
  }

  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.write("warn", event, fields);
  }

  error(event: string, fields: Record<string, unknown> = {}): void {
    this.write("error", event, fields);
  }

  private write(level: LogLevel, event: string, fields: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const entry = this.redactor.redact({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...fields,
    });
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  }
}

export function createRedactor(config: AppConfig): SecretRedactor {
  return new SecretRedactor([
    config.lyftaApiKey,
    config.yazioUsername,
    config.yazioPassword,
    config.yazioClientSecret,
    config.mcpAccessToken,
    config.fitnessAdminUsername,
    config.fitnessAdminPassword,
    config.claudeClientSecret,
  ]);
}
