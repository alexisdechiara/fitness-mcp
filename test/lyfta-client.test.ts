import { afterEach, describe, expect, it, vi } from "vitest";
import { LyftaApiError, LyftaClient } from "../src/clients/lyfta.js";

const API_KEY = "lyfta-super-secret-api-key";

function asFetch(
  implementation: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch {
  return implementation as typeof fetch;
}

async function caughtError(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected the action to reject.");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("LyftaClient", () => {
  it("maps every read method to the documented URL and keeps authentication in headers", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ status: true }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new LyftaClient(API_KEY, {
      baseUrl: "https://lyfta.example.test/an/ignored/base/path",
      fetchImpl: asFetch(fetchMock),
    });

    await client.listWorkouts({ page: 2, limit: 10 });
    await client.listWorkoutSummaries({ page: 3, limit: 1_000 });
    await client.listExercises({ limit: 25 });
    await client.searchExerciseLibrary({ search: "bench press", limit: 20, offset: 40 });
    await client.getExerciseProgress({ exercise_id: "exercise/42", duration: 90 });
    await client.listClients();

    const requests = fetchMock.mock.calls.map(([input, init]) => ({
      url: new URL(String(input)),
      init,
    }));
    expect(
      requests.map(({ url }) => ({
        origin: url.origin,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
      })),
    ).toEqual([
      {
        origin: "https://lyfta.example.test",
        path: "/api/v1/workouts",
        query: { page: "2", limit: "10" },
      },
      {
        origin: "https://lyfta.example.test",
        path: "/api/v1/workouts/summary",
        query: { page: "3", limit: "1000" },
      },
      {
        origin: "https://lyfta.example.test",
        path: "/api/v1/exercises",
        query: { limit: "25" },
      },
      {
        origin: "https://lyfta.example.test",
        path: "/api/v1/exercises/library",
        query: { search: "bench press", limit: "20", offset: "40" },
      },
      {
        origin: "https://lyfta.example.test",
        path: "/api/v1/exercises/progress",
        query: { exercise_id: "exercise/42", duration: "90" },
      },
      {
        origin: "https://lyfta.example.test",
        path: "/api/v1/clients",
        query: {},
      },
    ]);

    for (const { url, init } of requests) {
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${API_KEY}`);
      expect(new Headers(init?.headers).get("accept")).toBe("application/json");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(url.href).not.toContain(API_KEY);
    }
  });

  it("turns an aborted request into a bounded, secret-free timeout error", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        requestSignal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(new Error(`transport aborted with ${API_KEY}`)),
            { once: true },
          );
        });
      },
    );
    const client = new LyftaClient(API_KEY, {
      fetchImpl: asFetch(fetchMock),
      timeoutMs: 25,
    });

    const pending = caughtError(() => client.listWorkouts());
    await vi.advanceTimersByTimeAsync(25);
    const error = await pending;

    expect(error).toBeInstanceOf(LyftaApiError);
    expect(error).toMatchObject({ status: 408 });
    expect(error.message).toBe("Lyfta request timed out after 25ms.");
    expect(error.message).not.toContain(API_KEY);
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the timeout active while reading the response body", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        requestSignal = init?.signal;
        return {
          status: 200,
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => await new Promise<unknown>(() => undefined),
        } as Response;
      },
    );
    const client = new LyftaClient(API_KEY, {
      fetchImpl: asFetch(fetchMock),
      timeoutMs: 25,
    });

    const pending = caughtError(() => client.listWorkouts());
    await vi.advanceTimersByTimeAsync(25);
    const error = await pending;

    expect(error).toBeInstanceOf(LyftaApiError);
    expect(error).toMatchObject({ status: 408 });
    expect(error.message).toBe("Lyfta request timed out after 25ms.");
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("normalizes rate limits and non-JSON upstream responses without leaking credentials", async () => {
    const rateLimited = new LyftaClient(API_KEY, {
      fetchImpl: asFetch(async () =>
        new Response("upstream body containing " + API_KEY, {
          status: 429,
          headers: { "retry-after": "17" },
        }),
      ),
    });
    const invalidJson = new LyftaClient(API_KEY, {
      fetchImpl: asFetch(async () =>
        new Response("upstream body containing " + API_KEY, { status: 502 }),
      ),
    });

    const rateLimitError = await caughtError(() => rateLimited.listWorkouts());
    const invalidJsonError = await caughtError(() => invalidJson.listWorkouts());

    expect(rateLimitError).toMatchObject({ status: 429, retryAfter: "17" });
    expect(rateLimitError.message).toMatch(/rate limit/u);
    expect(invalidJsonError).toMatchObject({ status: 502 });
    expect(invalidJsonError.message).toBe("Lyfta returned a non-JSON response (HTTP 502).");
    expect(`${rateLimitError.message} ${invalidJsonError.message}`).not.toContain(API_KEY);
  });

  it("does not expose a credential echoed in an upstream JSON error", async () => {
    const client = new LyftaClient(API_KEY, {
      fetchImpl: asFetch(async () =>
        new Response(
          JSON.stringify({
            status: false,
            message: `invalid Authorization: Bearer ${API_KEY}`,
          }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    });

    const error = await caughtError(() => client.listWorkouts());

    expect(error).toBeInstanceOf(LyftaApiError);
    expect(error).toMatchObject({ status: 401 });
    expect(error.message).not.toContain(API_KEY);
  });
});
