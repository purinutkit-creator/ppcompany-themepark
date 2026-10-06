import type { EntitlementType } from './types';

/** Age in whole years on a given date (YYYY-MM-DD). */
export function ageOn(birthday: string | null | undefined, onDate: string): number | null {
  if (!birthday) return null;
  const [by, bm, bd] = birthday.slice(0, 10).split('-').map(Number);
  const [y, m, d] = onDate.slice(0, 10).split('-').map(Number);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age--;
  return age;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface EntitlementLike {
  id: string;
  ride_id: string | null;
  type: EntitlementType;
  uses_left: number | null;
  valid_from: string | Date | null;
  valid_until: string | Date | null;
  status: string;
  is_fast_pass?: boolean;
}

/** True when an entitlement can be used for `rideId` at `now`. */
export function entitlementUsable(e: EntitlementLike, rideId: string, now: Date): boolean {
  if (e.status !== 'ACTIVE') return false;
  if (e.ride_id && e.ride_id !== rideId) return false;
  if (e.valid_from && new Date(e.valid_from) > now) return false;
  if (e.valid_until && new Date(e.valid_until) < now) return false;
  if ((e.type === 'ONE_TIME' || e.type === 'MULTI_USE') && !(Number(e.uses_left) > 0)) return false;
  return true;
}

/**
 * Pick which entitlement a ride scan consumes. Unlimited / time / date passes go first so counted
 * add-ons are never burned while an unlimited pass covers the ride; among counted ones the specific ride
 * and the earliest expiry win.
 */
export function pickEntitlement<T extends EntitlementLike>(list: T[], rideId: string, now: Date): T | null {
  const ok = list.filter((e) => entitlementUsable(e, rideId, now));
  if (!ok.length) return null;
  const rank = (e: T) => (e.type === 'UNLIMITED' || e.type === 'DATE_BASED' || e.type === 'TIME_BASED' ? 0 : 1);
  ok.sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r) return r;
    const s = (a.ride_id ? 0 : 1) - (b.ride_id ? 0 : 1);
    if (s) return s;
    const ea = a.valid_until ? new Date(a.valid_until).getTime() : Infinity;
    const eb = b.valid_until ? new Date(b.valid_until).getTime() : Infinity;
    return ea - eb;
  });
  return ok[0];
}

/** Whether the entitlement list has a counted entitlement for this ride that is used up. */
export function hasExhausted(list: EntitlementLike[], rideId: string): boolean {
  return list.some((e) => (e.ride_id === rideId || e.ride_id == null) && (e.status === 'EXHAUSTED' || ((e.type === 'ONE_TIME' || e.type === 'MULTI_USE') && e.uses_left === 0)));
}

/** Estimated wait (minutes) for a virtual queue position. */
export function estimateWait(ahead: number, capacityPerCycle: number, cycleMinutes: number): number {
  if (ahead <= 0) return 0;
  return Math.ceil(Math.ceil(ahead / Math.max(1, capacityPerCycle)) * cycleMinutes);
}

/** Occupancy colour bucket for live maps. */
export function loadLevel(current: number, capacity: number, warnPct = 70, crowdedPct = 90): 'NORMAL' | 'BUSY' | 'CROWDED' {
  if (!capacity) return 'NORMAL';
  const pct = (current / capacity) * 100;
  return pct >= crowdedPct ? 'CROWDED' : pct >= warnPct ? 'BUSY' : 'NORMAL';
}
