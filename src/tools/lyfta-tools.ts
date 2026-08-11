import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SecretRedactor } from "../security/redaction.js";
import { runTool, unavailableService } from "./result.js";

export interface LyftaToolClient {
  listWorkouts(options?: { page?: number; limit?: number }): Promise<unknown>;
  listWorkoutSummaries(options?: { page?: number; limit?: number }): Promise<unknown>;
  listExercises(options?: { page?: number; limit?: number }): Promise<unknown>;
  searchExerciseLibrary(options?: {
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<unknown>;
  getExerciseProgress(options: { exercise_id: string; duration: number }): Promise<unknown>;
  listClients(): Promise<unknown>;
}

export interface LyftaToolsDependencies {
  lyfta?: LyftaToolClient;
  redactor: SecretRedactor;
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const page = z.number().int().min(1).optional().describe("Page number, starting at 1");

function optionalPagination(args: { page?: number; limit?: number }): {
  page?: number;
  limit?: number;
} {
  return {
    ...(args.page !== undefined ? { page: args.page } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  };
}

export function registerLyftaTools(server: McpServer, dependencies: LyftaToolsDependencies): void {
  const { lyfta, redactor } = dependencies;
  const invoke = (operation: string, call: (client: LyftaToolClient) => Promise<unknown>) =>
    runTool(redactor, operation, async () => {
      if (!lyfta) throw unavailableService("Lyfta");
      return call(lyfta);
    });

  server.registerTool(
    "lyfta_list_workouts",
    {
      title: "List Lyfta workouts",
      description:
        "List detailed completed Lyfta workouts, including exercises, sets, repetitions and loads. Results are paginated.",
      inputSchema: {
        page,
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      invoke("Lyfta list workouts", (client) => client.listWorkouts(optionalPagination(args))),
  );

  server.registerTool(
    "lyfta_list_workout_summaries",
    {
      title: "List Lyfta workout summaries",
      description:
        "List lightweight Lyfta workout summaries with date, duration and reported training volume. Results are paginated.",
      inputSchema: {
        page,
        limit: z.number().int().min(1).max(1_000).optional(),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      invoke("Lyfta list workout summaries", (client) =>
        client.listWorkoutSummaries(optionalPagination(args)),
      ),
  );

  server.registerTool(
    "lyfta_list_exercises",
    {
      title: "List performed Lyfta exercises",
      description:
        "List exercises performed by the Lyfta account, including upstream muscle metadata when available.",
      inputSchema: {
        page,
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      invoke("Lyfta list exercises", (client) => client.listExercises(optionalPagination(args))),
  );

  server.registerTool(
    "lyfta_search_exercise_library",
    {
      title: "Search the Lyfta exercise library",
      description: "Search Lyfta's read-only exercise library.",
      inputSchema: {
        search: z.string().trim().min(1).max(200).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ search, limit, offset }) =>
      invoke("Lyfta search exercise library", (client) =>
        client.searchExerciseLibrary({
          ...(search !== undefined ? { search } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(offset !== undefined ? { offset } : {}),
        }),
      ),
  );

  server.registerTool(
    "lyfta_get_exercise_progress",
    {
      title: "Get Lyfta exercise progress",
      description:
        "Get the upstream Lyfta progress series for one exercise over a look-back window in days.",
      inputSchema: {
        exercise_id: z.string().trim().min(1).max(100).describe("Lyfta exercise ID"),
        duration: z.number().int().min(1).max(3_650).describe("Look-back window in days"),
      },
      annotations: READ_ONLY,
    },
    async ({ exercise_id, duration }) =>
      invoke("Lyfta get exercise progress", (client) =>
        client.getExerciseProgress({ exercise_id, duration }),
      ),
  );

  server.registerTool(
    "lyfta_list_clients",
    {
      title: "List Lyfta coaching clients",
      description:
        "List active coaching clients. This read-only endpoint is available only to Lyfta coach accounts.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => invoke("Lyfta list clients", (client) => client.listClients()),
  );
}
