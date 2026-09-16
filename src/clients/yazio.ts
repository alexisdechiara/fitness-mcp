/**
 * First-party read-only Yazio client.
 *
 * It replaces the `yazio` npm package (1.1.3, unpublished since April 2024),
 * whose token request sends a JSON string body without a `Content-Type` header.
 * The Yazio OAuth endpoint only reads `application/x-www-form-urlencoded`
 * parameters, so it receives an empty request and rejects every login. Paths,
 * OAuth client credentials and the form encoding follow the public API
 * description referenced in docs/UPSTREAMS.md.
 */

export const YAZIO_BASE_URL = "https://yzapi.yazio.com/v15";
/** Public client credentials of the Yazio application, shared by every known client. */
export const YAZIO_CLIENT_ID = "1_4hiybetvfksgw40o0sog4s884kwc840wwso8go4k8c04goo4c";
export const YAZIO_CLIENT_SECRET = "6rok2m65xuskgkgogw40wkkk8sw0osg84s8cggsc4woos4s8o";

/** Tokens are renewed slightly early so an in-flight request cannot expire mid-call. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

export class YazioApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "YazioApiError";
  }
}

export interface YazioClientOptions {
  baseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type YazioDaytime = "breakfast" | "lunch" | "dinner" | "snack";

export interface YazioProductSearch {
  query: string;
  sex?: "male" | "female";
  countries?: string[];
  locales?: string[];
}

type Query = Record<string, string | undefined>;

interface CachedToken {
  accessToken: string;
  refreshToken: string | undefined;
  expiresAt: number;
}

interface JsonResponse {
  status: number;
  payload: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Turn an OAuth or API error body into one short sentence fragment the caller can punctuate. */
function upstreamDetail(payload: unknown): string {
  const source = asRecord(payload);
  if (!source) return "";
  const parts = [source.error, source.error_description, source.message]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.replace(/[\s.]+$/u, "").trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? `: ${[...new Set(parts)].join(": ").slice(0, 300)}` : "";
}

export class YazioClient {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private token: CachedToken | undefined;
  private pendingToken: Promise<CachedToken> | undefined;

  constructor(
    private readonly username: string,
    private readonly password: string,
    options: YazioClientOptions = {},
  ) {
    this.baseUrl = (options.baseUrl ?? YAZIO_BASE_URL).replace(/\/+$/u, "");
    this.clientId = options.clientId ?? YAZIO_CLIENT_ID;
    this.clientSecret = options.clientSecret ?? YAZIO_CLIENT_SECRET;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private url(path: string, query: Query = {}): URL {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    return url;
  }

  private async send(url: URL, init: RequestInit): Promise<JsonResponse> {
    const controller = new AbortController();
    const timeoutError = (): YazioApiError =>
      new YazioApiError(408, `Yazio request timed out after ${this.timeoutMs}ms.`);
    let rejectOnTimeout: (error: YazioApiError) => void = () => undefined;
    // The timeout also covers the body read, which an abort alone may not interrupt.
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      rejectOnTimeout = reject;
    });
    const timer = setTimeout(() => {
      const error = timeoutError();
      rejectOnTimeout(error);
      controller.abort(error);
    }, this.timeoutMs);
    timer.unref?.();

