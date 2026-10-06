import { EVENTS, localNow, rooms } from '@kiosk/shared';
import { one, query, type Db, type Tx } from '../../db/pool';
import { badRequest, conflict, notFound } from '../../lib/errors';
import type { Outbox } from '../../lib/realtime';
import { branchToday, genWalletTxnNo, round2 } from './common';

export type WalletTxnType = 'TOPUP' | 'PAYMENT' | 'REFUND' | 'ADJUSTMENT' | 'TRANSFER_IN' | 'TRANSFER_OUT' | 'BONUS' | 'REVERSAL' | 'CASHOUT' | 'EXPIRE';

export interface WalletPostInput {
  accountId: string;
  type: WalletTxnType;
  /** Positive = credit, negative = debit. */
  amount: number;
  /** Credit counts as non-refundable promotional balance (package wallet credit, comps). */
  bonus?: boolean;
  branchId?: string | null;
  credentialId?: string | null;
  memberId?: string | null;
  reference?: string | null;
  refType?: string | null;
  refId?: string | null;
  storeId?: string | null;
  deviceId?: string | null;
  staffId?: string | null;
  idempotencyKey?: string | null;
  note?: string | null;
  maxBalance?: number | null;
}

/**
 * The ONLY way balances change. Locks the wallet row, writes a ledger entry with balance before/after
 * (CHECK constraint), then updates the cached balance — all inside the caller's transaction. Replaying the
 * same idempotency key returns the original entry instead of charging twice (e.g. a double tap at the POS).
 */
export async function walletPost(c: Tx, i: WalletPostInput) {
  if (!Number.isFinite(i.amount) || i.amount === 0) throw badRequest('INVALID_AMOUNT');
  const amount = round2(i.amount);
  if (i.idempotencyKey) {
    const dup = await one<any>(`SELECT * FROM wallet_ledger WHERE idempotency_key=$1`, [i.idempotencyKey], c);
    if (dup) {
      if (dup.account_id !== i.accountId || Math.abs(Number(dup.credit) - Number(dup.debit) - amount) > 0.001) {
        throw conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key reused for a different wallet transaction');
      }
      return { entry: dup, replay: true };
    }
  }
  const w = await one<any>(`SELECT * FROM wallet_accounts WHERE account_id=$1 FOR UPDATE`, [i.accountId], c);
  if (!w) throw notFound('Wallet');
  if (w.status !== 'ACTIVE' && amount < 0 && i.type !== 'REVERSAL') throw conflict('WALLET_FROZEN', 'Wallet is not active');
  if (w.status === 'CLOSED') throw conflict('WALLET_CLOSED');
  const before = Number(w.balance);
  const bonusBefore = Number(w.bonus_balance);
  const after = round2(before + amount);
  if (after < 0) throw conflict('INSUFFICIENT_BALANCE', `Balance ${before.toFixed(2)} is less than ${(-amount).toFixed(2)}`, { balance: before, required: -amount });
  if (amount > 0 && i.maxBalance != null && after > i.maxBalance) throw conflict('WALLET_LIMIT', `Wallet balance would exceed ${i.maxBalance}`);
  // Debits spend promotional credit first; refundable cash credit stays as long as possible.
  const bonusAfter = amount < 0 ? Math.max(0, round2(bonusBefore + amount)) : i.bonus ? round2(bonusBefore + amount) : bonusBefore;
  const day = i.branchId ? await branchToday(i.branchId, c) : localNow(new Date(), 'Asia/Bangkok').date;
  const entry = await one<any>(
    `INSERT INTO wallet_ledger (txn_no, wallet_id, account_id, credential_id, member_id, branch_id, type, debit, credit, balance_before, balance_after,
        bonus_before, bonus_after, reference, ref_type, ref_id, store_id, device_id, staff_id, idempotency_key, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
    [await genWalletTxnNo(c, day), w.id, i.accountId, i.credentialId ?? null, i.memberId ?? null, i.branchId ?? null, i.type,
     amount < 0 ? -amount : 0, amount > 0 ? amount : 0, before, after, bonusBefore, Math.min(bonusAfter, after), i.reference ?? null, i.refType ?? null,
     i.refId ?? null, i.storeId ?? null, i.deviceId ?? null, i.staffId ?? null, i.idempotencyKey ?? null, i.note ?? null],
    c,
  );
  await query(`UPDATE wallet_accounts SET balance=$2, bonus_balance=$3, version=version+1 WHERE id=$1`, [w.id, after, Math.min(bonusAfter, after)], c);
  return { entry, replay: false };
}

export async function walletOf(db: Db, accountId: string) {
  return one<any>(`SELECT * FROM wallet_accounts WHERE account_id=$1`, [accountId], db);
}

/** Broadcast the new balance to every screen watching this account (POS, portal, kiosk, ride scanner, card profile). */
export async function announceWallet(out: Outbox, db: Db, accountId: string, branchId: string | null, extra: Record<string, unknown> = {}) {
  const w = await walletOf(db, accountId);
  if (!w) return;
  const data = { accountId, balance: Number(w.balance), bonusBalance: Number(w.bonus_balance), status: w.status, ...extra };
  const targets = [rooms.account(accountId)];
  if (branchId) targets.push(rooms.branchAdmin(branchId), rooms.branchCounter(branchId));
  out.add(targets, EVENTS.WALLET_UPDATED, data);
}

/** Refundable part of a balance (promotional credit is never paid out). */
export function refundableBalance(w: { balance: number | string; bonus_balance: number | string }) {
  return Math.max(0, round2(Number(w.balance) - Number(w.bonus_balance)));
}
