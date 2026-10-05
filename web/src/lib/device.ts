/** Stable per-browser device id (used for printer binding and audit). */
export function deviceId(): string {
  try {
    let id = localStorage.getItem('device_id');
    if (!id) {
      id = 'dev_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
      localStorage.setItem('device_id', id);
    }
    return id;
  } catch {
    return 'dev_ephemeral_session';
  }
}

export const APP_VERSION = '1.0.0';
