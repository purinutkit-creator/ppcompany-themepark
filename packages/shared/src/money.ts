/** All monetary math is done in integer minor units (satang) to avoid float drift. */
export const toMinor = (n: number | string | null | undefined): number => Math.round(Number(n || 0) * 100);
export const fromMinor = (n: number): number => Math.round(n) / 100;
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export function formatMoney(n: number | string | null | undefined, symbol = '฿'): string {
  const v = Number(n || 0);
  return `${symbol}${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
