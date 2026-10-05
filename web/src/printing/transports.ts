/**
 * Printer transport adapters. Each one only moves raw ESC/POS bytes; rendering is shared
 * (packages/shared/print). New hardware = new transport, no changes elsewhere.
 */
export interface PrinterTransport {
  readonly kind: string;
  connect(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
}

export interface PrinterConfig {
  id: string;
  name: string;
  connection: string;
  executor: string;
  device_id: string | null;
  host: string | null;
  port: number | null;
  paper_width: 58 | 80;
  dots_per_line: number | null;
  chars_per_line: number | null;
  raster_mode: 'AUTO' | 'TEXT' | 'RASTER';
  open_drawer: boolean;
  auto_reconnect: boolean;
}

const chunk = async (data: Uint8Array, size: number, fn: (part: Uint8Array) => Promise<void>) => {
  for (let i = 0; i < data.length; i += size) await fn(data.subarray(i, i + size));
};

/* ---------------------------------------------------------------- WebUSB */
export class WebUsbTransport implements PrinterTransport {
  kind = 'WEBUSB';
  private device: USBDevice | null = null;
  private endpoint = 1;
  private iface = 0;
  constructor(private deviceKey: string) {}
  static key(d: USBDevice) {
    return `${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')}${d.serialNumber ? ':' + d.serialNumber : ''}`;
  }
  static async request(): Promise<USBDevice> {
    if (!('usb' in navigator)) throw new Error('WebUSB is not supported in this browser (use Chrome/Edge, or the Print Agent)');
    // Class 7 = printer. Many ESC/POS printers report vendor-specific class, so allow any device too.
    return navigator.usb.requestDevice({ filters: [] });
  }
  async connect() {
    if (this.device?.opened) return;
    const devices = await navigator.usb.getDevices();
    const d = devices.find((x) => WebUsbTransport.key(x) === this.deviceKey || WebUsbTransport.key(x).startsWith(this.deviceKey));
    if (!d) throw new Error('USB printer not paired with this browser — open Printers → Connect');
    await d.open();
    if (d.configuration === null) await d.selectConfiguration(1);
    for (const itf of d.configuration!.interfaces) {
      const alt = itf.alternates[0];
      const out = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
      if (out) {
        this.iface = itf.interfaceNumber;
        this.endpoint = out.endpointNumber;
        break;
      }
    }
    await d.claimInterface(this.iface);
    this.device = d;
  }
  async write(data: Uint8Array) {
    if (!this.device?.opened) await this.connect();
    await chunk(data, 16 * 1024, async (p) => {
      const r = await this.device!.transferOut(this.endpoint, p as BufferSource);
      if (r.status !== 'ok') throw new Error(`USB transfer ${r.status}`);
    });
  }
  async disconnect() {
    try {
      await this.device?.close();
    } finally {
      this.device = null;
    }
  }
  isConnected() {
    return !!this.device?.opened;
  }
}

/* ---------------------------------------------------------------- Web Bluetooth (BLE) */
// Service/characteristic UUIDs used by common BLE thermal printers.
const BLE_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb',
];
export class WebBluetoothTransport implements PrinterTransport {
  kind = 'BLE';
  private device: BluetoothDevice | null = null;
  private ch: BluetoothRemoteGATTCharacteristic | null = null;
  constructor(private deviceKey: string, device?: BluetoothDevice) {
    this.device = device ?? null;
  }
  static async request(): Promise<BluetoothDevice> {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth is not supported in this browser');
    return navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
  }
  async connect() {
    if (this.ch && this.device?.gatt?.connected) return;
    if (!this.device) {
      const getDevices = (navigator.bluetooth as any)?.getDevices;
      const list: BluetoothDevice[] = getDevices ? await getDevices.call(navigator.bluetooth) : [];
      this.device = list.find((d) => d.id === this.deviceKey) ?? null;
      if (!this.device) throw new Error('Bluetooth printer not paired with this browser — open Printers → Connect');
    }
    const server = await this.device.gatt!.connect();
    for (const uuid of BLE_SERVICES) {
      try {
        const svc = await server.getPrimaryService(uuid);
        const chars = await svc.getCharacteristics();
        const w = chars.find((c) => c.properties.writeWithoutResponse || c.properties.write);
        if (w) {
          this.ch = w;
          return;
        }
      } catch {
        /* try next */
      }
    }
    throw new Error('No writable printer characteristic found on this Bluetooth device');
  }
  async write(data: Uint8Array) {
    if (!this.ch || !this.device?.gatt?.connected) await this.connect();
    await chunk(data, 180, async (p) => {
      if (this.ch!.properties.writeWithoutResponse) await this.ch!.writeValueWithoutResponse(p as BufferSource);
      else await this.ch!.writeValue(p as BufferSource);
    });
  }
  async disconnect() {
    this.device?.gatt?.disconnect();
    this.ch = null;
  }
  isConnected() {
    return !!this.device?.gatt?.connected;
  }
}

