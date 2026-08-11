import { upstreamDate } from "./dates.js";
import { parseLyftaIds } from "./muscles.js";

export type UnknownRecord = Record<string, unknown>;

export interface NormalizedSet {
  id?: string;
  weight?: number;
  reps?: number;
  rir?: number;
  duration?: number;
  distance?: number;
  setTypeId?: string;
  isCompleted: boolean;
  volume?: number;
}

export interface NormalizedWorkoutExercise {
  exerciseId: string;
  name: string;
  exerciseType?: string;
  sets: NormalizedSet[];
}

export interface NormalizedWorkout {
  id: string;
  title: string;
  date?: string;
  durationSeconds?: number;
  reportedVolume?: number;
  exercises: NormalizedWorkoutExercise[];
}

export interface ExerciseMetadata {
  id: string;
  name: string;
  exerciseType?: string;
  targetMuscleIds: string[];
  synergistMuscleIds: string[];
}

export function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

export function parseDurationSeconds(value: unknown): number | undefined {
  const numeric = finiteNumber(value);
  if (numeric !== undefined) return numeric;
  if (typeof value !== "string") return undefined;
  const parts = value.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return undefined;
  if (parts.length === 3) return (parts[0] ?? 0) * 3_600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  if (parts.length === 2) return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
  return undefined;
}

function normalizeCompleted(value: unknown): boolean {
  return value !== false && value !== 0 && value !== "0" && value !== "false";
}

export function normalizeSet(value: unknown): NormalizedSet | undefined {
  const source = record(value);
  if (!source) return undefined;
  const weight = finiteNumber(source.weight);
  const reps = finiteNumber(source.reps);
  const volume = weight !== undefined && reps !== undefined ? weight * reps : undefined;
  return {
    ...(stringValue(source.id) ? { id: stringValue(source.id) } : {}),
    ...(weight !== undefined ? { weight } : {}),
    ...(reps !== undefined ? { reps } : {}),
    ...(finiteNumber(source.rir) !== undefined ? { rir: finiteNumber(source.rir) } : {}),
    ...(finiteNumber(source.duration) !== undefined ? { duration: finiteNumber(source.duration) } : {}),
    ...(finiteNumber(source.distance) !== undefined ? { distance: finiteNumber(source.distance) } : {}),
    ...(stringValue(source.set_type_id) ? { setTypeId: stringValue(source.set_type_id) } : {}),
    isCompleted: normalizeCompleted(source.is_completed),
    ...(volume !== undefined ? { volume } : {}),
  };
}

export function normalizeWorkout(value: unknown): NormalizedWorkout | undefined {
  const source = record(value);
  const id = stringValue(source?.id);
  if (!source || !id) return undefined;
  const exercises = array(source.exercises)
    .map((entry): NormalizedWorkoutExercise | undefined => {
      const exercise = record(entry);
      const exerciseId = stringValue(exercise?.exercise_id);
      if (!exercise || !exerciseId) return undefined;
      return {
        exerciseId,
        name: stringValue(exercise.excercise_name) ?? stringValue(exercise.exercise_name) ?? "Unknown exercise",
        ...(stringValue(exercise.exercise_type) ? { exerciseType: stringValue(exercise.exercise_type) } : {}),
        sets: array(exercise.sets)
          .map(normalizeSet)
          .filter((set): set is NormalizedSet => Boolean(set)),
      };
    })
    .filter((exercise): exercise is NormalizedWorkoutExercise => Boolean(exercise));

  const reportedVolume = finiteNumber(source.total_volume) ?? finiteNumber(source.totalLiftedWeight);
  return {
    id,
    title: stringValue(source.title) ?? "Untitled workout",
    ...(upstreamDate(source.workout_perform_date) ? { date: upstreamDate(source.workout_perform_date) } : {}),
    ...(parseDurationSeconds(source.workout_duration) !== undefined
      ? { durationSeconds: parseDurationSeconds(source.workout_duration) }
      : {}),
    ...(reportedVolume !== undefined ? { reportedVolume } : {}),
    exercises,
  };
}

export function normalizeExerciseMetadata(value: unknown): ExerciseMetadata | undefined {
  const source = record(value);
  const id = stringValue(source?.id);
  const name = stringValue(source?.name);
  if (!source || !id || !name) return undefined;
  return {
    id,
    name,
    ...(stringValue(source.exercise_type) ? { exerciseType: stringValue(source.exercise_type) } : {}),
    targetMuscleIds: parseLyftaIds(source.Target_muscles_id),
    synergistMuscleIds: parseLyftaIds(source.Synergist_muscles_id),
  };
}

export function calculatedWorkoutVolume(workout: NormalizedWorkout): number | undefined {
  const setVolumes = workout.exercises.flatMap((exercise) =>
    exercise.sets.filter((set) => set.isCompleted).map((set) => set.volume).filter((value): value is number => value !== undefined),
  );
  return setVolumes.length > 0 ? setVolumes.reduce((sum, value) => sum + value, 0) : workout.reportedVolume;
}

export function completedSetCount(workout: NormalizedWorkout): number {
  return workout.exercises.reduce(
    (sum, exercise) => sum + exercise.sets.filter((set) => set.isCompleted).length,
    0,
  );
}
