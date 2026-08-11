/**
 * Adapted from jkronlachner/lyfta-mcp (MIT), version 0.3.1.
 * See THIRD_PARTY_NOTICES.md and docs/UPSTREAMS.md.
 */

export class LyftaApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "LyftaApiError";
  }
}

export interface LyftaClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type Query = Record<string, string | number | undefined>;

export class LyftaClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly apiKey: string,
    options: LyftaClientOptions = {},
  ) {
    this.baseUrl = options.baseUrl ?? "https://my.lyfta.app";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private async request<T>(path: string, query: Query = {}): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timeoutError = (): LyftaApiError =>
      new LyftaApiError(408, `Lyfta request timed out after ${this.timeoutMs}ms.`);
    let rejectOnTimeout: (error: LyftaApiError) => void = () => undefined;
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
          this.fetchImpl(url, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              Accept: "application/json",
            },
            signal: controller.signal,
          }),
          timeoutPromise,
        ]);
      } catch (error) {
        if (controller.signal.aborted) {
          throw controller.signal.reason instanceof LyftaApiError
            ? controller.signal.reason
            : timeoutError();
        }
        throw error;
      }

      if (response.status === 429) {
        throw new LyftaApiError(
          429,
          "Lyfta rate limit exceeded (60/minute, 5000/day).",
          response.headers.get("retry-after") ?? undefined,
        );
      }

      let data: unknown;
      try {
        data = await Promise.race([response.json(), timeoutPromise]);
      } catch {
        if (controller.signal.aborted) {
          throw controller.signal.reason instanceof LyftaApiError
            ? controller.signal.reason
            : timeoutError();
        }
        throw new LyftaApiError(response.status, `Lyfta returned a non-JSON response (HTTP ${response.status}).`);
      }

      const envelope = data !== null && typeof data === "object" ? (data as Record<string, unknown>) : undefined;
      if (!response.ok || envelope?.status === false) {
        const upstreamMessage =
          typeof envelope?.message === "string"
            ? envelope.message.slice(0, 300).split(this.apiKey).join("[REDACTED]")
            : undefined;
        throw new LyftaApiError(
          response.status,
          upstreamMessage ?? `Lyfta request failed (HTTP ${response.status}).`,
        );
      }
      return data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  listWorkouts(options: { page?: number; limit?: number } = {}): Promise<unknown> {
    return this.request("/api/v1/workouts", options);
  }

  listWorkoutSummaries(options: { page?: number; limit?: number } = {}): Promise<unknown> {
    return this.request("/api/v1/workouts/summary", options);
  }

  listExercises(options: { page?: number; limit?: number } = {}): Promise<unknown> {
    return this.request("/api/v1/exercises", options);
  }

  searchExerciseLibrary(options: { search?: string; limit?: number; offset?: number } = {}): Promise<unknown> {
    return this.request("/api/v1/exercises/library", options);
  }

  getExerciseProgress(options: { exercise_id: string; duration: number }): Promise<unknown> {
    return this.request("/api/v1/exercises/progress", options);
  }

  listClients(): Promise<unknown> {
    return this.request("/api/v1/clients");
  }
}
