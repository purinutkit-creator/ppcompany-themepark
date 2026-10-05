/**
 * Thai PromptPay (EMVCo merchant-presented QR) payload generator.
 * Static QR omits the amount (customer types it); dynamic QR embeds the exact amount.
 */
const f = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;

export function crc16ccitt(input: string): string {
  let crc = 0xffff;
  const bytes = new TextEncoder().encode(input);
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function formatPromptPayTarget(id: string): { tag: string; value: string } {
  const digits = id.replace(/\D/g, '');
  if (digits.length >= 15) return { tag: '03', value: digits }; // e-Wallet ID
  if (digits.length >= 13) return { tag: '02', value: digits }; // National ID / Tax ID
  // Mobile number: 0066 + number without leading zero, padded to 13 digits.
  const phone = ('66' + digits.replace(/^0/, '')).padStart(13, '0');
  return { tag: '01', value: phone };
}

export function buildPromptPayPayload(promptpayId: string, amount?: number | null): string {
  const target = formatPromptPayTarget(promptpayId);
  const merchant = f('00', 'A000000677010111') + f(target.tag, target.value);
  let payload =
    f('00', '01') + f('01', amount ? '12' : '11') + f('29', merchant) + f('58', 'TH') + f('53', '764');
  if (amount) payload += f('54', amount.toFixed(2));
  payload += '6304';
  return payload + crc16ccitt(payload);
}
