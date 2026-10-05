import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { Delete, KeyRound, Hash } from 'lucide-react';
import { errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, Field, Input } from '../components/ui';

export default function Login() {
  const { login, user } = useAuth();
  const [params] = useSearchParams();
  const next = params.get('next') || '/admin';
  const nav = useNavigate();
  const [mode, setMode] = useState<'pin' | 'password'>('pin');
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (user) return <Navigate to={next} replace />;

  const submit = async (body: Record<string, string>) => {
    setBusy(true);
    setErr(null);
    try {
      await login(body);
      nav(next, { replace: true });
    } catch (e) {
      setErr(errorMessage(e));
      setPin('');
    } finally {
      setBusy(false);
    }
  };
  const press = (d: string) => setPin((p) => (p + d).slice(0, 8));

  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-slate-900 to-slate-700 p-4">
      <div className="w-full max-w-md rounded-3xl bg-white p-8 shadow-2xl">
        <div className="mb-6 flex items-center gap-3">
          <img src="/icon.svg" className="h-12 w-12" alt="" />
          <div>
            <h1 className="text-2xl font-bold">Staff sign in</h1>
            <p className="text-sm text-slate-500">เข้าสู่ระบบพนักงาน</p>
          </div>
        </div>
        <div className="mb-5 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
          {(['pin', 'password'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={clsx('flex items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium', mode === m ? 'bg-white shadow' : 'text-slate-600')}>
              {m === 'pin' ? <Hash className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
              {m === 'pin' ? 'Employee code + PIN' : 'Username + password'}
            </button>
          ))}
        </div>
        {mode === 'pin' ? (
          <form onSubmit={(e) => { e.preventDefault(); void submit({ employeeCode: code.toUpperCase(), pin }); }}>
            <Field label="Employee code">
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="CSH001" autoFocus autoCapitalize="characters" />
            </Field>
            <div className="mt-4 mb-3 flex justify-center gap-3">
              {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => (
                <span key={i} className={clsx('h-4 w-4 rounded-full', i < pin.length ? 'bg-primary' : 'bg-slate-200')} />
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button type="button" key={d} onClick={() => press(d)} className="press h-14 rounded-xl bg-slate-100 text-2xl font-semibold hover:bg-slate-200">
                  {d}
                </button>
              ))}
              <button type="button" onClick={() => setPin('')} className="press h-14 rounded-xl bg-slate-100 text-sm font-medium">
                Clear
              </button>
              <button type="button" onClick={() => press('0')} className="press h-14 rounded-xl bg-slate-100 text-2xl font-semibold">
                0
              </button>
              <button type="button" onClick={() => setPin((p) => p.slice(0, -1))} className="press flex h-14 items-center justify-center rounded-xl bg-slate-100">
                <Delete className="h-6 w-6" />
              </button>
            </div>
            {err && <div className="mt-4 rounded-xl bg-rose-50 px-4 py-2 text-sm text-rose-700">{err}</div>}
            <Button type="submit" className="mt-5 w-full" size="lg" loading={busy} disabled={!code || pin.length < 4}>
              Sign in
            </Button>
          </form>
        ) : (
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit({ username, password }); }}>
            <Field label="Username">
              <Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
            </Field>
            <Field label="Password">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </Field>
            {err && <div className="rounded-xl bg-rose-50 px-4 py-2 text-sm text-rose-700">{err}</div>}
            <Button type="submit" className="w-full" size="lg" loading={busy} disabled={!username || !password}>
              Sign in
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
