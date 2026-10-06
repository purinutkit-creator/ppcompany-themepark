import { one, query, type Db, type Tx } from '../../db/pool';

/** End of a local date in the branch time zone, as timestamptz (SQL does the zone math). */
const END_OF_DAY = `(($1::date + 1)::timestamp AT TIME ZONE $2)`;
const START_OF_DAY = `(($1::date)::timestamp AT TIME ZONE $2)`;

export async function dayBounds(db: Db, from: string, to: string, tz: string): Promise<{ start: string; end: string }> {
  const a = await one<any>(`SELECT ${START_OF_DAY} AS s`, [from, tz], db);
  const b = await one<any>(`SELECT ${END_OF_DAY} AS e`, [to, tz], db);
  return { start: a.s, end: b.e };
}

/** Materialise ride rights of an admission ticket from its package (ALL RIDES or SELECTED RIDES). */
export async function createTicketEntitlements(c: Tx, ticket: any, pkg: any, tz: string) {
  const { start, end } = await dayBounds(c, String(ticket.valid_from).slice(0, 10), String(ticket.valid_to).slice(0, 10), tz);
  const exists = await one(`SELECT 1 FROM ride_entitlements WHERE ticket_id=$1 AND source='PACKAGE' LIMIT 1`, [ticket.id], c);
  if (exists) return;
  if (pkg.all_rides) {
    const counted = pkg.all_rides_type === 'ONE_TIME' || pkg.all_rides_type === 'MULTI_USE';
    const uses = counted ? (pkg.all_rides_type === 'ONE_TIME' ? 1 : pkg.all_rides_uses ?? 1) : null;
    await query(
      `INSERT INTO ride_entitlements (account_id, ticket_id, member_id, branch_id, ride_id, type, uses_total, uses_left, valid_from, valid_until, source, sale_id, sale_item_id)
       VALUES ($1,$2,$3,$4,NULL,$5,$6,$6,$7,$8,'PACKAGE',$9,$10)`,
      [ticket.account_id, ticket.id, ticket.member_id, ticket.branch_id, pkg.all_rides_type, uses, start, end, ticket.sale_id, ticket.sale_item_id],
      c,
    );
  }
  const rides = await query<any>(`SELECT * FROM package_rides WHERE package_id=$1`, [pkg.id], c);
  for (const r of rides) {
    const counted = r.entitlement_type === 'ONE_TIME' || r.entitlement_type === 'MULTI_USE';
    const uses = counted ? (r.entitlement_type === 'ONE_TIME' ? 1 : r.uses ?? 1) : null;
    await query(
      `INSERT INTO ride_entitlements (account_id, ticket_id, member_id, branch_id, ride_id, type, uses_total, uses_left, valid_from, valid_until, source, sale_id, sale_item_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,'PACKAGE',$10,$11)`,
      [ticket.account_id, ticket.id, ticket.member_id, ticket.branch_id, r.ride_id, r.entitlement_type, uses, start, end, ticket.sale_id, ticket.sale_item_id],
      c,
    );
  }
}

/** Ride add-on bought at the scanner / counter / app: tied to the credential that bought it. */
export async function createAddonEntitlement(
  c: Tx,
  a: { ride: any; accountId: string | null; credentialId: string | null; memberId: string | null; branchId: string; saleId: string; saleItemId: string; qty: number; tz: string; source?: 'ADDON' | 'REWARD' | 'COMP' },
) {
  const r = a.ride;
  const type = r.addon_type as string;
  const counted = type === 'ONE_TIME' || type === 'MULTI_USE';
  const uses = counted ? (type === 'ONE_TIME' ? 1 : r.addon_uses ?? 1) * a.qty : null;
  let until: string | null = null;
  if (type === 'TIME_BASED' && r.addon_valid_minutes) {
    until = (await one<any>(`SELECT now() + ($1 || ' minutes')::interval AS u`, [String(r.addon_valid_minutes * a.qty)], c)).u;
  } else {
    const today = (await one<any>(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [a.tz], c)).d;
    until = (await dayBounds(c, today, today, a.tz)).end;
  }
  return one<any>(
    `INSERT INTO ride_entitlements (account_id, credential_id, member_id, branch_id, ride_id, type, uses_total, uses_left, valid_from, valid_until, source, sale_id, sale_item_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7,now(),$8,$9,$10,$11)
     ON CONFLICT (sale_item_id, ride_id) WHERE sale_item_id IS NOT NULL AND source = 'ADDON' DO NOTHING RETURNING *`,
    [a.accountId, a.credentialId, a.memberId, a.branchId, r.id, type, uses, until, a.source ?? 'ADDON', a.saleId, a.saleItemId],
    c,
  );
}

/** Package benefits (fast pass, wallet credit, food voucher…) granted per guest at fulfilment. */
export async function packageBenefits(db: Db, packageId: string) {
  return query<any>(`SELECT * FROM package_benefits WHERE package_id=$1`, [packageId], db);
}
