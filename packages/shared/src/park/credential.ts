/**
 * Credential scan payloads. The QR / barcode never carries balances or personal data — only the credential
 * code plus an HMAC signature (computed server-side with a secret), so codes cannot be guessed or forged:
 *
 *   static  (printed cards, wristbands, paper tickets, booking barcodes):  TP:<CODE>.<SIG>   (barcode: <CODE>.<SIG>)
 *   dynamic (member app / digital card; screenshots expire):              TPD:<CODE>.<EXP>.<SIG>
 *   RFID / NFC wristbands (future):                                        RFID:<UID>
 *
 * Rotating a credential (token_version + 1) changes the signature, which revokes every old printout at once.
 */
export interface ParsedCredential {
  kind: 'STATIC' | 'DYNAMIC' | 'RFID' | 'UNKNOWN';
  code: string | null;
  sig: string | null;
  exp: number | null;
  raw: string;
}

const CODE_RE = /^[A-Z]{1,6}-[A-Z0-9-]{3,40}$/;

export function parseCredentialPayload(input: string): ParsedCredential {
  const raw = String(input ?? '').trim().replace(/[\r\n\t]/g, '');
  const unknown: ParsedCredential = { kind: 'UNKNOWN', code: null, sig: null, exp: null, raw };
  if (!raw || raw.length > 300) return unknown;
  let s = raw;
  // URLs printed in QR codes (e.g. https://park/t/TP:...) — use the last path segment.
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      s = decodeURIComponent(u.searchParams.get('c') ?? u.pathname.split('/').filter(Boolean).pop() ?? '');
    } catch {
      return unknown;
    }
  }
  if (/^RFID:/i.test(s)) {
    const uid = s.slice(5).trim().toUpperCase();
    return /^[0-9A-F]{4,32}$/.test(uid) ? { kind: 'RFID', code: null, sig: null, exp: null, raw: uid } : unknown;
  }
  if (/^TPD:/i.test(s)) {
    const parts = s.slice(4).split('.');
    if (parts.length !== 3) return unknown;
    const code = parts[0].toUpperCase();
    const exp = Number(parts[1]);
    if (!CODE_RE.test(code) || !Number.isFinite(exp)) return unknown;
    return { kind: 'DYNAMIC', code, exp, sig: parts[2].toUpperCase(), raw };
  }
  if (/^TP:/i.test(s)) s = s.slice(3);
  const dot = s.lastIndexOf('.');
  if (dot < 1) return unknown;
  const code = s.slice(0, dot).toUpperCase();
  const sig = s.slice(dot + 1).toUpperCase();
  if (!CODE_RE.test(code) || !/^[A-Z2-7]{6,16}$/.test(sig)) return unknown;
  return { kind: 'STATIC', code, sig, exp: null, raw };
}

export const staticPayload = (code: string, sig: string) => `TP:${code}.${sig}`;
export const barcodePayload = (code: string, sig: string) => `${code}.${sig}`;
export const dynamicPayload = (code: string, exp: number, sig: string) => `TPD:${code}.${exp}.${sig}`;
