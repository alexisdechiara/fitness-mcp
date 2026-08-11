const REDACTED = "[REDACTED]";
const SENSITIVE_KEY =
  /(?:authorization|cookie|credential|password|passwd|secret|token|api[_-]?key|username|email|first[_-]?name|last[_-]?name|stripe)/i;

export class SecretRedactor {
  private readonly secrets: string[];

  constructor(secrets: Array<string | undefined>) {
    this.secrets = [...new Set(secrets.filter((value): value is string => Boolean(value)))].sort(
      (left, right) => right.length - left.length,
    );
  }

  redactText(value: string): string {
    let result = value;
    for (const secret of this.secrets) {
      result = result.split(secret).join(REDACTED);
    }
    return result;
  }

  redact(value: unknown): unknown {
    return this.visit(value, new WeakSet<object>());
  }

  private visit(value: unknown, seen: WeakSet<object>): unknown {
    if (typeof value === "string") return this.redactText(value);
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    if (Array.isArray(value)) return value.map((entry) => this.visit(entry, seen));

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = SENSITIVE_KEY.test(key) ? REDACTED : this.visit(entry, seen);
    }
    return result;
  }
}

export function safeErrorMessage(error: unknown, redactor: SecretRedactor): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactor.redactText(raw).replace(/[\r\n]+/g, " ").slice(0, 500);
}
