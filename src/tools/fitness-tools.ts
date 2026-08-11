import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isDateOnly } from "../domain/dates.js";
import type { SecretRedactor } from "../security/redaction.js";
import { runTool } from "./result.js";

export interface FitnessToolService {
  dailySummary(date: string): Promise<unknown>;
  weeklySummary(startDate: string): Promise<unknown>;
  trainingNutritionSummary(startDate: string, endDate: string): Promise<unknown>;
  muscleVolume(startDate: string, endDate: string): Promise<unknown>;
  exerciseProgress(options: {
    exerciseId?: string;
    exerciseName?: string;
    startDate: string;
    endDate: string;
  }): Promise<unknown>;
}

export interface FitnessToolsDependencies {
  fitness: FitnessToolService;
  redactor: SecretRedactor;
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const date = z
  .string()
  .refine(isDateOnly, "Date must use the YYYY-MM-DD format.")
  .describe("Civil date in YYYY-MM-DD format");

const exerciseProgressInput = z
  .object({
    exerciseId: z.string().trim().min(1).max(100).optional(),
    exerciseName: z.string().trim().min(1).max(300).optional(),
    startDate: date,
    endDate: date,
  })
  .superRefine((value, context) => {
    if (Boolean(value.exerciseId) === Boolean(value.exerciseName)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exerciseId"],
        message: "Provide exactly one of exerciseId or exerciseName.",
      });
    }
  });

export function registerFitnessTools(server: McpServer, dependencies: FitnessToolsDependencies): void {
  const { fitness, redactor } = dependencies;

  server.registerTool(
    "fitness_daily_summary",
    {
      title: "Fitness daily summary",
      description:
        "Aggregate objective Lyfta training, Yazio nutrition, water and weight data for one date. It does not provide medical advice.",
      inputSchema: { date },
      annotations: READ_ONLY,
    },
    async ({ date: requestedDate }) =>
      runTool(redactor, "Fitness daily summary", () => fitness.dailySummary(requestedDate)),
  );

  server.registerTool(
    "fitness_weekly_summary",
    {
      title: "Fitness weekly summary",
      description:
        "Aggregate seven inclusive days starting at startDate: training frequency and volume, nutrition averages, and weight change.",
      inputSchema: { startDate: date },
      annotations: READ_ONLY,
    },
    async ({ startDate }) =>
      runTool(redactor, "Fitness weekly summary", () => fitness.weeklySummary(startDate)),
  );

  server.registerTool(
    "fitness_training_nutrition_summary",
    {
      title: "Fitness training and nutrition summary",
      description:
        "Aggregate objective training, nutrition, weight and rest-day indicators over an inclusive period for downstream analysis. It does not diagnose or prescribe.",
      inputSchema: { startDate: date, endDate: date },
      annotations: READ_ONLY,
    },
    async ({ startDate, endDate }) =>
      runTool(redactor, "Fitness training and nutrition summary", () =>
        fitness.trainingNutritionSummary(startDate, endDate),
      ),
  );

  server.registerTool(
    "fitness_muscle_volume",
    {
      title: "Fitness muscle volume",
      description:
        "Aggregate direct and synergist set exposure using only Lyfta's supplied target-muscle metadata over an inclusive period.",
      inputSchema: { startDate: date, endDate: date },
      annotations: READ_ONLY,
    },
    async ({ startDate, endDate }) =>
      runTool(redactor, "Fitness muscle volume", () =>
        fitness.muscleVolume(startDate, endDate),
      ),
  );

  server.registerTool(
    "fitness_exercise_progress",
    {
      title: "Fitness exercise progress",
      description:
        "Build set, repetition, load, volume and best-set history for exactly one Lyfta exercise over an inclusive period.",
      inputSchema: exerciseProgressInput,
      annotations: READ_ONLY,
    },
    async ({ exerciseId, exerciseName, startDate, endDate }) =>
      runTool(redactor, "Fitness exercise progress", () =>
        fitness.exerciseProgress({
          ...(exerciseId !== undefined ? { exerciseId } : {}),
          ...(exerciseName !== undefined ? { exerciseName } : {}),
          startDate,
          endDate,
        }),
      ),
  );
}
