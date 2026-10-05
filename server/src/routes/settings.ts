import type { FastifyInstance } from 'fastify';
import { EVENTS, rooms } from '@kiosk/shared';
import { one, query } from '../db/pool';
import { audit } from '../lib/audit';
import { requireAnyStaff, requireStaff } from '../lib/auth';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { publish } from '../lib/realtime';
import { DEFAULT_SETTINGS, getSettings, saveSetting, SETTINGS_KEYS, type SettingsKey } from '../lib/settings';
import { saveUpload, type UploadKind } from '../lib/uploads';
import { parse, uuid, z } from '../lib/validate';
import type { Permission } from '../lib/permissions';

const KEY_PERMISSION: Partial<Record<SettingsKey, Permission>> = { theme: 'theme.manage', fonts: 'fonts.manage', queue: 'queue.manage' };

const fontSpec = z.object({ family: z.string().min(1).max(80), weight: z.coerce.number().int().min(100).max(900), size: z.coerce.number().min(8).max(200), letterSpacing: z.coerce.number().min(-5).max(20), lineHeight: z.coerce.number().min(0.8).max(3) });
/** Strict validation for keys where bad values would break money math or devices. */
const VALIDATORS: Partial<Record<SettingsKey, z.ZodTypeAny>> = {
  tax: z.object({ vatRate: z.coerce.number().min(0).max(30), vatMode: z.enum(['INCLUDED', 'EXCLUDED']), serviceChargeRate: z.coerce.number().min(0).max(30), serviceChargeOrderTypes: z.array(z.enum(['DINE_IN', 'TAKE_AWAY'])) }),
  kiosk: z.object({ idleTimeoutSec: z.coerce.number().int().min(10).max(3600), idleWarningSec: z.coerce.number().int().min(0).max(60), resetAfterOrderSec: z.coerce.number().int().min(3).max(120) }).passthrough(),
  receipt: z.object({ copies: z.coerce.number().int().min(0).max(10), language: z.enum(['ORDER', 'th', 'en', 'zh']) }).passthrough(),
  kitchen: z.object({ copies: z.coerce.number().int().min(0).max(10), ticketLanguage: z.enum(['th', 'en', 'zh']) }).passthrough(),
  queue: z.object({ preparingCount: z.coerce.number().int().min(1).max(50), readyCount: z.coerce.number().int().min(1).max(50), repeat: z.coerce.number().int().min(1).max(3) }).passthrough(),
  payment: z.object({ qr: z.object({ mode: z.enum(['PROMPTPAY_STATIC', 'PROMPTPAY_DYNAMIC', 'GATEWAY']), countdownSec: z.coerce.number().int().min(30).max(1800), promptpayId: z.string().max(20) }).passthrough() }).passthrough(),
  fonts: z.record(z.string(), fontSpec),
  order: z.object({ expiryMinutes: z.coerce.number().int().min(1).max(240) }).passthrough(),
};

async function broadcastSettings(key: string) {
  const branches = await query<{ id: string }>(`SELECT id FROM branches`);
  const targets = [rooms.global, ...branches.flatMap((b) => [rooms.branchKiosks(b.id), rooms.branchAdmin(b.id), rooms.branchCashier(b.id), rooms.branchKitchen(b.id), rooms.branchQueue(b.id), rooms.branchPrinters(b.id)])];
  await publish(targets, EVENTS.SETTINGS_UPDATED, { key });
}

