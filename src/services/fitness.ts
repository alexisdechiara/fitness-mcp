import type { LyftaClient } from "../clients/lyfta.js";
import type { YazioClient } from "../clients/yazio.js";
import {
  calculatedWorkoutVolume,
  completedSetCount,
  finiteNumber,
  normalizeExerciseMetadata,
  normalizeWorkout,
  record,
  stringValue,
  type ExerciseMetadata,
  type NormalizedSet,
  type NormalizedWorkout,
  type NormalizedWorkoutExercise,
  type UnknownRecord,
} from "../domain/normalize.js";
import { addDays, enumerateDates, isoWeekKey } from "../domain/dates.js";
import { muscleLabel } from "../domain/muscles.js";
import { createConcurrencyLimiter, type ConcurrencyLimiter } from "./concurrency.js";

export type LyftaFitnessClient = Pick<
  LyftaClient,
  "listWorkouts" | "listWorkoutSummaries" | "listExercises" | "getExerciseProgress"
>;

export type YazioFitnessClient = Pick<
  YazioClient,
  "getDailySummary" | "getWaterIntake" | "getGoals"
>;

export interface FitnessServiceOptions {
  lyfta?: LyftaFitnessClient;
  yazio?: YazioFitnessClient;
  maxRangeDays?: number;
  maxWorkouts?: number;
  concurrency?: number;
}

export type DataQualityStatus = "complete" | "partial" | "unavailable";
export type SourceQualityStatus =
  | "available"
  | "partial"
  | "unavailable"
  | "not_configured"
  | "not_requested";

export interface SourceQuality {
  configured: boolean;
  status: SourceQualityStatus;
  successfulRequests: number;
  failedRequests: number;
}

export interface DataQuality {
  status: DataQualityStatus;
  sources: {
    lyfta: SourceQuality;
    yazio: SourceQuality;
  };
  warnings: string[];
  truncated: boolean;
}

export interface FitnessMethodology {
  dates: string;
  nutrition: string;
  trainingVolume: string;
  muscleExposure: string;
  bestSet: string;
  partialData: string;
}

export interface DailyNutrition {
  caloriesConsumed: number | null;
  calorieGoal: number | null;
  proteinGrams: number | null;
  carbohydrateGrams: number | null;
  fatGrams: number | null;
  waterMilliliters: number | null;
}

export interface NutritionUnits {
  energy: string | null;
  mass: string | null;
}

export interface SetResult {
  weight: number | null;
  reps: number | null;
  volume: number | null;
  rir: number | null;
  isCompleted: boolean;
}

export interface ExerciseResult {
  exerciseId: string;
  name: string;
  completedSets: number;
  volume: number | null;
  sets: SetResult[];
}

export interface WorkoutResult {
  id: string;
  title: string;
  date: string | null;
  durationSeconds: number | null;
  totalSets: number;
  volume: number | null;
  exercises: ExerciseResult[];
}

export interface DailyTraining {
  workoutCount: number;
  totalSets: number;
  totalVolume: number | null;
  durationSeconds: number | null;
  workouts: WorkoutResult[];
  exercises: Array<{
    workoutId: string;
    exerciseId: string;
    name: string;
    completedSets: number;
    volume: number | null;
  }>;
}

export interface FitnessDailySummary {
  date: string;
  nutrition: DailyNutrition;
  units: NutritionUnits;
  training: DailyTraining;
  dataQuality: DataQuality;
  methodology: FitnessMethodology;
}

export interface BestSetResult {
  date: string;
  workoutId: string;
  weight: number | null;
  reps: number | null;
  volume: number | null;
}

export interface PerformancePoint {
  date: string;
  workoutId: string;
  completedSets: number;
  volume: number | null;
  maxWeight: number | null;
  maxReps: number | null;
  bestSet: BestSetResult | null;
}

export interface ExercisePerformance {
  exerciseId: string;
  name: string;
  sessions: number;
  completedSets: number;
  totalVolume: number | null;
  maxWeight: number | null;
  maxReps: number | null;
  bestSet: BestSetResult | null;
  firstPerformance: PerformancePoint;
  lastPerformance: PerformancePoint;
  change: {
    maxWeight: number | null;
    maxWeightPercent: number | null;
    bestSetVolume: number | null;
    bestSetVolumePercent: number | null;
  };
}

export interface MuscleExposure {
  muscleId: string;
  muscle: string;
  directSets: number;
  indirectSets: number;
  exposureSets: number;
  directVolume: number | null;
  indirectVolume: number | null;
  sessions: number;
  activeWeeks: number;
  frequencyPerWeek: number;
  exercises: Array<{
    exerciseId: string;
    name: string;
    roles: Array<"target" | "synergist">;
  }>;
}

export interface PeriodTraining {
  workoutCount: number;
  trainingDayCount: number;
  trainingDays: string[];
  restDayCount: number;
  restDays: string[];
  totalSets: number;
  totalVolume: number | null;
  workoutsWithCalculableVolume: number;
  durationSeconds: number | null;
  workouts: WorkoutResult[];
  muscleVolume: MuscleExposure[];
  mainExercises: ExercisePerformance[];
  performanceEvolution: ExercisePerformance[];
}

export interface NutritionDay extends DailyNutrition {
  date: string;
  available: boolean;
}

export interface NutritionAverages extends DailyNutrition {}

export interface PeriodNutrition {
  daysWithData: number;
  daysRequested: number;
  averages: NutritionAverages;
  daily: NutritionDay[];
  units: NutritionUnits;
}

export interface TrainingNutritionComparison {
  trainingDaysWithNutrition: number;
  restDaysWithNutrition: number;
  trainingDayAverages: NutritionAverages;
  restDayAverages: NutritionAverages;
}

export interface FitnessTrainingNutritionSummary {
  period: {
    startDate: string;
    endDate: string;
    inclusiveDays: number;
  };
  training: PeriodTraining;
  nutrition: PeriodNutrition;
  trainingNutritionComparison: TrainingNutritionComparison;
  dataQuality: DataQuality;
  methodology: FitnessMethodology;
}

