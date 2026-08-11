export class UpstreamNetworkError extends Error {
  constructor(
    message: string,
    public readonly timedOut: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UpstreamNetworkError";
  }
}

export interface FetchPolicyOptions {
  timeoutMs: number;
  retries: number;
}

function requestMethod(input: Parameters<typeof fetch>[0], init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  return input instanceof Request ? input.method.toUpperCase() : "GET";
}

function requestPath(input: Parameters<typeof fetch>[0]): string {
  try {
    return new URL(input instanceof Request ? input.url : String(input)).pathname;
  } catch {
    return "";
  }
}

function mayRetry(input: Parameters<typeof fetch>[0], init?: RequestInit): boolean {
  const method = requestMethod(input, init);
  return method === "GET" || method === "HEAD" || requestPath(input).endsWith("/oauth/token");
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortReason(signal);

  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal ? abortReason(signal) : new DOMException("This operation was aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Upstreams in this service are JSON APIs. Buffering their response before
 * returning keeps network/body failures inside the timeout and retry policy.
 */
async function materializeResponse(response: Response): Promise<Response> {
  const body = response.body === null ? null : await response.arrayBuffer();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createFetchWithPolicy(
  baseFetch: typeof fetch,
  options: FetchPolicyOptions,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const retryable = mayRetry(input, init);
    const attempts = retryable ? options.retries + 1 : 1;
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (callerSignal?.aborted) throw abortReason(callerSignal);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
      timeout.unref?.();
      const abortFromCaller = () => controller.abort(callerSignal?.reason);
      callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

      try {
        const response = await baseFetch(input, { ...init, signal: controller.signal });
        return await materializeResponse(response);
      } catch (error) {
        if (callerSignal?.aborted) throw abortReason(callerSignal);
        lastError = error;
        if (attempt + 1 >= attempts) {
          const timedOut = controller.signal.aborted;
          throw new UpstreamNetworkError(
            timedOut
              ? `Upstream request timed out after ${options.timeoutMs}ms.`
              : "Temporary upstream network failure.",
            timedOut,
            { cause: error },
          );
        }
      } finally {
        clearTimeout(timeout);
        callerSignal?.removeEventListener("abort", abortFromCaller);
      }

      await delay(Math.min(1_000, 100 * 3 ** attempt), callerSignal ?? undefined);
    }

    throw new UpstreamNetworkError("Temporary upstream network failure.", false, {
      cause: lastError,
    });
  }) as typeof fetch;
}

export function installGlobalFetchPolicy(options: FetchPolicyOptions): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = createFetchWithPolicy(original, options);
  return () => {
    globalThis.fetch = original;
  };
}
