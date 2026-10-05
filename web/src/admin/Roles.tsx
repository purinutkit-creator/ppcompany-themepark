import { useMemo, useState } from 'react';
import { Plus, Lock } from 'lucide-react';
import { Badge, Button, Card, Field, Input, Loading, Modal, NumberInput, PageHeader, confirmDialog } from '../components/ui';
import { useCrud, useList } from './hooks';

export default function Roles() {
  const roles = useList('roles', '/staff/roles');
  const perms = useList('permissions', '/staff/permissions');
  const crud = useCrud('roles', '/staff/roles');
  const [edit, setEdit] = useState<any | null>(null);
  const groups = useMemo(() => {
    const g = new Map<string, any[]>();
    for (const p of perms.data ?? []) g.set(p.grp, [...(g.get(p.grp) ?? []), p]);
    return [...g];
  }, [perms.data]);
  if (roles.isLoading || perms.isLoading) return <Loading />;
  return (
    <div>
      <PageHeader title="Roles & permissions" sub="Owner · Admin · Manager · Cashier · Kitchen · Staff + custom roles. Permissions are enforced on the server for every request." actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ code: '', name: '', level: 20, permissions: [] })}>Custom role</Button>} />
      <Card padded={false}>
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-slate-50">
                <th className="sticky left-0 bg-slate-50 px-4 py-3 text-left">Permission</th>
                {roles.data?.map((r: any) => (
                  <th key={r.id} className="px-3 py-3 text-center whitespace-nowrap">
                    <button onClick={() => r.code !== 'OWNER' && setEdit(r)} className="font-semibold hover:text-primary">{r.name}</button>
                    <div className="text-[10px] font-normal text-slate-500">L{r.level} · {r.user_count} users</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map(([g, list]) => (
                <>
                  <tr key={g}><td colSpan={99} className="bg-slate-100/60 px-4 py-1.5 text-xs font-bold tracking-wide text-slate-500 uppercase">{g}</td></tr>
                  {list.map((p: any) => (
                    <tr key={p.code} className="border-b border-slate-100">
                      <td className="sticky left-0 bg-white px-4 py-2">{p.name} {p.is_sensitive && <Lock className="inline h-3 w-3 text-amber-600" />}<div className="font-mono text-[10px] text-slate-400">{p.code}</div></td>
                      {roles.data?.map((r: any) => (
                        <td key={r.id} className="text-center">{r.permissions.includes(p.code) ? <span className="text-emerald-600">●</span> : <span className="text-slate-200">○</span>}</td>
                      ))}
                    </tr>
                  ))}
                </>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {edit && (
        <Modal open onClose={() => setEdit(null)} size="lg" title={edit.id ? `Edit role — ${edit.name}` : 'New custom role'} footer={<>
          {edit.id && !edit.is_system && <Button variant="ghost" className="mr-auto text-rose-600" onClick={async () => { if (await confirmDialog('Delete role?', undefined, true)) { await crud.remove(edit.id); setEdit(null); } }}>Delete</Button>}
          <Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
          <Button disabled={!edit.code || !edit.name} onClick={async () => { try { await crud.save(edit.id, { code: edit.code, name: edit.name, level: Number(edit.level), permissions: edit.permissions }); setEdit(null); } catch { /* */ } }}>Save</Button></>}>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Code"><Input value={edit.code} disabled={edit.is_system} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })} /></Field>
            <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Level (manager ≥ 70)"><NumberInput value={edit.level} onChange={(v) => setEdit({ ...edit, level: v ?? 10 })} min={1} max={100} /></Field>
          </div>
          <div className="mt-4 space-y-3">
            {groups.map(([g, list]) => (
              <div key={g}>
                <div className="mb-1 text-xs font-bold text-slate-500 uppercase">{g}</div>
                <div className="flex flex-wrap gap-1.5">
                  {list.map((p: any) => {
                    const on = edit.permissions.includes(p.code);
                    return (
                      <button key={p.code} onClick={() => setEdit({ ...edit, permissions: on ? edit.permissions.filter((x: string) => x !== p.code) : [...edit.permissions, p.code] })} className={`rounded-full px-3 py-1 text-xs ${on ? 'bg-primary text-white' : 'bg-slate-100 text-slate-700'}`}>
                        {p.name}{p.is_sensitive && ' 🔒'}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-slate-500">Sensitive actions (refund, void, manual payment approval, reprint, cancel paid order) can additionally require a manager PIN — see Settings → Security. <Badge>Tip</Badge> You can only grant permissions you hold yourself.</p>
        </Modal>
      )}
    </div>
  );
}