export interface FitnessWeeklySummary extends FitnessTrainingNutritionSummary {}

export interface FitnessMuscleVolume {
  period: {
    startDate: string;
    endDate: string;
    inclusiveDays: number;
  };
  workoutCount: number;
  trainingDays: string[];
  muscles: MuscleExposure[];
  unmappedExerciseIds: string[];
  dataQuality: DataQuality;
  methodology: FitnessMethodology;
}

export interface ExerciseProgressInput {
  exerciseId?: string;
  exerciseName?: string;
  startDate: string;
  endDate: string;
}

export interface FitnessExerciseProgress {
  period: {
    startDate: string;
    endDate: string;
    inclusiveDays: number;
  };
  exercise: {
    requestedId: string | null;
    requestedName: string | null;
    resolvedIds: string[];
    resolvedName: string | null;
  };
  history: Array<PerformancePoint & { sets: SetResult[] }>;
  summary: ExercisePerformance | null;
  dataQuality: DataQuality;
  methodology: FitnessMethodology;
}

const METHODOLOGY: FitnessMethodology = Object.freeze({
  dates: "All periods are inclusive YYYY-MM-DD calendar dates; no host-timezone conversion is applied.",
  nutrition:
    "Calories and macronutrients are sums of the Yazio breakfast, lunch, dinner and snack nutrient values. Averages use only days where the metric is available.",
  trainingVolume:
    "Training volume is weight multiplied by repetitions for completed Lyfta sets. The workout-reported volume is used only when no set volume can be calculated.",
  muscleExposure:
    "Direct and indirect exposure use only Lyfta Target_muscles_id and Synergist_muscles_id metadata. Exposure assigned to multiple muscles is non-additive; frequency divides exposed sessions by at least one week (or the longer exact period in weeks).",
  bestSet:
    "Best set is the completed set with the highest calculable weight-times-repetitions volume, then highest weight and repetitions as tie-breakers.",
  partialData:
    "Unavailable upstream calls remain null or empty and are reported in dataQuality; no medical or dietary diagnosis is produced.",
});

type SourceName = "lyfta" | "yazio";

interface MutableSourceQuality {
  configured: boolean;
  successfulRequests: number;
  failedRequests: number;
}

class QualityTracker {
  private readonly state: Record<SourceName, MutableSourceQuality>;
  private readonly warningList: string[] = [];
  private hasIncompleteData = false;
  private isTruncated = false;

  constructor(lyftaConfigured: boolean, yazioConfigured: boolean) {
    this.state = {
      lyfta: { configured: lyftaConfigured, successfulRequests: 0, failedRequests: 0 },
      yazio: { configured: yazioConfigured, successfulRequests: 0, failedRequests: 0 },
    };
  }

  success(source: SourceName): void {
    this.state[source].successfulRequests += 1;
  }

  failure(source: SourceName, operation: string): void {
    this.state[source].failedRequests += 1;
    this.hasIncompleteData = true;
    const label = source === "lyfta" ? "Lyfta" : "Yazio";
    this.warningList.push(`${label} ${operation} unavailable.`);
  }

  warning(message: string): void {
    this.hasIncompleteData = true;
    this.warningList.push(message);
  }

  truncated(message: string): void {
    this.isTruncated = true;
    this.warning(message);
  }

  snapshot(requiredSources: SourceName[]): DataQuality {
    const required = new Set(requiredSources);
    const sourceQuality = (source: SourceName): SourceQuality => {
      const value = this.state[source];
      let status: SourceQualityStatus;
      if (!value.configured) status = "not_configured";
      else if (value.successfulRequests > 0 && value.failedRequests > 0) status = "partial";
      else if (value.successfulRequests > 0) status = "available";
      else if (value.failedRequests > 0 || required.has(source)) status = "unavailable";
      else status = "not_requested";
      return { ...value, status };
    };

    const lyfta = sourceQuality("lyfta");
    const yazio = sourceQuality("yazio");
    const requested = requiredSources.map((source) => (source === "lyfta" ? lyfta : yazio));
    const availableCount = requested.filter(
      (source) => source.status === "available" || source.status === "partial",
    ).length;
    const allComplete =
      requested.every((source) => source.status === "available") && !this.hasIncompleteData;
    const status: DataQualityStatus = allComplete
      ? "complete"
      : availableCount > 0
        ? "partial"
        : "unavailable";

    return {
      status,
      sources: { lyfta, yazio },
      warnings: [...new Set(this.warningList)],
      truncated: this.isTruncated,
    };
  }
}

interface WorkoutBatch {
  workouts: NormalizedWorkout[];
  truncated: boolean;
}

interface NormalizedNutrition {
  nutrition: DailyNutrition;
  units: NutritionUnits;
}