    try {
      let response: Response;
      try {
        response = await Promise.race([
          this.fetchImpl(url, { ...init, signal: controller.signal }),
          timeoutPromise,
        ]);
      } catch (error) {
        if (controller.signal.aborted) throw timeoutError();
        throw error;
      }

      if (response.status === 204) return { status: 204, payload: null };

      let payload: unknown;
      try {
        payload = await Promise.race([response.json(), timeoutPromise]);
      } catch (error) {
        if (error instanceof YazioApiError) throw error;
        if (controller.signal.aborted) throw timeoutError();
        if (response.ok) {
          throw new YazioApiError(
            response.status,
            `Yazio returned a non-JSON response (HTTP ${response.status}).`,
          );
        }
        payload = undefined;
      }
      return { status: response.status, payload };
    } finally {
      clearTimeout(timer);
    }
  }

  private async exchange(grant: Record<string, string>): Promise<CachedToken> {
    const parameters = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      ...grant,
    });
    const { status, payload } = await this.send(this.url("/oauth/token"), {
      method: "POST",
      headers: {
        // Yazio parses the token request as a form; a JSON body reaches it empty.
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: parameters.toString(),
    });

    if (status < 200 || status >= 300) {
      throw new YazioApiError(
        status,
        `Yazio authentication failed (HTTP ${status})${upstreamDetail(payload)}.`,
      );
    }

    const token = asRecord(payload);
    const accessToken = typeof token?.access_token === "string" ? token.access_token : undefined;
    if (!accessToken) {
      throw new YazioApiError(502, "Yazio returned a token response without an access token.");
    }
    const expiresIn = typeof token?.expires_in === "number" ? token.expires_in : 0;
    return {
      accessToken,
      refreshToken: typeof token?.refresh_token === "string" ? token.refresh_token : undefined,
      expiresAt: Date.now() + Math.max(expiresIn, 0) * 1_000,
    };
  }

  /** Renew from the refresh token when possible, falling back to a full login. */
  private async login(refreshToken: string | undefined): Promise<CachedToken> {
    if (refreshToken !== undefined) {
      try {
        return await this.exchange({ grant_type: "refresh_token", refresh_token: refreshToken });
      } catch (error) {
        const rejected =
          error instanceof YazioApiError && (error.status === 400 || error.status === 401);
        if (!rejected) throw error;
      }
    }
    if (!this.username || !this.password) {
      throw new YazioApiError(401, "Yazio credentials are incomplete.");
    }
    return this.exchange({
      grant_type: "password",
      username: this.username,
      password: this.password,
    });
  }

  /** Reads are issued one per date, so logins are shared instead of stampeding. */
  private async accessToken(): Promise<string> {
    const cached = this.token;
    if (cached && cached.expiresAt - TOKEN_EXPIRY_SKEW_MS > Date.now()) return cached.accessToken;

    this.pendingToken ??= this.login(cached?.refreshToken)
      .then((token) => {
        this.token = token;
        return token;
      })
      .finally(() => {
        this.pendingToken = undefined;
      });
    return (await this.pendingToken).accessToken;
  }

  private forget(usedToken: string): void {
    if (this.token?.accessToken === usedToken) this.token = undefined;
  }

  private async request<T>(path: string, query: Query = {}): Promise<T> {
    const url = this.url(path, query);
    const attempt = async (): Promise<JsonResponse & { usedToken: string }> => {
      const usedToken = await this.accessToken();
      const response = await this.send(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${usedToken}`, Accept: "application/json" },
      });
      return { ...response, usedToken };
    };

    let result = await attempt();
    if (result.status === 401) {
      // The cached token was revoked upstream: log in again and replay once.
      this.forget(result.usedToken);
      result = await attempt();
    }

    if (result.status < 200 || result.status >= 300) {
      throw new YazioApiError(
        result.status,
        `Yazio request failed (HTTP ${result.status})${upstreamDetail(result.payload)}.`,
      );
    }
    return result.payload as T;
  }

  getConsumedItems(date: string): Promise<unknown> {
    return this.request("/user/consumed-items", { date });
  }

  getDailySummary(date: string): Promise<unknown> {
    return this.request("/user/widgets/daily-summary", { date });
  }

  getExercises(date: string): Promise<unknown> {
    return this.request("/user/exercises", { date });
  }

  getWaterIntake(date: string): Promise<unknown> {
    return this.request("/user/water-intake", { date });
  }

  getGoals(date?: string): Promise<unknown> {
    return this.request("/user/goals/unmodified", { date });
  }

  getSettings(): Promise<unknown> {
    return this.request("/user/settings");
  }

  getDietaryPreferences(): Promise<unknown> {
    return this.request("/user/dietary-preferences");
  }

  getSuggestedProducts(date: string, daytime: YazioDaytime): Promise<unknown> {
    return this.request("/user/products/suggested", { date, daytime });
  }

  searchProducts(options: YazioProductSearch): Promise<unknown> {
    return this.request("/products/search", {
      query: options.query,
      sex: options.sex ?? "male",
      countries: (options.countries ?? ["DE", "US"]).join(","),
      locales: (options.locales ?? ["en_US", "de_US"]).join(","),
    });
  }

  async getProduct(id: string): Promise<unknown> {
    const product = await this.request<unknown>(`/products/${encodeURIComponent(id)}`);
    const source = asRecord(product);
    // The product payload omits the identifier that was requested.
    return source ? { ...source, id } : null;
  }
}
