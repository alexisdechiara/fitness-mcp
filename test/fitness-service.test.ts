import { describe, expect, it, vi } from "vitest";
import {
  FitnessService,
  type LyftaFitnessClient,
  type YazioFitnessClient,
} from "../src/services/fitness.js";

function workout(
  id: string,
  date: string,
  weight: number,
  options: { exerciseId?: string; exerciseName?: string } = {},
) {
  return {
    id,
    title: "Push",
    workout_perform_date: `${date} 18:00:00`,
    exercises: [
      {
        exercise_id: options.exerciseId ?? "bench",
        excercise_name: options.exerciseName ?? "Bench Press",
        exercise_type: "Weighted",
        sets: [
          { id: `${id}-1`, weight, reps: 5, is_completed: true },
          { id: `${id}-2`, weight: weight - 10, reps: 8, is_completed: true },
          { id: `${id}-3`, weight: weight + 20, reps: 1, is_completed: false },
        ],
      },
    ],
  };
}

function dailySummary(date: string) {
  const day = Number(date.slice(-2));
  return {
    water_intake: 1_500 + day,
    goals: {
      "energy.energy": 2_500,
      "nutrient.protein": 160,
      "nutrient.carb": 250,
      "nutrient.fat": 80,
      water: 2_000,
    },
    units: { unit_energy: "kcal", unit_mass: "kg" },
    meals: {
      breakfast: {
        nutrients: {
          "energy.energy": 400,
          "nutrient.protein": 30,
          "nutrient.carb": 50,
          "nutrient.fat": 10,
        },
      },
      lunch: {
        nutrients: {
          "energy.energy": 600,
          "nutrient.protein": 50,
          "nutrient.carb": 70,
          "nutrient.fat": 20,
        },
      },
      dinner: {
        nutrients: {
          "energy.energy": 700,
          "nutrient.protein": 60,
          "nutrient.carb": 60,
          "nutrient.fat": 30,
        },
      },
      snack: {
        nutrients: {
          "energy.energy": 200,
          "nutrient.protein": 10,
          "nutrient.carb": 20,
          "nutrient.fat": 5,
        },
      },
    },
    user: { current_weight: 80 },
  };
}

function lyfta(
  workouts: unknown[],
  exercises: unknown[] = [],
): LyftaFitnessClient {
  const summaries = workouts.map((entry) => {
    const source = entry as { id: unknown; title: unknown; workout_perform_date: unknown };
    return {
      id: source.id,
      title: source.title,
      workout_perform_date: source.workout_perform_date,
      workout_duration: "01:00:00",
    };
  });
  return {
    listWorkouts: vi.fn(async () => ({ status: true, workouts })),
    listWorkoutSummaries: vi.fn(async () => ({ status: true, workouts: summaries })),
    listExercises: vi.fn(async () => ({ status: true, exercises })),
    getExerciseProgress: vi.fn(async () => ({ status: true, progress: [] })),
  };
}

function yazio(): YazioFitnessClient {
  return {
    getDailySummary: vi.fn(async (date: string) => dailySummary(date)),
    getWeight: vi.fn(async (date?: string) => ({
      id: `weight-${date ?? "latest"}`,
      date: `${date ?? "2026-08-01"} 08:00:00`,
      value: date === "2026-08-07" ? 79.5 : 80,
    })),
    getWaterIntake: vi.fn(async () => ({ water_intake: 2_200 })),
    getGoals: vi.fn(async () => ({ "energy.energy": 2_500 })),
  };
}

