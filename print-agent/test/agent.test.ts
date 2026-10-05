import net from 'node:net';
import { describe, expect, it } from 'vitest';
import type { PrintJobPayload } from '@kiosk/shared';
import { TcpTransport, transportFor, type AgentPrinter } from '../src/transports';
import { renderJob } from '../src/render';

const printer: AgentPrinter = {
  id: 'p1', name: 'Test', type: 'KITCHEN', connection: 'LAN', host: '127.0.0.1', port: 0, device_path: null, paper_width: 80,
  dots_per_line: null, chars_per_line: null, raster_mode: 'AUTO', open_drawer: false, is_enabled: true, status: 'UNKNOWN',
};
const payload: PrintJobPayload = {
  documentType: 'KITCHEN_TICKET', language: 'th', copyNo: 1, isReprint: false, store: { name: { th: 'ร้าน' }, currencySymbol: '฿' },
  stationName: { th: 'ครัวร้อน' },
  order: {
    orderId: 'x', orderNumber: '48271', orderType: 'DINE_IN', createdAt: new Date().toISOString(), language: 'th', timeZone: 'Asia/Bangkok',
    items: [{ name: { th: 'ชีสเบอร์เกอร์' }, qty: 2, unitPrice: 129, total: 258, modifiers: [{ name: { th: 'หัวหอม' }, kind: 'REMOVE', priceDelta: 0 }] }],
    subtotal: 258, discount: 0, serviceCharge: 0, vat: 16.88, total: 258,
  },
};

describe('print agent', () => {
  it('renders Thai tickets as ESC/POS raster', async () => {
    const bytes = await renderJob(payload, printer, 'http://localhost');
    expect([...bytes.slice(0, 2)]).toEqual([0x1b, 0x40]);
    const s = Buffer.from(bytes).toString('latin1');
    expect(s.includes('\x1dv0')).toBe(true); // GS v 0 raster
    expect(s.includes('\x1dV')).toBe(true); // cut
  });

  it('sends bytes over raw TCP (port 9100 style)', async () => {
    const got: Buffer[] = [];
    const server = net.createServer((s) => s.on('data', (d) => got.push(d)));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    await new TcpTransport('127.0.0.1', port).send(new Uint8Array([1, 2, 3]));
    await new Promise((r) => setTimeout(r, 50));
    expect(Buffer.concat(got)).toEqual(Buffer.from([1, 2, 3]));
    server.close();
  });

  it('fails fast when the printer is offline', async () => {
    await expect(new TcpTransport('127.0.0.1', 1, 1000).send(new Uint8Array([1]))).rejects.toThrow(/ECONNREFUSED/);
  });

  it('requires a device path for USB / Bluetooth', () => {
    expect(() => transportFor({ ...printer, connection: 'USB', device_path: null })).toThrow(/device path/);
  });
});
