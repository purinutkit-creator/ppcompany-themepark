/** Minimal, printer-agnostic ESC/POS command builder. */
export class EscPos {
  private chunks: number[] = [];

  raw(bytes: ArrayLike<number>): this {
    for (let i = 0; i < bytes.length; i++) this.chunks.push(bytes[i] & 0xff);
    return this;
  }
  init(): this {
    return this.raw([0x1b, 0x40]);
  }
  codepage(n: number): this {
    return this.raw([0x1b, 0x74, n]);
  }
  align(a: 'left' | 'center' | 'right'): this {
    return this.raw([0x1b, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2]);
  }
  bold(on: boolean): this {
    return this.raw([0x1b, 0x45, on ? 1 : 0]);
  }
  invert(on: boolean): this {
    return this.raw([0x1d, 0x42, on ? 1 : 0]);
  }
  /** Character size multiplier 1..8 for width and height. */
  size(w: number, h: number): this {
    const n = ((Math.max(1, Math.min(8, w)) - 1) << 4) | (Math.max(1, Math.min(8, h)) - 1);
    return this.raw([0x1d, 0x21, n]);
  }
  /** ASCII text only; anything else is replaced. Non-latin text must be rasterised. */
  text(s: string): this {
    const out: number[] = [];
    for (const ch of s) {
      const c = ch.charCodeAt(0);
      out.push(c >= 0x20 && c < 0x7f ? c : c === 0x0a ? 0x0a : 0x3f);
    }
    return this.raw(out);
  }
  line(s = ''): this {
    return this.text(s).raw([0x0a]);
  }
  feed(n = 1): this {
    return this.raw([0x1b, 0x64, Math.max(0, Math.min(255, n))]);
  }
  qr(data: string, moduleSize = 6): this {
    const bytes = new TextEncoder().encode(data);
    const len = bytes.length + 3;
    this.raw([0x1d, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0x00]); // model 2
    this.raw([0x1d, 0x28, 0x6b, 3, 0, 0x31, 0x43, Math.max(1, Math.min(16, moduleSize))]);
    this.raw([0x1d, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31]); // EC level M
    this.raw([0x1d, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30]).raw(bytes);
    return this.raw([0x1d, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30]);
  }
  /** CODE128 barcode (function B, code set B) with human-readable text below. */
  barcode128(data: string, height = 80, moduleWidth = 2, hri = true): this {
    const bytes = new TextEncoder().encode('{B' + data);
    this.raw([0x1d, 0x68, Math.max(1, Math.min(255, height))]);
    this.raw([0x1d, 0x77, Math.max(1, Math.min(6, moduleWidth))]);
    this.raw([0x1d, 0x48, hri ? 2 : 0]);
    return this.raw([0x1d, 0x6b, 73, bytes.length]).raw(bytes);
  }
  /**
   * Raster bit image (GS v 0). `bits` is row-major 1-bit packed data, `widthBytes` per row.
   * Sent in bands so printers with small buffers do not overflow.
   */
  raster(bits: Uint8Array, widthBytes: number, height: number, band = 128): this {
    for (let y = 0; y < height; y += band) {
      const h = Math.min(band, height - y);
      this.raw([0x1d, 0x76, 0x30, 0x00, widthBytes & 0xff, (widthBytes >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff]);
      this.raw(bits.subarray(y * widthBytes, (y + h) * widthBytes));
    }
    return this;
  }
  cut(partial = true): this {
    return this.raw([0x1d, 0x56, partial ? 0x42 : 0x41, 0x00]);
  }
  openDrawer(): this {
    return this.raw([0x1b, 0x70, 0x00, 0x19, 0xfa]);
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}
