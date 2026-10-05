import type { MenuSchedule } from './types';

export interface LocalNow {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  dow: number; // 0 = Sunday
}

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of `now` in the branch time zone (works in browsers and Node). */
export function localNow(now: Date, timeZone = 'Asia/Bangkok'): LocalNow {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
    dow: DOW[get('weekday')] ?? 0,
  };
}

const hm = (t: string) => t.slice(0, 5);

/** True when `time` (HH:MM) lies in [start, end). Supports windows that wrap past midnight. */
export function inTimeWindow(time: string, start: string | null, end: string | null): boolean {
  if (!start || !end) return true;
  const s = hm(start);
  const e = hm(end);
  if (s === e) return true;
  if (s < e) return time >= s && time < e;
  return time >= s || time < e;
}

export function isScheduleOpen(schedule: MenuSchedule | null | undefined, now: LocalNow): boolean {
  if (!schedule || !schedule.is_active) return true;
  if (schedule.days?.length && !schedule.days.includes(now.dow)) return false;
  return inTimeWindow(now.time, schedule.start_time, schedule.end_time);
}
