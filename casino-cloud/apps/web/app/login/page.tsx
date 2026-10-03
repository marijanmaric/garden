'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, setToken } from '@/lib/api';

const DEMO = [
  ['admin@example.com', 'Super Admin'],
  ['manager@example.com', 'Manager'],
  ['floor@example.com', 'Floor Supervisor'],
  ['tech@example.com', 'Technician'],
  ['accounting@example.com', 'Accounting'],
  ['cashier@example.com', 'Cashier'],
  ['admin@riverside.example', 'Other tenant'],
];

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('admin@example.com');
  const [password, setPassword] = useState('demo');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token } = await api<{ token: string }>('/auth/login', { method: 'POST', json: { email, password } });
      setToken(token);
      router.replace('/');
    } catch (err) {
      setError((err as Error).message === 'Failed to fetch' ? 'API not reachable on port 4000' : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-violet-950 via-slate-950 to-black p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center text-white">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-xl font-black">M1</div>
          <h1 className="text-2xl font-bold tracking-wide">M1 CASINO CLOUD</h1>
          <p className="mt-1 text-sm text-white/60">Casino Management, Floor Control & Accounting</p>
        </div>
        <form onSubmit={submit} className="card space-y-4 p-6">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-sub">Email</label>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-sub">Password</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </div>
          {error && <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</div>}
          <button className="btn-primary w-full py-2.5" disabled={busy}>
            {busy ? 'Signing in...' : 'Sign in'}
          </button>
          <div className="border-t border-line pt-4">
            <div className="mb-2 text-xs text-sub">Demo accounts (password: demo)</div>
            <div className="flex flex-wrap gap-1.5">
              {DEMO.map(([e, label]) => (
                <button type="button" key={e} onClick={() => { setEmail(e); setPassword('demo'); }} className="rounded-md bg-muted px-2 py-1 text-xs hover:bg-line">
                  {label}
                </button>
              ))}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