export default async function settingsRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: requireStaff() }, async () => ({ settings: await getSettings(), defaults: DEFAULT_SETTINGS }));

  /** What every staff UI needs to render itself (theme, fonts, store, queue). */
  app.get('/client', { preHandler: requireAnyStaff() }, async () => {
    const s = await getSettings();
    return {
      settings: { store: s.store, theme: s.theme, fonts: s.fonts, queue: s.queue, tax: s.tax, payment: { cash: s.payment.cash, methods: s.payment.methods, card: { provider: s.payment.card.provider }, qr: { mode: s.payment.qr.mode, gatewayProvider: s.payment.qr.gatewayProvider } }, security: { managerPinActions: s.security.managerPinActions }, kitchen: s.kitchen },
      fonts: await query(`SELECT id, family, source, file_url, format, weights FROM fonts ORDER BY family`),
      languages: await query(`SELECT * FROM languages ORDER BY sort`),
    };
  });

  app.put('/:key', { preHandler: requireStaff() }, async (req) => {
    const { key } = parse(z.object({ key: z.enum(SETTINGS_KEYS as [SettingsKey, ...SettingsKey[]]) }), req.params);
    const perm = KEY_PERMISSION[key] ?? 'settings.manage';
    if (!req.staff!.permissions.has(perm) && !req.staff!.permissions.has('settings.manage')) throw forbidden('PERMISSION_DENIED', `Missing permission: ${perm}`);
    const value = req.body as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('INVALID_VALUE');
    const v = VALIDATORS[key];
    if (v) {
      const merged = { ...(await getSettings())[key], ...value };
      parse(v, merged);
    }
    const old = await saveSetting(key, value, req.staff!.id);
    await audit(req, { action: 'SETTING_CHANGE', entity: 'settings', entityId: key, oldValue: old, newValue: value });
    await broadcastSettings(key);
    return { ok: true, settings: await getSettings() };
  });

  // ---------------- uploads
  app.post('/uploads', { preHandler: requireStaff() }, async (req) => {
    const q = parse(z.object({ kind: z.enum(['image', 'video', 'font']).default('image') }), req.query);
    const file = await req.file();
    if (!file) throw badRequest('FILE_REQUIRED');
    const saved = await saveUpload(file, [q.kind as UploadKind]);
    await audit(req, { action: 'FILE_UPLOAD', entity: 'upload', entityId: saved.url, newValue: { filename: saved.filename, size: saved.size } });
    return saved;
  });

  // ---------------- fonts
  app.get('/fonts', { preHandler: requireStaff() }, async () => query(`SELECT * FROM fonts ORDER BY family`));
  app.post('/fonts/google', { preHandler: requireStaff('fonts.manage') }, async (req) => {
    const b = parse(z.object({ family: z.string().min(1).max(80).regex(/^[A-Za-z0-9 ]+$/), weights: z.array(z.number().int().min(100).max(900)).default([400, 700]), scripts: z.array(z.string().max(20)).default(['latin']) }), req.body);
    const row = await one(
      `INSERT INTO fonts (family, source, weights, scripts, created_by) VALUES ($1,'GOOGLE',$2,$3,$4)
       ON CONFLICT (family, source) DO UPDATE SET weights=EXCLUDED.weights, scripts=EXCLUDED.scripts RETURNING *`,
      [b.family, b.weights, b.scripts, req.staff!.id],
    );
    await audit(req, { action: 'FONT_ADD', entity: 'font', entityId: b.family, newValue: b });
    return row;
  });
  app.post('/fonts/upload', { preHandler: requireStaff('fonts.manage') }, async (req) => {
    const file = await req.file();
    if (!file) throw badRequest('FILE_REQUIRED');
    const fields = file.fields as any;
    const family = String(fields.family?.value ?? '').trim() || file.filename.replace(/\.[^.]+$/, '');
    if (!/^[\p{L}\p{N} _-]{1,80}$/u.test(family)) throw badRequest('INVALID_FAMILY');
    const weight = Number(fields.weight?.value ?? 400) || 400;
    const saved = await saveUpload(file, ['font']);
    const row = await one(
      `INSERT INTO fonts (family, source, file_url, format, weights, scripts, created_by) VALUES ($1,'UPLOAD',$2,$3,$4,$5,$6)
       ON CONFLICT (family, source) DO UPDATE SET file_url=EXCLUDED.file_url, format=EXCLUDED.format, weights=EXCLUDED.weights RETURNING *`,
      [family, saved.url, saved.ext, [weight], ['latin', 'thai', 'chinese'], req.staff!.id],
    );
    await audit(req, { action: 'FONT_UPLOAD', entity: 'font', entityId: family, newValue: saved });
    return row;
  });
  app.delete('/fonts/:id', { preHandler: requireStaff('fonts.manage') }, async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const old = await one(`DELETE FROM fonts WHERE id=$1 RETURNING *`, [id]);
    if (!old) throw notFound('Font');
    await audit(req, { action: 'FONT_DELETE', entity: 'font', entityId: id, oldValue: old });
    return { ok: true };
  });

  // ---------------- languages
  app.get('/languages', { preHandler: requireStaff() }, async () => query(`SELECT * FROM languages ORDER BY sort`));
  app.put('/languages/:code', { preHandler: requireStaff('languages.manage') }, async (req) => {
    const { code } = parse(z.object({ code: z.enum(['th', 'en', 'zh']) }), req.params);
    const b = parse(
      z.object({ enabled: z.boolean(), is_default: z.boolean(), sort: z.number().int(), name: z.string().max(40), native_name: z.string().max(40), flag: z.string().max(10).nullish(), overrides: z.record(z.string().max(80), z.string().max(500)).default({}) }),
      req.body,
    );
    const old = await one<any>(`SELECT * FROM languages WHERE code=$1`, [code]);
    if (!old) throw notFound('Language');
    if (old.is_default && !b.enabled) throw badRequest('DEFAULT_LANGUAGE_REQUIRED', 'The default language cannot be disabled');
    if (b.is_default) await query(`UPDATE languages SET is_default=false WHERE code<>$1`, [code]);
    await query(`UPDATE languages SET enabled=$2, is_default=$3, sort=$4, name=$5, native_name=$6, flag=$7, overrides=$8 WHERE code=$1`, [
      code, b.enabled || b.is_default, b.is_default, b.sort, b.name, b.native_name, b.flag ?? null, b.overrides,
    ]);
    await audit(req, { action: 'LANGUAGE_UPDATE', entity: 'language', entityId: code, oldValue: old, newValue: b });
    await broadcastSettings('languages');
    return { ok: true };
  });

  // ---------------- audit log
  app.get('/audit', { preHandler: requireStaff('audit.view') }, async (req) => {
    const q = parse(
      z.object({ action: z.string().max(60).optional(), userId: uuid.optional(), orderId: uuid.optional(), from: z.string().optional(), to: z.string().optional(), q: z.string().max(60).optional(), limit: z.coerce.number().int().max(1000).default(200), offset: z.coerce.number().int().min(0).default(0) }),
      req.query,
    );
    return query(
      `SELECT a.*, ap.name AS approved_by_name, o.order_number FROM audit_logs a LEFT JOIN users ap ON ap.id=a.approved_by LEFT JOIN orders o ON o.id=a.order_id
        WHERE ($1::text IS NULL OR a.action=$1) AND ($2::uuid IS NULL OR a.user_id=$2) AND ($3::uuid IS NULL OR a.order_id=$3)
          AND ($4::timestamptz IS NULL OR a.created_at >= $4) AND ($5::timestamptz IS NULL OR a.created_at < $5)
          AND ($6::text IS NULL OR a.user_name ILIKE '%'||$6||'%' OR a.entity_id ILIKE '%'||$6||'%' OR o.order_number = $6)
          AND ($7::uuid IS NULL OR a.branch_id = $7 OR a.branch_id IS NULL)
        ORDER BY a.created_at DESC LIMIT $8 OFFSET $9`,
      [q.action ?? null, q.userId ?? null, q.orderId ?? null, q.from ?? null, q.to ?? null, q.q ?? null, req.staff!.branchId, q.limit, q.offset],
    );
  });
  app.get('/audit/actions', { preHandler: requireStaff('audit.view') }, async () => (await query<{ action: string }>(`SELECT DISTINCT action FROM audit_logs ORDER BY action`)).map((r) => r.action));
}
