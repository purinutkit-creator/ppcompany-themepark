import { useQuery } from '@tanstack/react-query';
import { tr, type Lang } from '@kiosk/shared';
import { parkApi, staffApi } from '../../lib/api';
import { useT } from '../../lib/lang';
import type { Opt } from './EntityPage';

const list = (key: string, path: string, api = parkApi) => ({ queryKey: ['opt', key], queryFn: () => api<any>(path), staleTime: 30_000, retry: false });

/** Option lists shared by the park admin editors (names in the current UI language). */
export function useParkOptions() {
  const t = useT();
  const lang: Lang = t.lang;
  const tt = useQuery(list('ticket-types', '/admin/ticket-types'));
  const zones = useQuery(list('zones', '/admin/zones'));
  const tiers = useQuery(list('tiers', '/admin/tiers'));
  const pkgs = useQuery(list('packages', '/admin/packages'));
  const rides = useQuery(list('rides', '/rides/admin'));
  const devices = useQuery(list('devices', '/admin/devices'));
  const branches = useQuery(list('branches', '/devices/branches', staffApi));
  const printers = useQuery(list('printers', '/print/printers', staffApi));
  const cats = useQuery(list('categories', '/menu/categories', staffApi));
  const promos = useQuery(list('promotions', '/menu/promotions', staffApi));
  const staff = useQuery(list('staff', '/staff/users', staffApi));
  const name = (x: any) => tr(x.name, lang, x.code ?? '');
  const o = (rows: any, label: (x: any) => string): Opt[] => (Array.isArray(rows) ? rows : []).map((x: any) => ({ value: x.id, label: label(x) }));
  return {
    ticketTypes: o(tt.data, (x) => `${name(x)} (${x.code})`),
    ticketTypeRows: (tt.data ?? []) as any[],
    zones: o(zones.data, name),
    tiers: o(tiers.data, name),
    tierRows: (tiers.data ?? []) as any[],
    packages: o(pkgs.data, name),
    rides: o(rides.data, (x) => `${name(x)} (${x.code})`),
    devices: o(devices.data, (x) => `${x.code} · ${x.type}`),
    branches: o(branches.data, (x) => x.code),
    printers: o(printers.data, (x) => x.name),
    categories: o(cats.data, name),
    promotions: o(promos.data, name),
    staff: o(staff.data, (x) => `${x.name} (${x.employee_code ?? x.username ?? ''})`),
  };
}

export const enumOpts = (values: readonly string[], label?: (v: string) => string): Opt[] => values.map((v) => ({ value: v, label: label ? label(v) : v.replace(/_/g, ' ') }));
