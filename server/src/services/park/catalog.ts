import { addDays, localNow, type ParkPromotion } from '@kiosk/shared';
import { one, query, type Db } from '../../db/pool';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { branchInfo, branchToday, parkSettings } from './common';

const PROMO_COLS = `id, code, name, description, badge, type, value_type, value, buy_qty, get_qty, combo_price, min_order,
  max_discount, scope, product_ids, category_ids, branch_ids, start_date::text, end_date::text,
  to_char(start_time,'HH24:MI') AS start_time, to_char(end_time,'HH24:MI') AS end_time, days, usage_limit, usage_count,
  requires_code, priority, is_active, applies_to, channels, item_types, package_ids, ticket_type_ids, tier_ids, min_qty, max_units,
  advance_days, birthday_only, members_only, stackable, usage_per_member`;

export async function loadParkPromotions(db?: Db): Promise<ParkPromotion[]> {
  const rows = await query<any>(`SELECT ${PROMO_COLS} FROM promotions WHERE is_active AND applies_to IN ('PARK','ALL') ORDER BY priority DESC, created_at`, [], db);
  return rows.map((r) => ({ ...r, value: Number(r.value), min_order: r.min_order == null ? null : Number(r.min_order), max_discount: r.max_discount == null ? null : Number(r.max_discount) }));
}

export const isWeekend = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
};
const dow = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

export interface PackageAvailability {
  available: boolean;
  reason: string | null;
  remaining: number | null;
}

/** Tickets held for a date (unpaid holds count until they expire). */
export async function ticketsForDate(db: Db, branchId: string, date: string, packageId?: string | null): Promise<number> {
  const r = await one<any>(
    `SELECT COUNT(*)::int AS n FROM tickets WHERE branch_id=$1 AND visit_date=$2 AND status NOT IN ('CANCELLED','REFUNDED','EXPIRED')
       AND ($3::uuid IS NULL OR package_id=$3)`,
    [branchId, date, packageId ?? null],
    db,
  );
  return r.n;
}

/** Validates a package can be sold for a visit date / channel and returns the remaining capacity. */
export async function checkPackageAvailability(db: Db, pkg: any, branchId: string, visitDate: string | null, channel: string, guests = 1): Promise<PackageAvailability> {
  const s = await parkSettings(branchId, db);
  if (!pkg.is_active) return { available: false, reason: 'PACKAGE_INACTIVE', remaining: 0 };
  if (pkg.branch_ids?.length && !pkg.branch_ids.includes(branchId)) return { available: false, reason: 'PACKAGE_NOT_IN_BRANCH', remaining: 0 };
  if (pkg.channels?.length && !pkg.channels.includes(channel) && !(channel === 'PORTAL' && pkg.channels.includes('ONLINE'))) {
    return { available: false, reason: 'CHANNEL_NOT_ALLOWED', remaining: 0 };
  }
  const today = await branchToday(branchId, db);
  if (pkg.sale_from && today < pkg.sale_from) return { available: false, reason: 'NOT_ON_SALE_YET', remaining: 0 };
  if (pkg.sale_to && today > pkg.sale_to) return { available: false, reason: 'SALE_ENDED', remaining: 0 };
  if (!pkg.requires_visit_date || !visitDate) return { available: true, reason: null, remaining: null };
  if (visitDate < today) return { available: false, reason: 'DATE_IN_PAST', remaining: 0 };
  if (visitDate > addDays(today, s.booking.advanceDays)) return { available: false, reason: 'DATE_TOO_FAR', remaining: 0 };
  if (visitDate === today && ['ONLINE', 'PORTAL'].includes(channel)) {
    const b = await branchInfo(branchId, db);
    if (localNow(new Date(), b.timezone).time >= s.booking.sameDayCutoff) return { available: false, reason: 'SAME_DAY_CUTOFF', remaining: 0 };
  }
  if (pkg.valid_days?.length && !pkg.valid_days.includes(dow(visitDate))) return { available: false, reason: 'NOT_VALID_ON_DAY', remaining: 0 };
  if ((pkg.blackout_dates ?? []).some((d: any) => String(d).slice(0, 10) === visitDate)) return { available: false, reason: 'BLACKOUT_DATE', remaining: 0 };
  let remaining: number | null = null;
  if (pkg.kind === 'ADMISSION') {
    const total = await ticketsForDate(db, branchId, visitDate);
    remaining = Math.max(0, s.park.dailyTicketCapacity - total);
    if (pkg.daily_capacity != null) remaining = Math.min(remaining, Math.max(0, pkg.daily_capacity - (await ticketsForDate(db, branchId, visitDate, pkg.id))));
    if (remaining < guests) return { available: false, reason: 'SOLD_OUT', remaining };
  }
  return { available: true, reason: null, remaining };
}

/**
 * Unit price for a package line: weekend price on Sat/Sun, member / tier price for members
 * (the lower one wins). `memberPriced` tells the engine not to stack the tier % discount on top.
 */
export function resolvePackagePrice(priceRow: any, visitDate: string | null, member: { tierId: string | null } | null) {
  const normal = Number(priceRow.price);
  const base = visitDate && isWeekend(visitDate) && priceRow.weekend_price != null ? Number(priceRow.weekend_price) : normal;
  if (!member) return { unit: base, base, memberPriced: false };
  const tierPrice = member.tierId && priceRow.tier_prices?.[member.tierId] != null ? Number(priceRow.tier_prices[member.tierId]) : null;
  const memberPrice = tierPrice ?? (priceRow.member_price != null ? Number(priceRow.member_price) : null);
  if (memberPrice != null && memberPrice < base) return { unit: memberPrice, base, memberPriced: true };
  return { unit: base, base, memberPriced: false };
}

