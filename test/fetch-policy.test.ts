import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UpstreamNetworkError,
  createFetchWithPolicy,
} from "../src/http/fetch-policy.js";

function asFetch(
  implementation: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch {
  return implementation as typeof fetch;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createFetchWithPolicy", () => {
  it("bounds retryable GET network failures to retries + 1 attempts", async () => {
    vi.useFakeTimers();
    const baseFetch = vi.fn(async () => {
      throw new TypeError("socket closed");
    });
    const policyFetch = createFetchWithPolicy(asFetch(baseFetch), {
      timeoutMs: 5_000,
      retries: 2,
    });

    const rejection = expect(policyFetch("https://upstream.example/data")).rejects.toMatchObject({
      name: "UpstreamNetworkError",
      timedOut: false,
      message: "Temporary upstream network failure.",
    });
    await vi.runAllTimersAsync();
    await rejection;

    expect(baseFetch).toHaveBeenCalledTimes(3);
  });

  it("never retries ordinary POST requests", async () => {
    const baseFetch = vi.fn(async () => {
      throw new TypeError("socket closed");
    });
    const policyFetch = createFetchWithPolicy(asFetch(baseFetch), {
      timeoutMs: 5_000,
      retries: 5,
    });

    await expect(
      policyFetch("https://upstream.example/user/water", { method: "POST" }),
    ).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it("allows only the OAuth token POST exception to use bounded retries", async () => {
    vi.useFakeTimers();
    const baseFetch = vi.fn(async () => {
      throw new TypeError("socket closed");
    });
    const policyFetch = createFetchWithPolicy(asFetch(baseFetch), {
      timeoutMs: 5_000,
      retries: 1,
    });

    const rejection = expect(
      policyFetch("https://yzapi.yazio.com/v15/oauth/token", { method: "POST" }),
    ).rejects.toBeInstanceOf(UpstreamNetworkError);
    await vi.runAllTimersAsync();
    await rejection;

    expect(baseFetch).toHaveBeenCalledTimes(2);
  });

  it("bounds timeouts across retries and reports the final timeout", async () => {
    vi.useFakeTimers();
    const baseFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const policyFetch = createFetchWithPolicy(asFetch(baseFetch), {
      timeoutMs: 20,
      retries: 1,
    });

    const rejection = expect(policyFetch("https://upstream.example/data")).rejects.toMatchObject({
      name: "UpstreamNetworkError",
      timedOut: true,
      message: "Upstream request timed out after 20ms.",
    });
    await vi.runAllTimersAsync();
    await rejection;

    expect(baseFetch).toHaveBeenCalledTimes(2);
  });

  it("returns materialized HTTP error responses without retrying them", async () => {
    const response = new Response("unavailable", { status: 503 });
    const baseFetch = vi.fn(async () => response);
    const policyFetch = createFetchWithPolicy(asFetch(baseFetch), {
      timeoutMs: 5_000,
      retries: 3,
    });

    const result = await policyFetch("https://upstream.example/data");

    expect(result.status).toBe(503);
    await expect(result.text()).resolves.toBe("unavailable");
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps timeout and bounded retries active while downloading a response body", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const baseFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(encoder.encode('{"partial":'));
            init?.signal?.addEventListener(
              "abort",
              () => stream.error(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          },
        });
        return new Response(body, {
          headers: { "content-type": "application/json" },
        });
      },
    );
    const policyFetch = createFetchWithPolicy(asFetch(baseFetch), {
      timeoutMs: 20,
      retries: 1,
    });

    const rejection = expect(policyFetch("https://upstream.example/data")).rejects.toMatchObject({
      name: "UpstreamNetworkError",
      timedOut: true,
      message: "Upstream request timed out after 20ms.",
    });
    await vi.runAllTimersAsync();
    await rejection;

    expect(baseFetch).toHaveBeenCalledTimes(2);
  });

  it("honors an AbortSignal carried by a Request object", async () => {
    const caller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const baseFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal;
        notifyStarted?.();
        return await new Promise<Response>((_resolve, reject) => {
          receivedSignal?.addEventListener(
            "abort",
            () => reject(receivedSignal?.reason),
            { once: true },
          );
        });
      },
    );
    const policyFetch = createFetchWithPolicy(asFetch(baseFetch), {
      timeoutMs: 5_000,
      retries: 2,
    });
    const request = new Request("https://upstream.example/data", {
      signal: caller.signal,
    });
    const reason = new Error("caller stopped request");

    const pending = policyFetch(request);
    const rejection = expect(pending).rejects.toBe(reason);
    await started;
    caller.abort(reason);
    await rejection;

    expect(receivedSignal?.aborted).toBe(true);
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it("cancels retry backoff immediately and does not start another attempt", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const reason = new Error("caller cancelled during backoff");
    const baseFetch = vi.fn(async () => {
      throw new TypeError("socket closed");
    });
    const policyFetch = createFetchWithPolicy(asFetch(baseFetch), {
      timeoutMs: 5_000,
      retries: 3,
    });

    const pending = policyFetch("https://upstream.example/data", {
      signal: caller.signal,
    });
    const rejection = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(baseFetch).toHaveBeenCalledTimes(1);

    caller.abort(reason);
    await rejection;

    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
