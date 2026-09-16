import { afterEach, describe, expect, it, vi } from "vitest";
import { YazioApiError, YazioClient } from "../src/clients/yazio.js";

const USERNAME = "athlete@example.test";
const PASSWORD = "yazio-super-secret-password";
const BASE_URL = "https://yazio.example.test/v15";

function asFetch(
  implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return implementation as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function token(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token_type: "bearer",
    access_token: "access-1",
    refresh_token: "refresh-1",
    expires_in: 172_800,
    ...overrides,
  };
}

interface Exchange {
  url: URL;
  init: RequestInit | undefined;
  body: URLSearchParams;
}

/** Route token requests and reads separately, recording every exchange. */
function routedFetch(handlers: {
  token?: (body: URLSearchParams, call: number) => Response;
  read?: (url: URL, call: number) => Response;
}): { fetchImpl: typeof fetch; tokenCalls: Exchange[]; readCalls: Exchange[] } {
  const tokenCalls: Exchange[] = [];
  const readCalls: Exchange[] = [];
  const fetchImpl = asFetch(async (input, init) => {
    const url = new URL(String(input));
    const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    if (url.pathname.endsWith("/oauth/token")) {
      tokenCalls.push({ url, init, body });
      return handlers.token?.(body, tokenCalls.length) ?? json(token());
    }
    readCalls.push({ url, init, body });
    return handlers.read?.(url, readCalls.length) ?? json({ ok: true });
  });
  return { fetchImpl, tokenCalls, readCalls };
}

