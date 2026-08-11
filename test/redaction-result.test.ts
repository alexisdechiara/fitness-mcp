import { describe, expect, it } from "vitest";
import { SecretRedactor, safeErrorMessage } from "../src/security/redaction.js";
import {
  errorResult,
  runTool,
  successResult,
} from "../src/tools/result.js";

const LONG_SECRET = "long-secret-value";

describe("SecretRedactor", () => {
  it("redacts short configured credentials even when embedded in a message", () => {
    const redactor = new SecretRedactor(["xy"]);

    expect(redactor.redactText("invalid password xy from upstream")).toBe(
      "invalid password [REDACTED] from upstream",
    );
  });

  it("redacts configured values, sensitive keys, arrays, and circular references recursively", () => {
    const redactor = new SecretRedactor([LONG_SECRET, LONG_SECRET, undefined]);
    const cyclic: Record<string, unknown> = { note: `prefix ${LONG_SECRET} suffix` };
    cyclic.self = cyclic;
    const input = {
      authorization: `Bearer ${LONG_SECRET}`,
      profile: {
        email: "person@example.test",
        displayName: `uses ${LONG_SECRET}`,
      },
      values: [LONG_SECRET, cyclic],
    };

    expect(redactor.redact(input)).toEqual({
      authorization: "[REDACTED]",
      profile: {
        email: "[REDACTED]",
        displayName: "uses [REDACTED]",
      },
      values: ["[REDACTED]", {
        note: "prefix [REDACTED] suffix",
        self: "[Circular]",
      }],
    });
    expect(input.authorization).toContain(LONG_SECRET);
  });

  it("flattens and bounds safe error messages after redacting secrets", () => {
    const redactor = new SecretRedactor([LONG_SECRET]);
    const message = `${LONG_SECRET}\r\n${"x".repeat(700)}`;

    const safe = safeErrorMessage(new Error(message), redactor);

    expect(safe).not.toContain(LONG_SECRET);
    expect(safe).not.toMatch(/[\r\n]/u);
    expect(safe).toHaveLength(500);
  });
});

describe("tool results", () => {
  it("produces equivalent redacted text and structured success content with JSON-safe bigints", () => {
    const redactor = new SecretRedactor([LONG_SECRET]);
    const result = successResult(
      {
        count: 12n,
        api_key: LONG_SECRET,
        nested: { message: `value=${LONG_SECRET}` },
      },
      redactor,
    );

    expect(result.structuredContent).toEqual({
      count: "12",
      api_key: "[REDACTED]",
      nested: { message: "value=[REDACTED]" },
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(result.structuredContent, null, 2),
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(LONG_SECRET);
  });

  it("wraps non-object success values for structured MCP clients", () => {
    const redactor = new SecretRedactor([]);

    expect(successResult([1, 2], redactor).structuredContent).toEqual({ value: [1, 2] });
    expect(successResult(undefined, redactor).structuredContent).toEqual({ value: null });
  });

  it("normalizes rejected tools into secret-free MCP errors", async () => {
    const redactor = new SecretRedactor([LONG_SECRET]);

    const result = await runTool(redactor, `Load\n${LONG_SECRET}`, async () => {
      throw new Error(`upstream rejected token ${LONG_SECRET}\r\nwith details`);
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        message: "Load [REDACTED] failed: upstream rejected token [REDACTED] with details",
      },
    });
    expect(JSON.stringify(result)).not.toContain(LONG_SECRET);
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(result.structuredContent, null, 2),
      },
    ]);
  });

  it("marks direct error results as MCP errors", () => {
    const result = errorResult("unavailable", new SecretRedactor([]), "Lyfta");

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { message: "Lyfta failed: unavailable" } },
    });
  });
});
