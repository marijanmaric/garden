'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Permission } from '@m1/shared';
import { api, getToken, setToken } from './api';

export interface Casino {
  id: string;
  code: string;
  name: string;
  city: string;
  timezone: string;
  modules: Record<string, boolean>;
}

export interface Me {
  user: { id: string; name: string; email: string; role: string };
  organization: { id: string; name: string };
  permissions: Permission[];
  casinos: Casino[];
}

interface SessionValue {
  me: Me;
  casino: Casino;
  setCasinoId: (id: string) => void;
  can: (p: Permission) => boolean;
  moduleOn: (key: string) => boolean;
  refresh: () => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<SessionValue | null>(null);

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [casinoId, setCasinoIdState] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const m = await api<Me>('/auth/me');
    setMe(m);
    setCasinoIdState((cur) => {
      const saved = cur ?? localStorage.getItem('m1-casino');
      return m.casinos.find((c) => c.id === saved)?.id ?? m.casinos[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    refresh().catch(() => router.replace('/login'));
  }, [refresh, router]);

  const value = useMemo<SessionValue | null>(() => {
    if (!me) return null;
    const casino = me.casinos.find((c) => c.id === casinoId) ?? me.casinos[0];
    if (!casino) return null;
    return {
      me,
      casino,
      setCasinoId: (id) => {
        localStorage.setItem('m1-casino', id);
        setCasinoIdState(id);
      },
      can: (p) => me.permissions.includes(p),
      moduleOn: (key) => casino.modules[key] ?? false,
      refresh,
      logout: () => {
        setToken(null);
        router.replace('/login');
      },
    };
  }, [me, casinoId, refresh, router]);

  if (!value)
    return (
      <div className="flex min-h-screen items-center justify-center text-sub">
        {me && !me.casinos.length ? 'No casino assigned to this account.' : 'Loading M1 Casino Cloud...'}
      </div>
    );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
