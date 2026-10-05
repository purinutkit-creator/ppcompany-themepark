import { z } from 'zod';
import { badRequest } from './errors';

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest('VALIDATION_ERROR', 'Invalid request', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

export const uuid = z.string().uuid();
export const i18n = z.object({ th: z.string().max(500).optional(), en: z.string().max(500).optional(), zh: z.string().max(500).optional() }).partial();
export const money = z.coerce.number().min(0).max(10_000_000);
export const managerApproval = { managerCode: z.string().max(50).optional(), managerPin: z.string().max(20).optional() };
export const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
export const pagination = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50), offset: z.coerce.number().int().min(0).default(0) });
export { z };