/** Public catalogue for a branch / channel / date: packages with prices per ticket type and availability. */
export async function catalog(branchId: string, channel: string, visitDate: string | null, member: { tierId: string | null } | null = null, db?: Db) {
  const pkgs = await query<any>(
    `SELECT p.*, p.sale_from::text AS sale_from, p.sale_to::text AS sale_to, to_char(p.time_start,'HH24:MI') AS time_start, to_char(p.time_end,'HH24:MI') AS time_end,
            COALESCE((SELECT json_agg(json_build_object('ride_id', pr.ride_id, 'entitlement_type', pr.entitlement_type, 'uses', pr.uses, 'name', r.name, 'code', r.code) ORDER BY r.sort)
                        FROM package_rides pr JOIN rides r ON r.id=pr.ride_id WHERE pr.package_id=p.id), '[]') AS rides,
            COALESCE((SELECT json_agg(b ORDER BY b.type) FROM package_benefits b WHERE b.package_id=p.id), '[]') AS benefits
       FROM packages p WHERE p.is_active AND (cardinality(p.branch_ids)=0 OR $1 = ANY(p.branch_ids)) ORDER BY p.sort, p.created_at`,
    [branchId],
    db,
  );
  const prices = await query<any>(
    `SELECT pp.*, tt.code AS tt_code, tt.name AS tt_name, tt.sort AS tt_sort, tt.min_age, tt.max_age, tt.min_height, tt.max_height, tt.description AS tt_description
       FROM package_prices pp LEFT JOIN ticket_types tt ON tt.id=pp.ticket_type_id WHERE tt.id IS NULL OR tt.is_active ORDER BY tt.sort NULLS FIRST`,
    [],
    db,
  );
  const out = [];
  for (const p of pkgs) {
    if (p.member_only && !member) continue;
    if (p.tier_ids?.length && (!member?.tierId || !p.tier_ids.includes(member.tierId))) continue;
    const av = await checkPackageAvailability(db ?? (await import('../../db/pool')).pool, p, branchId, visitDate, channel);
    if (av.reason === 'CHANNEL_NOT_ALLOWED' || av.reason === 'PACKAGE_NOT_IN_BRANCH' || av.reason === 'SALE_ENDED' || av.reason === 'NOT_ON_SALE_YET') continue;
    out.push({
      ...p,
      availability: av,
      prices: prices
        .filter((x) => x.package_id === p.id)
        .map((x) => {
          const r = resolvePackagePrice(x, visitDate, member);
          return { id: x.id, ticket_type_id: x.ticket_type_id, ticket_type_code: x.tt_code, ticket_type_name: x.tt_name, ticket_type_description: x.tt_description, min_age: x.min_age, max_age: x.max_age, min_height: x.min_height, max_height: x.max_height, price: Number(x.price), member_price: x.member_price == null ? null : Number(x.member_price), weekend_price: x.weekend_price == null ? null : Number(x.weekend_price), unit_price: r.unit, member_priced: r.memberPriced };
        }),
    });
  }
  return out;
}

export async function loadPackage(db: Db, id: string) {
  const p = await one<any>(
    `SELECT p.*, p.sale_from::text AS sale_from, p.sale_to::text AS sale_to, to_char(p.time_start,'HH24:MI') AS time_start, to_char(p.time_end,'HH24:MI') AS time_end FROM packages p WHERE id=$1`,
    [id],
    db,
  );
  if (!p) throw notFound('Package');
  return p;
}

export async function packagePriceRow(db: Db, packageId: string, ticketTypeId: string | null) {
  const r =
    (ticketTypeId ? await one<any>(`SELECT * FROM package_prices WHERE package_id=$1 AND ticket_type_id=$2`, [packageId, ticketTypeId], db) : null) ??
    (await one<any>(`SELECT * FROM package_prices WHERE package_id=$1 AND ticket_type_id IS NULL`, [packageId], db));
  if (!r) {
    const p = await one<any>(`SELECT base_price FROM packages WHERE id=$1`, [packageId], db);
    if (!p) throw notFound('Package');
    if (ticketTypeId) throw badRequest('NO_PRICE_FOR_TICKET_TYPE', 'This ticket type is not sold for the package');
    return { price: p.base_price, member_price: null, weekend_price: null, tier_prices: {} };
  }
  return r;
}

/** Ride add-on price for the customer (tier price → member price → peak price → normal price). */
export async function rideAddonPrice(db: Db, ride: any, member: { tierId: string | null } | null, branchId: string) {
  const s = await parkSettings(branchId, db);
  if (!ride.addon_enabled || ride.addon_price == null) throw conflict('ADDON_NOT_SOLD', 'This ride cannot be purchased separately');
  let price = Number(ride.addon_price);
  const b = await branchInfo(branchId, db);
  const now = localNow(new Date(), b.timezone);
  const peak = s.ride.peakHours.some((w) => (!w.days?.length || w.days.includes(now.dow)) && now.time >= w.start && now.time < w.end);
  if (peak && ride.peak_price != null) price = Number(ride.peak_price);
  if (member) {
    const tier = member.tierId && ride.tier_prices?.[member.tierId] != null ? Number(ride.tier_prices[member.tierId]) : null;
    const mp = tier ?? (ride.member_price != null ? Number(ride.member_price) : null);
    if (mp != null && mp < price) return { price: mp, memberPriced: true, peak };
  }
  return { price, memberPriced: false, peak };
}
