import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { staffApi, errorMessage } from '../lib/api';
import { toast } from '../components/ui';
import { useUiLang } from '../lib/lang';

const MSG = {
  settingsSaved: { th: 'บันทึกการตั้งค่าแล้ว', en: 'Settings saved', zh: '设置已保存' },
  realtime: { th: 'มีผลกับทุกอุปกรณ์แบบเรียลไทม์', en: 'Applied to all devices in real time', zh: '已实时应用到所有设备' },
  saved: { th: 'บันทึกแล้ว', en: 'Saved', zh: '已保存' },
  created: { th: 'สร้างแล้ว', en: 'Created', zh: '已创建' },
  deleted: { th: 'ลบแล้ว', en: 'Deleted', zh: '已删除' },
};
const m = (k: keyof typeof MSG) => MSG[k][useUiLang.getState().lang];

export const useList = <T = any>(key: string, path: string, opts: { enabled?: boolean; refetchInterval?: number } = {}) =>
  useQuery({ queryKey: [key, path], queryFn: () => staffApi<T[]>(path), ...opts });

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => staffApi<{ settings: any; defaults: any }>('/settings') });
}

/** Save one settings key (deep-merged server side on read). */
export function useSaveSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) => staffApi(`/settings/${key}`, { method: 'PUT', body: value }),
    onSuccess: () => {
      toast.success(m('settingsSaved'), m('realtime'));
      void qc.invalidateQueries({ queryKey: ['settings'] });
      void qc.invalidateQueries({ queryKey: ['client-settings'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

/** Generic save/delete helper for CRUD pages. */
export function useCrud(listKey: string, base: string) {
  const qc = useQueryClient();
  const invalidate = () => void qc.invalidateQueries({ queryKey: [listKey] });
  return {
    save: async (id: string | null | undefined, body: unknown) => {
      try {
        const r = await staffApi(id ? `${base}/${id}` : base, { method: id ? 'PUT' : 'POST', body });
        toast.success(id ? m('saved') : m('created'));
        invalidate();
        return r;
      } catch (e) {
        toast.error(errorMessage(e));
        throw e;
      }
    },
    remove: async (id: string) => {
      try {
        await staffApi(`${base}/${id}`, { method: 'DELETE' });
        toast.success(m('deleted'));
        invalidate();
      } catch (e) {
        toast.error(errorMessage(e));
      }
    },
    invalidate,
  };
}