function createClient(fetchImpl: typeof fetch, timeoutMs?: number): YazioClient {
  return new YazioClient(USERNAME, PASSWORD, {
    baseUrl: BASE_URL,
    fetchImpl,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
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

describe("YazioClient", () => {
  it("exchanges credentials as a form, which is the only encoding the endpoint reads", async () => {
    const { fetchImpl, tokenCalls } = routedFetch({});
    const client = createClient(fetchImpl);

    await client.getSettings();

    expect(tokenCalls).toHaveLength(1);
    const [exchange] = tokenCalls;
    expect(exchange?.url.href).toBe(`${BASE_URL}/oauth/token`);
    expect(exchange?.init?.method).toBe("POST");
    expect(new Headers(exchange?.init?.headers).get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(typeof exchange?.init?.body).toBe("string");
    expect(Object.fromEntries(exchange?.body ?? [])).toEqual({
      client_id: "1_4hiybetvfksgw40o0sog4s884kwc840wwso8go4k8c04goo4c",
      client_secret: "6rok2m65xuskgkgogw40wkkk8sw0osg84s8cggsc4woos4s8o",
      grant_type: "password",
      username: USERNAME,
      password: PASSWORD,
    });
  });

  it("maps every read to the documented URL and keeps the token in headers", async () => {
    const { fetchImpl, readCalls } = routedFetch({});
    const client = createClient(fetchImpl);

    await client.getDailySummary("2026-08-01");
    await client.getConsumedItems("2026-08-01");
    await client.getExercises("2026-08-01");
    await client.getWaterIntake("2026-08-01");
    await client.getGoals("2026-08-01");
    await client.getGoals();
    await client.getSettings();
    await client.getDietaryPreferences();
    await client.getSuggestedProducts("2026-08-01", "lunch");
    await client.searchProducts({ query: "tofu", sex: "female", countries: ["FR"], locales: ["fr_FR"] });
    await client.searchProducts({ query: "tofu" });

    expect(
      readCalls.map(({ url }) => ({
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
      })),
    ).toEqual([
      { path: "/v15/user/widgets/daily-summary", query: { date: "2026-08-01" } },
      { path: "/v15/user/consumed-items", query: { date: "2026-08-01" } },
      { path: "/v15/user/exercises", query: { date: "2026-08-01" } },
      { path: "/v15/user/water-intake", query: { date: "2026-08-01" } },
      { path: "/v15/user/goals/unmodified", query: { date: "2026-08-01" } },
      { path: "/v15/user/goals/unmodified", query: {} },
      { path: "/v15/user/settings", query: {} },
      { path: "/v15/user/dietary-preferences", query: {} },
      {
        path: "/v15/user/products/suggested",
        query: { date: "2026-08-01", daytime: "lunch" },
      },
      {
        path: "/v15/products/search",
        query: { query: "tofu", sex: "female", countries: "FR", locales: "fr_FR" },
      },
      {
        path: "/v15/products/search",
        query: { query: "tofu", sex: "male", countries: "DE,US", locales: "en_US,de_US" },
      },
    ]);

    for (const { url, init } of readCalls) {
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-1");
      expect(new Headers(init?.headers).get("accept")).toBe("application/json");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(url.href).not.toContain(PASSWORD);
    }
  });

  it("restores the product identifier the upstream payload omits", async () => {
    const id = "4ceff6e9-78ce-441b-964a-22e81c1dee92";
    const { fetchImpl, readCalls } = routedFetch({
      read: () => json({ name: "Tofu nature" }),
    });

    await expect(createClient(fetchImpl).getProduct(id)).resolves.toEqual({
      name: "Tofu nature",
      id,
    });
    expect(readCalls[0]?.url.pathname).toBe(`/v15/products/${id}`);
  });

  it("logs in once for concurrent reads instead of one login per date", async () => {
    const { fetchImpl, tokenCalls, readCalls } = routedFetch({});
    const client = createClient(fetchImpl);

    await Promise.all([
      client.getDailySummary("2026-08-01"),
      client.getDailySummary("2026-08-02"),
      client.getDailySummary("2026-08-03"),
    ]);
    await client.getDailySummary("2026-08-04");

    expect(tokenCalls).toHaveLength(1);
    expect(readCalls).toHaveLength(4);
  });

  it("renews an expired token with the refresh grant and falls back to a full login", async () => {
    const { fetchImpl, tokenCalls } = routedFetch({
      // A one-second lifetime is always stale once the renewal margin applies.
      token: (body, call) =>
        body.get("grant_type") === "refresh_token" && call === 2
          ? json({ error: "invalid_grant", error_description: "Refresh token expired" }, 400)
          : json(token({ access_token: `access-${call}`, refresh_token: `refresh-${call}`, expires_in: 1 })),
    });
    const client = createClient(fetchImpl);

    await client.getSettings();
    await client.getSettings();
    await client.getSettings();

    expect(
      tokenCalls.map(({ body }) => ({
        grant: body.get("grant_type"),
        refresh: body.get("refresh_token"),
      })),
    ).toEqual([
      { grant: "password", refresh: null },
      { grant: "refresh_token", refresh: "refresh-1" },
      // The rejected refresh falls back to the password grant on the same read.
      { grant: "password", refresh: null },
      { grant: "refresh_token", refresh: "refresh-3" },
    ]);
  });

  it("replays a read once after the upstream revokes the cached token", async () => {
    const { fetchImpl, tokenCalls, readCalls } = routedFetch({
      token: (_body, call) => json(token({ access_token: `access-${call}` })),
      read: (_url, call) => (call === 1 ? json({ error: "invalid_token" }, 401) : json({ ok: true })),
    });
    const client = createClient(fetchImpl);

    await expect(client.getSettings()).resolves.toEqual({ ok: true });

    expect(tokenCalls).toHaveLength(2);
    expect(
      readCalls.map(({ init }) => new Headers(init?.headers).get("authorization")),
    ).toEqual(["Bearer access-1", "Bearer access-2"]);
  });

  it("reports a rejected login without echoing the password", async () => {
    const { fetchImpl } = routedFetch({
      token: () =>
        json(
          {
            error: "invalid_grant",
            error_description: `Invalid credentials for ${USERNAME} / ${PASSWORD}`,
          },
          400,
        ),
    });

    const error = await caughtError(() => createClient(fetchImpl).getSettings());

    expect(error).toBeInstanceOf(YazioApiError);
    expect(error).toMatchObject({ status: 400 });
    expect(error.message).toMatch(/^Yazio authentication failed \(HTTP 400\): invalid_grant: /u);
    // The upstream description is quoted, so the tool layer redactor still runs on it.
    expect(error.message.length).toBeLessThanOrEqual(400);
  });

  it("normalizes failed and non-JSON upstream reads", async () => {
    const failing = createClient(
      routedFetch({ read: () => json({ error: "server_error" }, 503) }).fetchImpl,
    );
    const invalidJson = createClient(
      routedFetch({ read: () => new Response("<html>gateway</html>", { status: 200 }) }).fetchImpl,
    );

    const failure = await caughtError(() => failing.getSettings());
    const nonJson = await caughtError(() => invalidJson.getSettings());

    expect(failure).toMatchObject({ status: 503 });
    expect(failure.message).toBe("Yazio request failed (HTTP 503): server_error.");
    expect(nonJson).toMatchObject({ status: 200 });
    expect(nonJson.message).toBe("Yazio returned a non-JSON response (HTTP 200).");
  });

  it("rejects a token response that carries no access token", async () => {
    const { fetchImpl } = routedFetch({ token: () => json({ token_type: "bearer" }) });

    const error = await caughtError(() => createClient(fetchImpl).getSettings());

    expect(error).toMatchObject({ status: 502 });
    expect(error.message).toBe("Yazio returned a token response without an access token.");
  });

  it("keeps the timeout active while reading the response body", async () => {
    vi.useFakeTimers();
    const fetchImpl = asFetch(async (input) =>
      String(input).endsWith("/oauth/token")
        ? json(token())
        : ({
            status: 200,
            ok: true,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => await new Promise<unknown>(() => undefined),
          } as Response),
    );
    const client = createClient(fetchImpl, 25);

    const pending = caughtError(() => client.getSettings());
    await vi.advanceTimersByTimeAsync(25);
    const error = await pending;

    expect(error).toBeInstanceOf(YazioApiError);
    expect(error).toMatchObject({ status: 408 });
    expect(error.message).toBe("Yazio request timed out after 25ms.");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("turns a stalled request into a bounded, secret-free timeout error", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null | undefined;
    const fetchImpl = asFetch(async (_input, init) => {
      requestSignal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener(
          "abort",
          () => reject(new Error(`transport aborted with ${PASSWORD}`)),
          { once: true },
        );
      });
    });
    const client = createClient(fetchImpl, 25);

    const pending = caughtError(() => client.getSettings());
    await vi.advanceTimersByTimeAsync(25);
    const error = await pending;

    expect(error).toBeInstanceOf(YazioApiError);
    expect(error).toMatchObject({ status: 408 });
    expect(error.message).toBe("Yazio request timed out after 25ms.");
    expect(error.message).not.toContain(PASSWORD);
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