interface PeriodContext {
  dates: string[];
  workouts: NormalizedWorkout[];
  metadata: ExerciseMetadata[];
  nutritionDays: NutritionDay[];
  nutritionUnits: NutritionUnits;
  tracker: QualityTracker;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function nullableNumber(value: number | undefined): number | null {
  return value ?? null;
}

function average(values: Array<number | null>): number | null {
  const available = values.filter((value): value is number => value !== null);
  return available.length > 0
    ? round(available.reduce((sum, value) => sum + value, 0) / available.length)
    : null;
}

function sumAvailable(values: Array<number | undefined>, zeroWhenEmpty = false): number | null {
  const available = values.filter((value): value is number => value !== undefined);
  if (available.length === 0) return zeroWhenEmpty ? 0 : null;
  return round(available.reduce((sum, value) => sum + value, 0), 3);
}

function percentageChange(first: number | null, last: number | null): number | null {
  if (first === null || last === null || first === 0) return null;
  return round(((last - first) / Math.abs(first)) * 100);
}

function nestedRecord(value: unknown): UnknownRecord | undefined {
  const outer = record(value);
  if (!outer) return undefined;
  for (const key of ["data", "result", "payload"] as const) {
    const nested = record(outer[key]);
    if (nested) return nested;
  }
  return outer;
}

function extractCollection(value: unknown, keys: string[]): { items: unknown[]; recognized: boolean } {
  if (Array.isArray(value)) return { items: value, recognized: true };
  const source = record(value);
  if (!source) return { items: [], recognized: false };

  for (const key of keys) {
    if (Array.isArray(source[key])) return { items: source[key], recognized: true };
  }
  for (const wrapper of ["data", "result", "payload"] as const) {
    if (source[wrapper] !== undefined) {
      const nested = extractCollection(source[wrapper], keys);
      if (nested.recognized) return nested;
    }
  }
  return { items: [], recognized: false };
}

function nutrientFromMeal(meal: unknown, key: string): number | undefined {
  return finiteNumber(record(record(meal)?.nutrients)?.[key]);
}

function sumMealNutrient(meals: UnknownRecord | undefined, key: string): number | null {
  if (!meals) return null;
  const values = ["breakfast", "lunch", "dinner", "snack"]
    .map((meal) => nutrientFromMeal(meals[meal], key))
    .filter((value): value is number => value !== undefined);
  return values.length > 0 ? round(values.reduce((sum, value) => sum + value, 0), 3) : null;
}

function normalizeNutrition(value: unknown): NormalizedNutrition | null {
  const source = nestedRecord(value);
  if (!source) return null;
  const meals = record(source.meals);
  const goals = record(source.goals);
  const units = record(source.units);
  const nutrition: DailyNutrition = {
    caloriesConsumed: sumMealNutrient(meals, "energy.energy"),
    calorieGoal: nullableNumber(finiteNumber(goals?.["energy.energy"])),
    proteinGrams: sumMealNutrient(meals, "nutrient.protein"),
    carbohydrateGrams: sumMealNutrient(meals, "nutrient.carb"),
    fatGrams: sumMealNutrient(meals, "nutrient.fat"),
    waterMilliliters: nullableNumber(finiteNumber(source.water_intake)),
  };
  const hasRecognizedField =
    meals !== undefined || goals !== undefined || units !== undefined || source.water_intake !== undefined;
  if (!hasRecognizedField) return null;
  return {
    nutrition,
    units: {
      energy: stringValue(units?.unit_energy) ?? null,
      mass: stringValue(units?.unit_mass) ?? null,
    },
  };
}

function normalizeGoals(value: unknown): Pick<DailyNutrition, "calorieGoal"> | null {
  const source = nestedRecord(value);
  if (!source) return null;
  const calorieGoal = finiteNumber(source["energy.energy"]);
  return calorieGoal === undefined ? null : { calorieGoal };
}

function normalizeWater(value: unknown): number | null {
  return nullableNumber(finiteNumber(nestedRecord(value)?.water_intake));
}

function publicSet(set: NormalizedSet): SetResult {
  return {
    weight: nullableNumber(set.weight),
    reps: nullableNumber(set.reps),
    volume: nullableNumber(set.volume),
    rir: nullableNumber(set.rir),
    isCompleted: set.isCompleted,
  };
}

function exerciseVolume(exercise: NormalizedWorkoutExercise): number | null {
  return sumAvailable(
    exercise.sets.filter((set) => set.isCompleted).map((set) => set.volume),
    exercise.sets.filter((set) => set.isCompleted).length === 0,
  );
}

function publicExercise(exercise: NormalizedWorkoutExercise): ExerciseResult {
  const completedSets = exercise.sets.filter((set) => set.isCompleted);
  return {
    exerciseId: exercise.exerciseId,
    name: exercise.name,
    completedSets: completedSets.length,
    volume: exerciseVolume(exercise),
    sets: exercise.sets.map(publicSet),
  };
}

function publicWorkout(workout: NormalizedWorkout): WorkoutResult {
  return {
    id: workout.id,
    title: workout.title,
    date: workout.date ?? null,
    durationSeconds: nullableNumber(workout.durationSeconds),
    totalSets: completedSetCount(workout),
    volume: nullableNumber(calculatedWorkoutVolume(workout)),
    exercises: workout.exercises.map(publicExercise),
  };
}

function aggregateDailyTraining(workouts: NormalizedWorkout[]): DailyTraining {
  const publicWorkouts = workouts.map(publicWorkout);
  const workoutVolumes = workouts.map(calculatedWorkoutVolume);
  return {
    workoutCount: workouts.length,
    totalSets: workouts.reduce((sum, workout) => sum + completedSetCount(workout), 0),
    totalVolume: sumAvailable(workoutVolumes, workouts.length === 0),
    durationSeconds: sumAvailable(
      workouts.map((workout) => workout.durationSeconds),
      workouts.length === 0,
    ),
    workouts: publicWorkouts,
    exercises: workouts.flatMap((workout) =>
      workout.exercises.map((exercise) => ({
        workoutId: workout.id,
        exerciseId: exercise.exerciseId,
        name: exercise.name,
        completedSets: exercise.sets.filter((set) => set.isCompleted).length,
        volume: exerciseVolume(exercise),
      })),
    ),
  };
}

function compareBestSet(left: BestSetResult, right: BestSetResult): number {
  return (
    (left.volume ?? Number.NEGATIVE_INFINITY) - (right.volume ?? Number.NEGATIVE_INFINITY) ||
    (left.weight ?? Number.NEGATIVE_INFINITY) - (right.weight ?? Number.NEGATIVE_INFINITY) ||
    (left.reps ?? Number.NEGATIVE_INFINITY) - (right.reps ?? Number.NEGATIVE_INFINITY)
  );
}

function bestSet(
  sets: NormalizedSet[],
  date: string,
  workoutId: string,
): BestSetResult | null {
  const candidates = sets
    .filter((set) => set.isCompleted)
    .map((set): BestSetResult => ({
      date,
      workoutId,
      weight: nullableNumber(set.weight),
      reps: nullableNumber(set.reps),
      volume: nullableNumber(set.volume),
    }));
  if (candidates.length === 0) return null;
  return candidates.reduce((selected, candidate) =>
    compareBestSet(candidate, selected) > 0 ? candidate : selected,
  );
}

interface MutableExerciseHistory {
  exerciseId: string;
  name: string;
  points: Array<PerformancePoint & { sets: SetResult[] }>;
}

function exerciseHistories(workouts: NormalizedWorkout[]): MutableExerciseHistory[] {
  const histories = new Map<string, MutableExerciseHistory>();
  const ordered = [...workouts].sort(
    (left, right) => (left.date ?? "").localeCompare(right.date ?? "") || left.id.localeCompare(right.id),
  );

  for (const workout of ordered) {
    if (!workout.date) continue;
    const perWorkout = new Map<string, NormalizedWorkoutExercise[]>();
    for (const exercise of workout.exercises) {
      const existing = perWorkout.get(exercise.exerciseId) ?? [];
      existing.push(exercise);
      perWorkout.set(exercise.exerciseId, existing);
    }
    for (const [exerciseId, occurrences] of perWorkout) {
      const sets = occurrences.flatMap((exercise) => exercise.sets);
      const completed = sets.filter((set) => set.isCompleted);
      const volume = sumAvailable(completed.map((set) => set.volume), completed.length === 0);
      const maxWeight = completed
        .map((set) => set.weight)
        .filter((value): value is number => value !== undefined)
        .reduce<number | null>((maximum, value) => (maximum === null ? value : Math.max(maximum, value)), null);
      const maxReps = completed
        .map((set) => set.reps)
        .filter((value): value is number => value !== undefined)
        .reduce<number | null>((maximum, value) => (maximum === null ? value : Math.max(maximum, value)), null);
      const point: PerformancePoint & { sets: SetResult[] } = {
        date: workout.date,
        workoutId: workout.id,
        completedSets: completed.length,
        volume,
        maxWeight,
        maxReps,
        bestSet: bestSet(sets, workout.date, workout.id),
        sets: sets.map(publicSet),
      };
      const history = histories.get(exerciseId) ?? {
        exerciseId,
        name: occurrences[0]?.name ?? "Unknown exercise",
        points: [],
      };
      history.points.push(point);
      histories.set(exerciseId, history);
    }
  }
  return [...histories.values()];
}

function performanceFromHistory(history: MutableExerciseHistory): ExercisePerformance {
  const first = history.points[0];
  const last = history.points.at(-1);
  if (!first || !last) {
    throw new Error("An exercise history must contain at least one point.");
  }
  const allBestSets = history.points
    .map((point) => point.bestSet)
    .filter((set): set is BestSetResult => set !== null);
  const selectedBest = allBestSets.length > 0
    ? allBestSets.reduce((selected, candidate) =>
        compareBestSet(candidate, selected) > 0 ? candidate : selected,
      )
    : null;
  const maxWeights = history.points
    .map((point) => point.maxWeight)
    .filter((value): value is number => value !== null);
  const maxReps = history.points
    .map((point) => point.maxReps)
    .filter((value): value is number => value !== null);
  const firstBestVolume = first.bestSet?.volume ?? null;
  const lastBestVolume = last.bestSet?.volume ?? null;
  return {
    exerciseId: history.exerciseId,
    name: history.name,
    sessions: history.points.length,
    completedSets: history.points.reduce((sum, point) => sum + point.completedSets, 0),
    totalVolume: sumAvailable(
      history.points.map((point) => point.volume ?? undefined),
      history.points.every((point) => point.completedSets === 0),
    ),
    maxWeight: maxWeights.length > 0 ? Math.max(...maxWeights) : null,
    maxReps: maxReps.length > 0 ? Math.max(...maxReps) : null,
    bestSet: selectedBest,
    firstPerformance: first,
    lastPerformance: last,
    change: {
      maxWeight:
        first.maxWeight !== null && last.maxWeight !== null
          ? round(last.maxWeight - first.maxWeight, 3)
          : null,
      maxWeightPercent: percentageChange(first.maxWeight, last.maxWeight),
      bestSetVolume:
        firstBestVolume !== null && lastBestVolume !== null
          ? round(lastBestVolume - firstBestVolume, 3)
          : null,
      bestSetVolumePercent: percentageChange(firstBestVolume, lastBestVolume),
    },
  };
}

function allPerformance(workouts: NormalizedWorkout[]): ExercisePerformance[] {
  return exerciseHistories(workouts)
    .filter((history) => history.points.length > 0)
    .map(performanceFromHistory)
    .sort(
      (left, right) =>
        (right.totalVolume ?? -1) - (left.totalVolume ?? -1) ||
        right.completedSets - left.completedSets ||
        left.name.localeCompare(right.name),
    );
}

interface MutableMuscleExposure {
  muscleId: string;
  directSets: number;
  indirectSets: number;
  directVolumes: number[];
  indirectVolumes: number[];
  workoutIds: Set<string>;
  weeks: Set<string>;
  exercises: Map<string, { name: string; roles: Set<"target" | "synergist"> }>;
}

function muscleExposure(
  workouts: NormalizedWorkout[],
  metadata: ExerciseMetadata[],
  inclusiveDays: number,
): { muscles: MuscleExposure[]; unmappedExerciseIds: string[] } {
  const metadataById = new Map(metadata.map((exercise) => [exercise.id, exercise]));
  const aggregate = new Map<string, MutableMuscleExposure>();
  const unmapped = new Set<string>();
  const entry = (muscleId: string): MutableMuscleExposure => {
    const existing = aggregate.get(muscleId);
    if (existing) return existing;
    const created: MutableMuscleExposure = {
      muscleId,
      directSets: 0,
      indirectSets: 0,
      directVolumes: [],
      indirectVolumes: [],
      workoutIds: new Set(),
      weeks: new Set(),
      exercises: new Map(),
    };
    aggregate.set(muscleId, created);
    return created;
  };

  for (const workout of workouts) {
    for (const exercise of workout.exercises) {
      const exerciseMetadata = metadataById.get(exercise.exerciseId);
      if (!exerciseMetadata) {
        unmapped.add(exercise.exerciseId);
        continue;
      }
      const targets = new Set(exerciseMetadata.targetMuscleIds);
      const synergists = new Set(
        exerciseMetadata.synergistMuscleIds.filter((muscleId) => !targets.has(muscleId)),
      );
      const completed = exercise.sets.filter((set) => set.isCompleted);
      if (completed.length === 0) continue;
      const expose = (muscleId: string, role: "target" | "synergist"): void => {
        const muscle = entry(muscleId);
        if (role === "target") {
          muscle.directSets += completed.length;
          muscle.directVolumes.push(
            ...completed.map((set) => set.volume).filter((value): value is number => value !== undefined),
          );
        } else {
          muscle.indirectSets += completed.length;
          muscle.indirectVolumes.push(
            ...completed.map((set) => set.volume).filter((value): value is number => value !== undefined),
          );
        }
        muscle.workoutIds.add(workout.id);
        if (workout.date) muscle.weeks.add(isoWeekKey(workout.date));
        const associated = muscle.exercises.get(exercise.exerciseId) ?? {
          name: exercise.name,
          roles: new Set<"target" | "synergist">(),
        };
        associated.roles.add(role);
        muscle.exercises.set(exercise.exerciseId, associated);
      };
      for (const muscleId of targets) expose(muscleId, "target");
      for (const muscleId of synergists) expose(muscleId, "synergist");
    }
  }

  const periodWeeks = Math.max(1, inclusiveDays / 7);
  const muscles = [...aggregate.values()]
    .map((muscle): MuscleExposure => ({
      muscleId: muscle.muscleId,
      muscle: muscleLabel(muscle.muscleId),
      directSets: muscle.directSets,
      indirectSets: muscle.indirectSets,
      exposureSets: muscle.directSets + muscle.indirectSets,
      directVolume: sumAvailable(muscle.directVolumes),
      indirectVolume: sumAvailable(muscle.indirectVolumes),
      sessions: muscle.workoutIds.size,
      activeWeeks: muscle.weeks.size,
      frequencyPerWeek: round(muscle.workoutIds.size / periodWeeks),
      exercises: [...muscle.exercises.entries()]
        .map(([exerciseId, associated]) => ({
          exerciseId,
          name: associated.name,
          roles: [...associated.roles].sort() as Array<"target" | "synergist">,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    }))
    .sort(
      (left, right) =>
        right.directSets - left.directSets ||
        right.indirectSets - left.indirectSets ||
        left.muscle.localeCompare(right.muscle),
    );
  return { muscles, unmappedExerciseIds: [...unmapped].sort() };
}

function nutritionAverages(days: NutritionDay[]): NutritionAverages {
  return {
    caloriesConsumed: average(days.map((day) => day.caloriesConsumed)),
    calorieGoal: average(days.map((day) => day.calorieGoal)),
    proteinGrams: average(days.map((day) => day.proteinGrams)),
    carbohydrateGrams: average(days.map((day) => day.carbohydrateGrams)),
    fatGrams: average(days.map((day) => day.fatGrams)),
    waterMilliliters: average(days.map((day) => day.waterMilliliters)),
  };
}

function emptyNutrition(): DailyNutrition {
  return {
    caloriesConsumed: null,
    calorieGoal: null,
    proteinGrams: null,
    carbohydrateGrams: null,
    fatGrams: null,
    waterMilliliters: null,
  };
}

export class FitnessService {
  private readonly lyfta: LyftaFitnessClient | undefined;
  private readonly yazio: YazioFitnessClient | undefined;
  private readonly maxRangeDays: number;
  private readonly maxWorkouts: number;
  private readonly concurrency: number;

  constructor(options: FitnessServiceOptions) {
    this.lyfta = options.lyfta;
    this.yazio = options.yazio;
    this.maxRangeDays = positiveInteger(options.maxRangeDays, 366);
    this.maxWorkouts = positiveInteger(options.maxWorkouts, 1_000);
    this.concurrency = positiveInteger(options.concurrency, 4);
  }

  async dailySummary(date: string): Promise<FitnessDailySummary> {
    enumerateDates(date, date, this.maxRangeDays);
    const limiter = createConcurrencyLimiter(this.concurrency);
    const tracker = this.tracker();

    const workoutsPromise = this.loadWorkoutsWithSummaries(limiter, tracker);
    const summaryPromise = this.capture(
      "yazio",
      `daily summary for ${date}`,
      tracker,
      limiter,
      () => this.yazio?.getDailySummary(date),
    );
    const waterPromise = this.capture(
      "yazio",
      `water intake for ${date}`,
      tracker,
      limiter,
      () => this.yazio?.getWaterIntake(date),
    );
    const goalsPromise = this.capture(
      "yazio",
      `goals for ${date}`,
      tracker,
      limiter,
      () => this.yazio?.getGoals(date),
    );

    const [workoutBatch, rawSummary, rawWater, rawGoals] = await Promise.all([
      workoutsPromise,
      summaryPromise,
      waterPromise,
      goalsPromise,
    ]);
    const workouts = this.workoutsInRange(workoutBatch.workouts, date, date, tracker);
    const normalizedSummary = rawSummary === undefined ? null : normalizeNutrition(rawSummary);
    if (rawSummary !== undefined && !normalizedSummary) {
      tracker.warning(`Yazio daily summary for ${date} had an unrecognized shape.`);
    }
    const goal = rawGoals === undefined ? null : normalizeGoals(rawGoals);
    if (rawGoals !== undefined && rawGoals !== null && !goal) {
      tracker.warning(`Yazio goals for ${date} had an unrecognized shape.`);
    }
    const nutrition = normalizedSummary?.nutrition ?? emptyNutrition();
    if (nutrition.calorieGoal === null && goal) nutrition.calorieGoal = goal.calorieGoal;
    const water = rawWater === undefined ? null : normalizeWater(rawWater);
    if (rawWater !== undefined && rawWater !== null && water === null) {
      tracker.warning(`Yazio water intake for ${date} had an unrecognized shape.`);
    }
    if (water !== null) nutrition.waterMilliliters = water;

    return {
      date,
      nutrition,
      units: normalizedSummary?.units ?? { energy: null, mass: null },
      training: aggregateDailyTraining(workouts),
      dataQuality: tracker.snapshot(["lyfta", "yazio"]),
      methodology: METHODOLOGY,
    };
  }

  async weeklySummary(startDate: string): Promise<FitnessWeeklySummary> {
    const endDate = addDays(startDate, 6);
    const context = await this.periodContext(startDate, endDate);
    return this.periodResult(startDate, endDate, context);
  }

  async trainingNutritionSummary(
    startDate: string,
    endDate: string,
  ): Promise<FitnessTrainingNutritionSummary> {
    const context = await this.periodContext(startDate, endDate);
    return this.periodResult(startDate, endDate, context);
  }

  async muscleVolume(startDate: string, endDate: string): Promise<FitnessMuscleVolume> {
    const dates = enumerateDates(startDate, endDate, this.maxRangeDays);
    const limiter = createConcurrencyLimiter(this.concurrency);
    const tracker = this.tracker();
    const [batch, metadata] = await Promise.all([
      this.loadWorkouts(limiter, tracker),
      this.loadExerciseMetadata(limiter, tracker),
    ]);
    const workouts = this.workoutsInRange(batch.workouts, startDate, endDate, tracker);
    const exposure = muscleExposure(workouts, metadata, dates.length);
    if (exposure.unmappedExerciseIds.length > 0) {
      tracker.warning(
        `${exposure.unmappedExerciseIds.length} exercised Lyfta exercise id(s) had no muscle metadata.`,
      );
    }
    return {
      period: { startDate, endDate, inclusiveDays: dates.length },
      workoutCount: workouts.length,
      trainingDays: [...new Set(workouts.map((workout) => workout.date).filter((value): value is string => Boolean(value)))].sort(),
      muscles: exposure.muscles,
      unmappedExerciseIds: exposure.unmappedExerciseIds,
      dataQuality: tracker.snapshot(["lyfta"]),
      methodology: METHODOLOGY,
    };
  }

  async exerciseProgress(input: ExerciseProgressInput): Promise<FitnessExerciseProgress> {
    const dates = enumerateDates(input.startDate, input.endDate, this.maxRangeDays);
    const requestedId = input.exerciseId?.trim() || null;
    const requestedName = input.exerciseName?.trim() || null;
    if (!requestedId && !requestedName) {
      throw new Error("exerciseId or exerciseName is required.");
    }
    const limiter = createConcurrencyLimiter(this.concurrency);
    const tracker = this.tracker();
    const [batch, metadata] = await Promise.all([
      this.loadWorkouts(limiter, tracker),
      this.loadExerciseMetadata(limiter, tracker),
    ]);
    const workouts = this.workoutsInRange(batch.workouts, input.startDate, input.endDate, tracker);
    const histories = exerciseHistories(workouts);
    let matching = requestedId
      ? histories.filter((history) => history.exerciseId === requestedId)
      : [];
    let resolvedName =
      metadata.find((exercise) => exercise.id === requestedId)?.name ?? matching[0]?.name ?? null;

    if (!requestedId && requestedName) {
      const normalizedName = requestedName.toLocaleLowerCase();
      const metadataIds = metadata
        .filter((exercise) => exercise.name.trim().toLocaleLowerCase() === normalizedName)
        .map((exercise) => exercise.id);
      matching = histories.filter(
        (history) =>
          metadataIds.includes(history.exerciseId) ||
          history.name.trim().toLocaleLowerCase() === normalizedName,
      );
      resolvedName = matching[0]?.name ?? metadata.find((exercise) => metadataIds.includes(exercise.id))?.name ?? null;
    }

    if (matching.length === 0) {
      tracker.warning("No matching Lyfta exercise history was found in the requested period.");
    }
    if (matching.length > 1) {
      tracker.warning("The exercise name matched multiple Lyfta exercise ids; their histories were combined.");
    }
    const combined = matching.length > 0
      ? {
          exerciseId: matching.map((history) => history.exerciseId).sort().join(","),
          name: resolvedName ?? requestedName ?? "Unknown exercise",
          points: matching
            .flatMap((history) => history.points)
            .sort((left, right) => left.date.localeCompare(right.date) || left.workoutId.localeCompare(right.workoutId)),
        }
      : null;
    const summary = combined ? performanceFromHistory(combined) : null;

    return {
      period: {
        startDate: input.startDate,
        endDate: input.endDate,
        inclusiveDays: dates.length,
      },
      exercise: {
        requestedId,
        requestedName,
        resolvedIds: matching.map((history) => history.exerciseId).sort(),
        resolvedName,
      },
      history: combined?.points ?? [],
      summary,
      dataQuality: tracker.snapshot(["lyfta"]),
      methodology: METHODOLOGY,
    };
  }

  private tracker(): QualityTracker {
    return new QualityTracker(Boolean(this.lyfta), Boolean(this.yazio));
  }

  private async capture<T>(
    source: SourceName,
    operation: string,
    tracker: QualityTracker,
    limiter: ConcurrencyLimiter,
    call: () => Promise<T> | undefined,
  ): Promise<T | undefined> {
    const configured = source === "lyfta" ? this.lyfta !== undefined : this.yazio !== undefined;
    if (!configured) return undefined;
    try {
      const value = await limiter.run(async () => {
        const pending = call();
        if (!pending) return undefined;
        return pending;
      });
      if (value === undefined) return undefined;
      tracker.success(source);
      return value;
    } catch {
      tracker.failure(source, operation);
      return undefined;
    }
  }

  private async loadWorkouts(
    limiter: ConcurrencyLimiter,
    tracker: QualityTracker,
  ): Promise<WorkoutBatch> {
    if (!this.lyfta) return { workouts: [], truncated: false };
    const pageSize = Math.min(100, this.maxWorkouts);
    const normalized: NormalizedWorkout[] = [];
    const seenIds = new Set<string>();
    let page = 1;
    let rawLoaded = 0;
    let finalPageWasFull = false;

    while (rawLoaded < this.maxWorkouts) {
      const remaining = this.maxWorkouts - rawLoaded;
      const limit = Math.min(pageSize, remaining);
      const response = await this.capture(
        "lyfta",
        `workouts page ${page}`,
        tracker,
        limiter,
        () => this.lyfta?.listWorkouts({ page, limit }),
      );
      if (response === undefined) break;
      const collection = extractCollection(response, ["workouts", "items", "results"]);
      if (!collection.recognized) {
        tracker.warning(`Lyfta workouts page ${page} had an unrecognized shape.`);
        break;
      }
      const slice = collection.items.slice(0, remaining);
      rawLoaded += slice.length;
      let invalid = 0;
      for (const item of slice) {
        const workout = normalizeWorkout(item);
        if (!workout) {
          invalid += 1;
          continue;
        }
        if (!seenIds.has(workout.id)) {
          normalized.push(workout);
          seenIds.add(workout.id);
        }
      }
      if (invalid > 0) {
        tracker.warning(`${invalid} Lyfta workout record(s) on page ${page} could not be normalized.`);
      }
      finalPageWasFull = collection.items.length >= limit;
      if (collection.items.length < limit || collection.items.length === 0) break;
      page += 1;
    }

    const truncated = rawLoaded >= this.maxWorkouts && finalPageWasFull;
    if (truncated) {
      tracker.truncated(`Lyfta workouts were limited to ${this.maxWorkouts} records.`);
    }
    return { workouts: normalized, truncated };
  }

  private async loadWorkoutSummaries(
    limiter: ConcurrencyLimiter,
    tracker: QualityTracker,
  ): Promise<Map<string, NormalizedWorkout>> {
    const summaries = new Map<string, NormalizedWorkout>();
    if (!this.lyfta) return summaries;

    const pageSize = Math.min(1_000, this.maxWorkouts);
    let rawLoaded = 0;
    let page = 1;
    let finalPageWasFull = false;

    while (rawLoaded < this.maxWorkouts) {
      const remaining = this.maxWorkouts - rawLoaded;
      const limit = Math.min(pageSize, remaining);
      const response = await this.capture(
        "lyfta",
        `workout summaries page ${page}`,
        tracker,
        limiter,
        () => this.lyfta?.listWorkoutSummaries({ page, limit }),
      );
      if (response === undefined) break;
      const collection = extractCollection(response, ["workouts", "items", "results"]);
      if (!collection.recognized) {
        tracker.warning(`Lyfta workout summaries page ${page} had an unrecognized shape.`);
        break;
      }

      const slice = collection.items.slice(0, remaining);
      rawLoaded += slice.length;
      let invalid = 0;
      let added = 0;
      for (const item of slice) {
        const summary = normalizeWorkout(item);
        if (!summary) {
          invalid += 1;
          continue;
        }
        if (!summaries.has(summary.id)) added += 1;
        summaries.set(summary.id, summary);
      }
      if (invalid > 0) {
        tracker.warning(
          `${invalid} Lyfta workout summary record(s) on page ${page} could not be normalized.`,
        );
      }

      finalPageWasFull = collection.items.length >= limit;
      if (collection.items.length === 0 || collection.items.length < limit) break;
      if (added === 0) {
        tracker.warning("Lyfta workout summary pagination repeated a page and was stopped.");
        break;
      }
      page += 1;
    }

    if (rawLoaded >= this.maxWorkouts && finalPageWasFull) {
      tracker.truncated(`Lyfta workout summaries were limited to ${this.maxWorkouts} records.`);
    }
    return summaries;
  }

  private async loadWorkoutsWithSummaries(
    limiter: ConcurrencyLimiter,
    tracker: QualityTracker,
  ): Promise<WorkoutBatch> {
    const [batch, summaries] = await Promise.all([
      this.loadWorkouts(limiter, tracker),
      this.loadWorkoutSummaries(limiter, tracker),
    ]);

    return {
      ...batch,
      workouts: batch.workouts.map((workout) => {
        const summary = summaries.get(workout.id);
        return {
          ...workout,
          ...(workout.durationSeconds === undefined && summary?.durationSeconds !== undefined
            ? { durationSeconds: summary.durationSeconds }
            : {}),
        };
      }),
    };
  }

  private async loadExerciseMetadata(
    limiter: ConcurrencyLimiter,
    tracker: QualityTracker,
  ): Promise<ExerciseMetadata[]> {
    if (!this.lyfta) return [];
    const pageSize = Math.min(100, this.maxWorkouts);
    const byId = new Map<string, ExerciseMetadata>();
    let rawLoaded = 0;
    let page = 1;

    while (rawLoaded < this.maxWorkouts) {
      const limit = Math.min(pageSize, this.maxWorkouts - rawLoaded);
      const response = await this.capture(
        "lyfta",
        `exercise metadata page ${page}`,
        tracker,
        limiter,
        () => this.lyfta?.listExercises({ page, limit }),
      );
      if (response === undefined) break;
      const collection = extractCollection(response, ["exercises", "items", "results"]);
      if (!collection.recognized) {
        tracker.warning(`Lyfta exercise metadata page ${page} had an unrecognized shape.`);
        break;
      }
      const slice = collection.items.slice(0, this.maxWorkouts - rawLoaded);
      rawLoaded += slice.length;
      let invalid = 0;
      let added = 0;
      for (const item of slice) {
        const metadata = normalizeExerciseMetadata(item);
        if (!metadata) {
          invalid += 1;
          continue;
        }
        if (!byId.has(metadata.id)) added += 1;
        byId.set(metadata.id, metadata);
      }
      if (invalid > 0) {
        tracker.warning(`${invalid} Lyfta exercise metadata record(s) on page ${page} could not be normalized.`);
      }
      if (collection.items.length === 0 || collection.items.length < limit) break;
      if (added === 0) {
        tracker.warning("Lyfta exercise metadata pagination repeated a page and was stopped.");
        break;
      }
      page += 1;
    }
    if (rawLoaded >= this.maxWorkouts) {
      tracker.truncated(`Lyfta exercise metadata was limited to ${this.maxWorkouts} records.`);
    }
    return [...byId.values()];
  }

  private workoutsInRange(
    workouts: NormalizedWorkout[],
    startDate: string,
    endDate: string,
    tracker: QualityTracker,
  ): NormalizedWorkout[] {
    const undated = workouts.filter((workout) => !workout.date).length;
    if (undated > 0) {
      tracker.warning(`${undated} Lyfta workout(s) without a usable date were excluded.`);
    }
    return workouts
      .filter((workout) => workout.date !== undefined && workout.date >= startDate && workout.date <= endDate)
      .sort((left, right) => (left.date ?? "").localeCompare(right.date ?? "") || left.id.localeCompare(right.id));
  }

  private async periodContext(startDate: string, endDate: string): Promise<PeriodContext> {
    const dates = enumerateDates(startDate, endDate, this.maxRangeDays);
    const limiter = createConcurrencyLimiter(this.concurrency);
    const tracker = this.tracker();
    const workoutsPromise = this.loadWorkoutsWithSummaries(limiter, tracker);
    const metadataPromise = this.loadExerciseMetadata(limiter, tracker);
    const yazioPromise = Promise.all(
      dates.map(async (date): Promise<{
        nutrition: NutritionDay;
        units: NutritionUnits | null;
      }> => {
        const rawSummary = await this.capture(
          "yazio",
          `daily summary for ${date}`,
          tracker,
          limiter,
          () => this.yazio?.getDailySummary(date),
        );
        const summary = rawSummary === undefined ? null : normalizeNutrition(rawSummary);
        if (rawSummary !== undefined && !summary) {
          tracker.warning(`Yazio daily summary for ${date} had an unrecognized shape.`);
        }
        return {
          nutrition: {
            date,
            available: summary !== null,
            ...(summary?.nutrition ?? emptyNutrition()),
          },
          units: summary?.units ?? null,
        };
      }),
    );

    const [batch, metadata, yazioDays] = await Promise.all([
      workoutsPromise,
      metadataPromise,
      yazioPromise,
    ]);
    return {
      dates,
      workouts: this.workoutsInRange(batch.workouts, startDate, endDate, tracker),
      metadata,
      nutritionDays: yazioDays.map((day) => day.nutrition),
      nutritionUnits:
        yazioDays.map((day) => day.units).find((units): units is NutritionUnits => units !== null) ?? {
          energy: null,
          mass: null,
        },
      tracker,
    };
  }

  private periodResult(
    startDate: string,
    endDate: string,
    context: PeriodContext,
  ): FitnessTrainingNutritionSummary {
    const trainingDays = [...new Set(
      context.workouts
        .map((workout) => workout.date)
        .filter((date): date is string => date !== undefined),
    )].sort();
    const trainingDaySet = new Set(trainingDays);
    const restDays = context.dates.filter((date) => !trainingDaySet.has(date));
    const exposure = muscleExposure(context.workouts, context.metadata, context.dates.length);
    if (exposure.unmappedExerciseIds.length > 0) {
      context.tracker.warning(
        `${exposure.unmappedExerciseIds.length} exercised Lyfta exercise id(s) had no muscle metadata.`,
      );
    }
    const performance = allPerformance(context.workouts);
    const volumes = context.workouts.map(calculatedWorkoutVolume);
    const trainingNutrition = context.nutritionDays.filter((day) => trainingDaySet.has(day.date));
    const restNutrition = context.nutritionDays.filter((day) => !trainingDaySet.has(day.date));

    return {
      period: { startDate, endDate, inclusiveDays: context.dates.length },
      training: {
        workoutCount: context.workouts.length,
        trainingDayCount: trainingDays.length,
        trainingDays,
        restDayCount: restDays.length,
        restDays,
        totalSets: context.workouts.reduce((sum, workout) => sum + completedSetCount(workout), 0),
        totalVolume: sumAvailable(volumes, context.workouts.length === 0),
        workoutsWithCalculableVolume: volumes.filter((volume) => volume !== undefined).length,
        durationSeconds: sumAvailable(
          context.workouts.map((workout) => workout.durationSeconds),
          context.workouts.length === 0,
        ),
        workouts: context.workouts.map(publicWorkout),
        muscleVolume: exposure.muscles,
        mainExercises: performance.slice(0, 10),
        performanceEvolution: performance,
      },
      nutrition: {
        daysWithData: context.nutritionDays.filter((day) => day.available).length,
        daysRequested: context.dates.length,
        averages: nutritionAverages(context.nutritionDays),
        daily: context.nutritionDays,
        units: context.nutritionUnits,
      },
      trainingNutritionComparison: {
        trainingDaysWithNutrition: trainingNutrition.filter((day) => day.available).length,
        restDaysWithNutrition: restNutrition.filter((day) => day.available).length,
        trainingDayAverages: nutritionAverages(trainingNutrition),
        restDayAverages: nutritionAverages(restNutrition),
      },
      dataQuality: context.tracker.snapshot(["lyfta", "yazio"]),
      methodology: METHODOLOGY,
    };
  }
}
