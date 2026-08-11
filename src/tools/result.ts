import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SecretRedactor, safeErrorMessage } from "../security/redaction.js";

type StructuredContent = Record<string, unknown>;

function jsonSafe(value: unknown, redactor: SecretRedactor): unknown {
  const redacted = redactor.redact(value);
  const serialized = JSON.stringify(redacted, (_key, entry: unknown) =>
    typeof entry === "bigint" ? entry.toString() : entry,
  );

  return serialized === undefined ? null : (JSON.parse(serialized) as unknown);
}

function asStructuredContent(value: unknown): StructuredContent {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as StructuredContent;
  }
  return { value };
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Build a result that is useful to both legacy text-only clients and MCP clients
 * that consume structuredContent. All upstream data is redacted before either
 * representation is produced.
 */
export function successResult(value: unknown, redactor: SecretRedactor): CallToolResult {
  const safeValue = jsonSafe(value, redactor);
  return {
    content: [{ type: "text", text: jsonText(safeValue) }],
    structuredContent: asStructuredContent(safeValue),
  };
}

export function errorResult(
  error: unknown,
  redactor: SecretRedactor,
  operation = "Tool request",
): CallToolResult {
  const safeOperation = redactor.redactText(operation).replace(/[\r\n]+/g, " ").slice(0, 120);
  const payload = {
    error: {
      message: `${safeOperation} failed: ${safeErrorMessage(error, redactor)}`,
    },
  };

  return {
    content: [{ type: "text", text: jsonText(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

export async function runTool(
  redactor: SecretRedactor,
  operation: string,
  execute: () => Promise<unknown>,
): Promise<CallToolResult> {
  try {
    return successResult(await execute(), redactor);
  } catch (error) {
    return errorResult(error, redactor, operation);
  }
}

export function unavailableService(service: "Lyfta" | "Yazio"): Error {
  return new Error(`${service} is not configured on this server.`);
}
