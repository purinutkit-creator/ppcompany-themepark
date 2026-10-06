import type { FastifyRequest } from 'fastify';
import type { ParkActor } from '../../services/park/common';
import { z } from '../../lib/validate';

export const staffActor = (req: FastifyRequest): ParkActor => ({ type: 'STAFF', id: req.staff!.id, name: req.staff!.name });
export const anyActor = (req: FastifyRequest): ParkActor =>
  req.staff
    ? { type: 'STAFF', id: req.staff.id, name: req.staff.name }
    : req.device
      ? { type: 'DEVICE', id: req.device.id, name: req.device.code }
      : req.kiosk
        ? { type: 'KIOSK', id: req.kiosk.id, name: req.kiosk.code }
        : req.member
          ? { type: 'MEMBER', id: req.member.id, name: req.member.name }
          : { type: 'GUEST' };

export const idemKey = (req: FastifyRequest) => (req.headers['idempotency-key'] as string | undefined)?.slice(0, 200) || null;
export const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const lang = z.enum(['th', 'en', 'zh']);
export const scanBody = z.object({ code: z.string().min(1).max(300), source: z.enum(['CAMERA', 'USB', 'RFID', 'MANUAL', 'API']).default('CAMERA') });
export const deviceIdOf = (req: FastifyRequest) => req.device?.id ?? req.kiosk?.id ?? ((req.headers['x-device-id'] as string) || null);

/** Park payment methods accepted from customer channels. */
export const customerMethod = z.enum(['PROMPTPAY', 'CARD', 'MOBILE_BANKING', 'BANK_TRANSFER', 'EWALLET', 'WALLET', 'POINTS']);
export const staffMethod = z.enum(['CASH', 'PROMPTPAY', 'CARD', 'EWALLET', 'BANK_TRANSFER', 'MOBILE_BANKING', 'WALLET', 'POINTS', 'VOUCHER', 'COMP']);

export const saleLine = z.object({
  type: z.enum(['PACKAGE', 'MEMBERSHIP', 'MEMBERSHIP_RENEWAL', 'MEMBERSHIP_UPGRADE', 'TOPUP', 'PRODUCT', 'LOCKER', 'RIDE_ADDON', 'SERVICE']),
  refId: z.string().uuid().nullish(),
  ticketTypeId: z.string().uuid().nullish(),
  qty: z.number().int().min(1).max(100).default(1),
  amount: z.coerce.number().min(0).max(1_000_000).nullish(),
  meta: z
    .object({
      visitDate: ymd.optional(),
      guestNames: z.array(z.string().max(80)).max(100).optional(),
      lockerId: z.string().uuid().optional(),
      credentialId: z.string().uuid().optional(),
      size: z.enum(['S', 'M', 'L', 'XL']).optional(),
      note: z.string().max(200).optional(),
    })
    .passthrough()
    .default({}),
});
