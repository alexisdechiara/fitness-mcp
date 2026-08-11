const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class DateRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DateRangeError";
  }
}

export function isDateOnly(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function upstreamDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  if (match?.[1] && isDateOnly(match[1])) return match[1];
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : undefined;
}

function asUtcDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function daysInclusive(startDate: string, endDate: string): number {
  return Math.floor((asUtcDate(endDate).getTime() - asUtcDate(startDate).getTime()) / 86_400_000) + 1;
}

export function enumerateDates(startDate: string, endDate: string, maxDays: number): string[] {
  if (!isDateOnly(startDate) || !isDateOnly(endDate)) {
    throw new DateRangeError("Dates must use the YYYY-MM-DD format.");
  }
  const count = daysInclusive(startDate, endDate);
  if (count < 1) throw new DateRangeError("startDate must be on or before endDate.");
  if (count > maxDays) {
    throw new DateRangeError(`Date range is limited to ${maxDays} inclusive days.`);
  }

  return Array.from({ length: count }, (_unused, offset) => {
    const date = asUtcDate(startDate);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  });
}

export function addDays(date: string, days: number): string {
  const result = asUtcDate(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

export function isoWeekKey(date: string): string {
  const value = asUtcDate(date);
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((value.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