/* ---------------------------------------------------------------- Web Serial (USB-serial, Bluetooth SPP virtual COM) */
export class WebSerialTransport implements PrinterTransport {
  kind = 'SERIAL';
  private port: any = null;
  constructor(private deviceKey: string, private baudRate = 9600) {}
  static async request(): Promise<any> {
    const serial = (navigator as any).serial;
    if (!serial) throw new Error('Web Serial is not supported in this browser');
    return serial.requestPort();
  }
  static key(port: any) {
    const i = port.getInfo?.() ?? {};
    return `serial:${(i.usbVendorId ?? 0).toString(16)}:${(i.usbProductId ?? 0).toString(16)}`;
  }
  async connect() {
    if (this.port?.writable) return;
    const ports: any[] = await (navigator as any).serial.getPorts();
    const p = ports.find((x) => WebSerialTransport.key(x) === this.deviceKey) ?? ports[0];
    if (!p) throw new Error('Serial printer not paired with this browser');
    await p.open({ baudRate: this.baudRate });
    this.port = p;
  }
  async write(data: Uint8Array) {
    if (!this.port?.writable) await this.connect();
    const w = this.port.writable.getWriter();
    try {
      await w.write(data);
    } finally {
      w.releaseLock();
    }
  }
  async disconnect() {
    await this.port?.close().catch(() => {});
    this.port = null;
  }
  isConnected() {
    return !!this.port?.writable;
  }
}

/* ---------------------------------------------------------------- Native bridges */
const b64 = (d: Uint8Array) => {
  let s = '';
  for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
  return btoa(s);
};

/**
 * Android WebView bridge contract (implemented by the Android shell app):
 *   window.AndroidPrinter.print(printerJson: string, base64Data: string): string  // "OK" or error message
 *   window.AndroidPrinter.status(printerJson: string): string                      // "CONNECTED" | "OFFLINE" | error
 */
export class AndroidBridgeTransport implements PrinterTransport {
  kind = 'ANDROID';
  constructor(private printer: PrinterConfig) {}
  private get bridge(): any {
    return (window as any).AndroidPrinter;
  }
  async connect() {
    if (!this.bridge) throw new Error('Android printer bridge not available (open in the Android kiosk app)');
  }
  async write(data: Uint8Array) {
    await this.connect();
    const r = String(this.bridge.print(JSON.stringify(this.printer), b64(data)));
    if (r !== 'OK') throw new Error(r || 'Android bridge print failed');
  }
  async disconnect() {}
  isConnected() {
    return !!this.bridge;
  }
}

/**
 * Desktop bridge contract (Electron / Tauri preload):
 *   window.desktopBridge.print({ printer, data: base64 }): Promise<{ ok: boolean; error?: string }>
 * The desktop shell can reach USB / LAN / OS-installed printers directly.
 */
export class DesktopBridgeTransport implements PrinterTransport {
  kind = 'DESKTOP';
  constructor(private printer: PrinterConfig) {}
  private get bridge(): any {
    return (window as any).desktopBridge;
  }
  async connect() {
    if (!this.bridge) throw new Error('Desktop bridge not available (run inside the desktop app)');
  }
  async write(data: Uint8Array) {
    await this.connect();
    const r = await this.bridge.print({ printer: this.printer, data: b64(data) });
    if (!r?.ok) throw new Error(r?.error || 'Desktop bridge print failed');
  }
  async disconnect() {}
  isConnected() {
    return !!this.bridge;
  }
}

const pool = new Map<string, PrinterTransport>();
/** Pick the transport for a printer handled by this browser device. */
export function transportFor(p: PrinterConfig): PrinterTransport {
  const key = `${p.id}:${p.executor}:${p.connection}:${p.device_id}`;
  const existing = pool.get(key);
  if (existing) return existing;
  let t: PrinterTransport;
  if (p.executor === 'ANDROID') t = new AndroidBridgeTransport(p);
  else if (p.executor === 'DESKTOP') t = new DesktopBridgeTransport(p);
  else if (p.connection === 'BLE') t = new WebBluetoothTransport(p.device_id ?? '');
  else if (p.connection === 'BLUETOOTH' || p.device_id?.startsWith('serial:')) t = new WebSerialTransport(p.device_id ?? '');
  else if (p.connection === 'USB') t = new WebUsbTransport(p.device_id ?? '');
  else throw new Error(`${p.connection} printers must be driven by the Print Agent (browsers cannot open raw TCP sockets)`);
  pool.set(key, t);
  return t;
}
