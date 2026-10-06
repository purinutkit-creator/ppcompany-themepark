import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { Badge, Button, Card, Empty, Field, Input, Loading, Modal, PageHeader, Select, StatusBadge, Table, Td, confirmDialog } from '../components/ui';
import { useCrud, useList } from './hooks';
import { tt } from '../lib/legacy-i18n';

export default function Staff() {
  const list = useList('users', '/staff/users');
  const roles = useList('roles', '/staff/roles');
  const branches = useList('branches', '/devices/branches');
  const crud = useCrud('users', '/staff/users');
  const { user } = useAuth();
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <div>
      <PageHeader title={tt('Staff')} sub={tt('Employees, roles, PIN login and branch assignment. Passwords and PINs are stored as bcrypt hashes.')} actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ name: '', nickname: '', employee_code: '', username: '', password: '', pin: '', role_id: roles.data?.find((r: any) => r.code === 'CASHIER')?.id ?? '', branch_id: user?.branchId ?? '', status: 'ACTIVE' })}>{tt('New staff')}</Button>} />
      <Card>
        {list.isLoading ? <Loading /> : !list.data?.length ? <Empty /> : (
          <Table head={['Name', 'Code', 'Username', 'Role', 'Branch', 'Login', 'Last login', 'Status', '']}>
            {list.data.map((u: any) => (
              <tr key={u.id}>
                <Td><div className="font-medium">{u.name}</div><div className="text-xs text-slate-500">{u.nickname}</div></Td>
                <Td className="font-mono">{u.employee_code}</Td>
                <Td>{u.username ?? '—'}</Td>
                <Td><Badge>{u.role_name}</Badge></Td>
                <Td>{u.branch_code ?? 'All'}</Td>
                <Td className="text-xs">{u.has_pin && 'PIN '}{u.has_password && 'Password'}</Td>
                <Td className="text-xs">{dateTime(u.last_login_at)}</Td>
                <Td><StatusBadge status={u.status === 'ACTIVE' ? tt('ONLINE') : tt('OFFLINE')} className="hidden" /><Badge className={u.status === 'ACTIVE' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200'}>{u.status}</Badge></Td>
                <Td className="text-right whitespace-nowrap">
                  <Button size="sm" variant="outline" onClick={() => setEdit({ ...u, password: '', pin: '', username: u.username ?? '', nickname: u.nickname ?? '', branch_id: u.branch_id ?? '' })}>{tt('Edit')}</Button>
                  {u.id !== user?.id && u.status === 'ACTIVE' && <Button size="sm" variant="ghost" className="text-rose-600" onClick={async () => (await confirmDialog(tt('Deactivate staff?'), 'They are signed out everywhere immediately.', true)) && crud.remove(u.id)}>{tt('Deactivate')}</Button>}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? `Edit ${edit.name}` : 'New staff'} size="md" footer={<><Button variant="ghost" onClick={() => setEdit(null)}>{tt('Cancel')}</Button><Button disabled={!edit.name || !edit.employee_code || !edit.role_id || (!edit.id && !edit.pin && !edit.password)} onClick={async () => {
          try {
            await crud.save(edit.id, { name: edit.name, nickname: edit.nickname || null, employee_code: edit.employee_code, username: edit.username || null, password: edit.password || null, pin: edit.pin || null, role_id: edit.role_id, branch_id: edit.branch_id || null, status: edit.status });
            setEdit(null);
          } catch { /* */ }
        }}>{tt('Save')}</Button></>}>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={tt('Full name')}><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label={tt('Nickname')}><Input value={edit.nickname} onChange={(e) => setEdit({ ...edit, nickname: e.target.value })} /></Field>
            <Field label={tt('Employee code')}><Input value={edit.employee_code} onChange={(e) => setEdit({ ...edit, employee_code: e.target.value.toUpperCase() })} /></Field>
            <Field label={tt('Username (optional)')}><Input value={edit.username} onChange={(e) => setEdit({ ...edit, username: e.target.value })} /></Field>
            <Field label={edit.id ? 'New password (leave blank to keep)' : 'Password (min 8)'}><Input type="password" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></Field>
            <Field label={edit.id ? 'New PIN (leave blank to keep)' : 'PIN (4–8 digits)'}><Input inputMode="numeric" value={edit.pin} onChange={(e) => setEdit({ ...edit, pin: e.target.value.replace(/\D/g, '').slice(0, 8) })} /></Field>
            <Field label={tt('Role')}><Select value={edit.role_id} onChange={(e) => setEdit({ ...edit, role_id: e.target.value })}>{roles.data?.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field>
            <Field label={tt('Branch')}><Select value={edit.branch_id} onChange={(e) => setEdit({ ...edit, branch_id: e.target.value })} disabled={!!user?.branchId}><option value="">{tt('All branches')}</option>{branches.data?.map((b: any) => <option key={b.id} value={b.id}>{b.code}</option>)}</Select></Field>
            <Field label={tt('Status')}><Select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}><option value="ACTIVE">{tt('Active')}</option><option value="INACTIVE">{tt('Inactive')}</option><option value="LOCKED">{tt('Locked')}</option></Select></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