describe("FitnessService", () => {
  it("builds a structured daily training, nutrition, hydration and weight summary", async () => {
    const service = new FitnessService({
      lyfta: lyfta([workout("w1", "2026-08-01", 100), workout("w2", "2026-08-02", 105)]),
      yazio: yazio(),
    });

    const result = await service.dailySummary("2026-08-01");

    expect(result).toMatchObject({
      date: "2026-08-01",
      weight: 80,
      weightRecordedAt: "2026-08-01",
      nutrition: {
        caloriesConsumed: 1_900,
        calorieGoal: 2_500,
        proteinGrams: 150,
        carbohydrateGrams: 200,
        fatGrams: 65,
        waterMilliliters: 2_200,
      },
      units: { energy: "kcal", mass: "kg" },
      training: {
        workoutCount: 1,
        totalSets: 2,
        totalVolume: 1_220,
        durationSeconds: 3_600,
      },
      dataQuality: { status: "complete", truncated: false },
    });
    expect(Array.isArray(result)).toBe(false);
    expect(result.training.exercises).toEqual([
      expect.objectContaining({ exerciseId: "bench", completedSets: 2, volume: 1_220 }),
    ]);
  });

  it("reports malformed optional Yazio payloads as partial data", async () => {
    const yazioClient = yazio();
    vi.mocked(yazioClient.getWeight).mockResolvedValue({ unexpected: true });
    vi.mocked(yazioClient.getWaterIntake).mockResolvedValue({ unexpected: true });
    vi.mocked(yazioClient.getGoals).mockResolvedValue({ unexpected: true });
    const service = new FitnessService({
      lyfta: lyfta([]),
      yazio: yazioClient,
    });

    const result = await service.dailySummary("2026-08-01");

    expect(result.dataQuality.status).toBe("partial");
    expect(result.dataQuality.warnings).toEqual(
      expect.arrayContaining([
        "Yazio goals for 2026-08-01 had an unrecognized shape.",
        "Yazio water intake for 2026-08-01 had an unrecognized shape.",
        "Yazio weight for 2026-08-01 had an unrecognized shape.",
      ]),
    );
  });

  it("keeps a period useful when individual upstream dates fail and enforces concurrency", async () => {
    let active = 0;
    let maximumActive = 0;
    const observed = async <T>(value: T, fail = false): Promise<T> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (fail) throw new Error("upstream secret-shaped failure must not escape");
      return value;
    };
    const lyftaClient: LyftaFitnessClient = {
      listWorkouts: vi.fn(async () => observed({ workouts: [workout("w1", "2026-08-01", 100)] })),
      listWorkoutSummaries: vi.fn(async () =>
        observed({
          workouts: [
            {
              id: "w1",
              title: "Push",
              workout_perform_date: "2026-08-01 18:00:00",
              workout_duration: "01:00:00",
            },
          ],
        }),
      ),
      listExercises: vi.fn(async () => observed({ exercises: [] })),
      getExerciseProgress: vi.fn(async () => ({ progress: [] })),
    };
    const yazioClient: YazioFitnessClient = {
      getDailySummary: vi.fn(async (date: string) =>
        observed(dailySummary(date), date === "2026-08-02"),
      ),
      getWeight: vi.fn(async (date?: string) =>
        observed({ date, value: 80 }),
      ),
      getWaterIntake: vi.fn(async () => observed({ water_intake: 2_000 })),
      getGoals: vi.fn(async () => observed({ "energy.energy": 2_500 })),
    };
    const service = new FitnessService({
      lyfta: lyftaClient,
      yazio: yazioClient,
      concurrency: 2,
    });

    const result = await service.trainingNutritionSummary("2026-08-01", "2026-08-03");

    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(result.nutrition.daysWithData).toBe(2);
    expect(result.nutrition.daily.find((day) => day.date === "2026-08-02")).toMatchObject({
      available: false,
      caloriesConsumed: null,
    });
    expect(result.training.trainingDays).toEqual(["2026-08-01"]);
    expect(result.training.restDays).toEqual(["2026-08-02", "2026-08-03"]);
    expect(result.dataQuality.status).toBe("partial");
    expect(result.dataQuality.sources.yazio).toMatchObject({ status: "partial", failedRequests: 1 });
    expect(result.dataQuality.warnings.join(" ")).not.toContain("secret-shaped");
  });

  it("builds the fixed seven-day weekly period and objective averages", async () => {
    const yazioClient = yazio();
    const service = new FitnessService({
      lyfta: lyfta(
        [workout("w1", "2026-08-01", 100), workout("w2", "2026-08-07", 105)],
        [{ id: "bench", name: "Bench Press", Target_muscles_id: "[]", Synergist_muscles_id: "[]" }],
      ),
      yazio: yazioClient,
    });

    const result = await service.weeklySummary("2026-08-01");

    expect(result.period).toEqual({
      startDate: "2026-08-01",
      endDate: "2026-08-07",
      inclusiveDays: 7,
    });
    expect(result.training).toMatchObject({
      workoutCount: 2,
      trainingDayCount: 2,
      restDayCount: 5,
      totalSets: 4,
    });
    expect(result.nutrition).toMatchObject({
      daysRequested: 7,
      daysWithData: 7,
      averages: { caloriesConsumed: 1_900, proteinGrams: 150 },
    });
    expect(result.weight).toMatchObject({
      start: { value: 80 },
      end: { value: 79.5 },
      change: -0.5,
    });
    expect(yazioClient.getDailySummary).toHaveBeenCalledTimes(7);
  });

  it("attributes only completed sets through official target and synergist metadata", async () => {
    const service = new FitnessService({
      lyfta: lyfta([workout("w1", "2026-08-01", 100)], [
        {
          id: "bench",
          name: "Bench Press",
          Target_muscles_id: '["24"]',
          Synergist_muscles_id: '["44"]',
        },
      ]),
    });

    const result = await service.muscleVolume("2026-08-01", "2026-08-07");

    expect(result.muscles).toEqual([
      expect.objectContaining({
        muscleId: "24",
        muscle: "Pectoralis Major Clavicular Head",
        directSets: 2,
        indirectSets: 0,
        directVolume: 1_220,
        sessions: 1,
        frequencyPerWeek: 1,
      }),
      expect.objectContaining({
        muscleId: "44",
        muscle: "Triceps Brachii",
        directSets: 0,
        indirectSets: 2,
        indirectVolume: 1_220,
        sessions: 1,
      }),
    ]);
    expect(result.unmappedExerciseIds).toEqual([]);
    expect(result.methodology.muscleExposure).toContain("Target_muscles_id");
  });

  it("resolves an exercise name and derives exact-period progress from detailed workouts", async () => {
    const service = new FitnessService({
      lyfta: lyfta(
        [workout("w1", "2026-08-01", 100), workout("w2", "2026-08-08", 105)],
        [{ id: "bench", name: "Bench Press", Target_muscles_id: "[]", Synergist_muscles_id: "[]" }],
      ),
    });

    const result = await service.exerciseProgress({
      exerciseName: "bench press",
      startDate: "2026-08-01",
      endDate: "2026-08-08",
    });

    expect(result.exercise).toMatchObject({
      requestedName: "bench press",
      resolvedIds: ["bench"],
      resolvedName: "Bench Press",
    });
    expect(result.history).toHaveLength(2);
    expect(result.summary).toMatchObject({
      sessions: 2,
      completedSets: 4,
      maxWeight: 105,
      change: { maxWeight: 5, maxWeightPercent: 5 },
    });
    expect(result.summary?.bestSet).toMatchObject({ date: "2026-08-08", weight: 95, reps: 8 });
  });

  it("validates ranges but returns unavailable quality when no integration is configured", async () => {
    const service = new FitnessService({ maxRangeDays: 7 });

    await expect(service.dailySummary("not-a-date")).rejects.toThrow("YYYY-MM-DD");
    await expect(
      service.trainingNutritionSummary("2026-08-01", "2026-08-08"),
    ).rejects.toThrow("limited to 7");

    const result = await service.dailySummary("2026-08-01");
    expect(result.dataQuality).toMatchObject({
      status: "unavailable",
      sources: {
        lyfta: { status: "not_configured" },
        yazio: { status: "not_configured" },
      },
    });
    expect(result.training.workoutCount).toBe(0);
    expect(result.nutrition.caloriesConsumed).toBeNull();
  });

  it("reports the injected workout cap instead of reading unbounded history", async () => {
    const client = lyfta([
      workout("w1", "2026-08-01", 100),
      workout("w2", "2026-08-02", 100),
    ]);
    const service = new FitnessService({ lyfta: client, maxWorkouts: 2 });

    const result = await service.dailySummary("2026-08-01");

    expect(client.listWorkouts).toHaveBeenCalledTimes(1);
    expect(result.dataQuality).toMatchObject({ status: "partial", truncated: true });
    expect(result.dataQuality.warnings).toContain("Lyfta workouts were limited to 2 records.");
  });

  it("paginates Lyfta workouts until a short page", async () => {
    const firstPage = Array.from({ length: 100 }, (_unused, index) =>
      workout(`old-${index}`, "2026-07-01", 50),
    );
    const client: LyftaFitnessClient = {
      listWorkouts: vi.fn(async ({ page } = {}) => ({
        workouts: page === 1 ? firstPage : [workout("selected", "2026-08-01", 100)],
      })),
      listWorkoutSummaries: vi.fn(async () => ({ workouts: [] })),
      listExercises: vi.fn(async () => ({ exercises: [] })),
      getExerciseProgress: vi.fn(async () => ({ progress: [] })),
    };
    const service = new FitnessService({ lyfta: client, maxWorkouts: 200 });

    const result = await service.dailySummary("2026-08-01");

    expect(client.listWorkouts).toHaveBeenCalledTimes(2);
    expect(client.listWorkouts).toHaveBeenNthCalledWith(1, { page: 1, limit: 100 });
    expect(client.listWorkouts).toHaveBeenNthCalledWith(2, { page: 2, limit: 100 });
    expect(result.training.workouts.map((entry) => entry.id)).toEqual(["selected"]);
  });
});
