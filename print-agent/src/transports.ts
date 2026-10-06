import fs from 'node:fs';
import net from 'node:net';

/** Minimal printer record as returned by /api/print/executor/printers. */
export interface AgentPrinter {
  id: string;
  name: string;
  type: string;
  connection: 'USB' | 'BLUETOOTH' | 'BLE' | 'LAN' | 'ETHERNET' | 'WIFI';
  host: string | null;
  port: number | null;
  device_path: string | null;
  paper_width: 58 | 80;
  dots_per_line: number | null;
  chars_per_line: number | null;
  raster_mode: 'AUTO' | 'TEXT' | 'RASTER';
  driver?: 'ESCPOS' | 'ZPL' | null;
  open_drawer: boolean;
  is_enabled: boolean;
  status: string;
}

export interface Transport {
  send(data: Uint8Array): Promise<void>;
  probe(): Promise<void>;
}

/** Raw TCP (port 9100 / JetDirect) — LAN, Ethernet and Wi-Fi printers. */
export class TcpTransport implements Transport {
  constructor(private host: string, private port = 9100, private timeoutMs = 8000) {}
  private open(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.host, port: this.port });
      const t = setTimeout(() => {
        s.destroy();
        reject(new Error(`Timeout connecting to ${this.host}:${this.port}`));
      }, this.timeoutMs);
      s.once('connect', () => {
        clearTimeout(t);
        resolve(s);
      });
      s.once('error', (e) => {
        clearTimeout(t);
        reject(new Error(`${(e as NodeJS.ErrnoException).code ?? 'ERROR'} ${this.host}:${this.port}`));
      });
    });
  }
  async send(data: Uint8Array) {
    const s = await this.open();
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject);
      s.end(Buffer.from(data), () => resolve());
    });
    s.destroy();
  }
  async probe() {
    const s = await this.open();
    s.destroy();
  }
}

/**
 * Device-file transport: Linux /dev/usb/lp0, /dev/rfcomm0 (Bluetooth SPP), /dev/ttyUSB0,
 * macOS /dev/cu.*, Windows \\.\COM3 or a raw shared printer \\localhost\PrinterShare.
 */
export class DeviceFileTransport implements Transport {
  constructor(private path: string) {}
  async send(data: Uint8Array) {
    await new Promise<void>((resolve, reject) => {
      const ws = fs.createWriteStream(this.path, { flags: 'w' });
      ws.once('error', (e) => reject(new Error(`${(e as NodeJS.ErrnoException).code ?? 'ERROR'} ${this.path}`)));
      ws.end(Buffer.from(data), () => resolve());
    });
  }
  async probe() {
    await fs.promises.access(this.path, fs.constants.W_OK).catch(() => {
      throw new Error(`Device not available: ${this.path}`);
    });
  }
}

export function transportFor(p: AgentPrinter): Transport {
  if (['LAN', 'ETHERNET', 'WIFI'].includes(p.connection)) {
    if (!p.host) throw new Error('Printer has no host/IP configured');
    return new TcpTransport(p.host, p.port ?? 9100);
  }
  if (!p.device_path) throw new Error(`${p.connection} printer needs a device path (e.g. /dev/usb/lp0, /dev/rfcomm0, COM3)`);
  return new DeviceFileTransport(p.device_path);
}
