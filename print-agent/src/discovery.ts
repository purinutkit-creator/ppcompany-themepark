import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';

export interface Found {
  name: string;
  connection: 'LAN' | 'USB' | 'BLUETOOTH';
  host?: string;
  port?: number;
  devicePath?: string;
}

function localSubnets(): string[] {
  const out = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.add(a.address.split('.').slice(0, 3).join('.'));
    }
  }
  return [...out];
}

function tryPort(host: string, port: number, timeout = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** Scan /24 subnets for raw-print port 9100 (JetDirect) in parallel batches. */
export async function scanNetwork(subnets?: string[]): Promise<Found[]> {
  const nets = subnets?.length ? subnets : localSubnets();
  const found: Found[] = [];
  for (const sn of nets.slice(0, 4)) {
    const hosts = Array.from({ length: 254 }, (_, i) => `${sn}.${i + 1}`);
    for (let i = 0; i < hosts.length; i += 64) {
      const batch = hosts.slice(i, i + 64);
      const res = await Promise.all(batch.map((h) => tryPort(h, 9100)));
      res.forEach((ok, k) => ok && found.push({ name: `Network printer ${batch[k]}`, connection: 'LAN', host: batch[k], port: 9100 }));
    }
  }
  return found;
}

/** Local device files that look like printers (USB line printers, serial, Bluetooth SPP). */
export function scanDevices(): Found[] {
  const out: Found[] = [];
  const tryDir = (dir: string, re: RegExp, connection: Found['connection'], label: string) => {
    try {
      for (const f of fs.readdirSync(dir)) if (re.test(f)) out.push({ name: `${label} ${f}`, connection, devicePath: `${dir}/${f}` });
    } catch {
      /* not present on this OS */
    }
  };
  tryDir('/dev/usb', /^lp\d+$/, 'USB', 'USB printer');
  tryDir('/dev', /^usb\/lp\d+$|^ttyUSB\d+$|^ttyACM\d+$/, 'USB', 'USB serial');
  tryDir('/dev', /^rfcomm\d+$/, 'BLUETOOTH', 'Bluetooth SPP');
  tryDir('/dev', /^cu\.(usbserial|Bluetooth|.*Printer).*/i, 'USB', 'Serial');
  if (process.platform === 'win32') for (let i = 1; i <= 9; i++) out.push({ name: `COM${i} (if present)`, connection: 'USB', devicePath: `\\\\.\\COM${i}` });
  return out;
}
