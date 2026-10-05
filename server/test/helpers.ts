import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ensureDb } from './setup';

export interface Ctx {
  app: FastifyInstance;
  kioskToken: string;
  kioskId: string;
  agentToken: string;
  branchId: string;
  tokens: Record<string, string>;
  products: Record<string, any>;
  events: { rooms: string[]; event: string; data: any }[];
}

export async function bootstrap(): Promise<Ctx> {
  await ensureDb();
  const { migrate } = await import('../src/db/migrate');
  const { query } = await import('../src/db/pool');
  const { seedBase, seedDemo } = await import('../src/db/seed');
  const { buildApp } = await import('../src/app');
  const { bus } = await import('../src/lib/realtime');
  const { invalidateSettings } = await import('../src/lib/settings');
  await migrate(() => {});
  await query(`DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations' LOOP
      EXECUTE format('TRUNCATE TABLE %I CASCADE', r.tablename);
    END LOOP; END $$;`);
  invalidateSettings();
  await seedBase();
  const out: any = await seedDemo({ adminPassword: 'admin1234' });
  const app = await buildApp({ logger: false });
  await app.ready();
  const events: Ctx['events'] = [];
  bus.on('event', (m) => events.push(m));
  const tokens: Record<string, string> = {};
  for (const [k, body] of Object.entries({
    admin: { username: 'admin', password: 'admin1234' },
    cashier: { employeeCode: 'CSH001', pin: '1111' },
    kitchen: { employeeCode: 'KIT001', pin: '3333' },
    manager: { employeeCode: 'MGR001', pin: '2222' },
  })) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: body });
    tokens[k] = r.json().token;
  }
  const kioskToken = out.kioskTokens['KIOSK-01'];
  const menu = (await app.inject({ method: 'GET', url: '/api/kiosk/menu', headers: { 'x-kiosk-token': kioskToken } })).json();
  const products = Object.fromEntries(menu.products.map((p: any) => [p.sku, p]));
  return { app, kioskToken, kioskId: kioskToken.split('.')[0], agentToken: out.printAgentToken, branchId: out.branchId, tokens, products, events };
}

export const uuid = () => crypto.randomUUID();

export function kiosk(ctx: Ctx, method: 'GET' | 'POST', url: string, payload?: unknown) {
  return ctx.app.inject({ method, url: `/api/kiosk${url}`, headers: { 'x-kiosk-token': ctx.kioskToken }, payload: payload as any });
}

export function staff(
  ctx: Ctx,
  who: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  return ctx.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${ctx.tokens[who]}`, 'x-branch-id': ctx.branchId, ...headers },
    payload: payload as any,
  });
}

/** Default modifier selection satisfying required groups. */
export function defaults(p: any): string[] {
  const out: string[] = [];
  for (const g of p.modifier_groups) {
    const d = g.modifiers.filter((m: any) => m.is_default);
    if (g.selection === 'SINGLE') {
      const pick = d[0] ?? (g.required ? g.modifiers[0] : null);
      if (pick) out.push(pick.id);
    } else out.push(...d.map((m: any) => m.id));
  }
  return out;
}

export async function createOrder(ctx: Ctx, items: { sku: string; qty?: number; modifierIds?: string[] }[], extra: Record<string, unknown> = {}) {
  return kiosk(ctx, 'POST', '/orders', {
    clientOrderId: uuid(),
    orderType: 'DINE_IN',
    language: 'th',
    items: items.map((i) => ({ productId: ctx.products[i.sku].id, qty: i.qty ?? 1, modifierIds: i.modifierIds ?? defaults(ctx.products[i.sku]) })),
    ...extra,
  });
}
