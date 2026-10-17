'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Feature, ModuleState, Permission, ProductModule } from '@m1/shared';
import { api, getToken, setToken } from './api';

export interface Casino {
  id: string;
  code: string;
  name: string;
  city: string;
  timezone: string;
}

/** The organisation's entitlements as the API evaluated them (GET /auth/me, never cached across organisations). */
export interface Entitlements {
  orgId: string;
  orgName: string;
  orgStatus: 'ACTIVE' | 'DISABLED';
  isPlatform: boolean;
  subscription: null | { status: string; startsAt: string; endsAt: string | null; usable: boolean; plan: { code: string; name: string; version: number } };
  modules: Array<{ module: ProductModule; name: string; purchased: boolean; enabled: boolean; missing: ProductModule[]; effective: boolean; state: ModuleState }>;
  /** Features usable now. */
  features: Feature[];
  /** Features whose data stays readable (also with an inactive subscription). */
  readable: Feature[];
}

export interface Me {
  user: { id: string; name: string; email: string; role: string; isPlatformAdmin: boolean };
  organization: { id: string; name: string; is_platform: boolean };
  permissions: Permission[];
  casinos: Casino[];
  entitlements: Entitlements;
}

interface SessionValue {
  me: Me;
  casino: Casino;
  setCasinoId: (id: string) => void;
  can: (p: Permission) => boolean;
  /** The feature is usable now (actions allowed). */
  has: (f: Feature) => boolean;
  /** The feature's pages and data are visible (usable, or read-only on an inactive subscription). */
  sees: (f: Feature) => boolean;
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
    // platform administrators have no casino: they work in the admin portal
    if (m.user.isPlatformAdmin && !m.casinos.length) {
      router.replace('/admin');
      return;
    }
    setMe(m);
    setCasinoIdState((cur) => {
      const saved = cur ?? localStorage.getItem('m1-casino');
      return m.casinos.find((c) => c.id === saved)?.id ?? m.casinos[0]?.id ?? null;
    });
  }, [router]);

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
    const features = new Set(me.entitlements.features);
    const readable = new Set(me.entitlements.readable);
    return {
      me,
      casino,
      setCasinoId: (id) => {
        localStorage.setItem('m1-casino', id);
        setCasinoIdState(id);
      },
      can: (p) => me.permissions.includes(p),
      has: (f) => features.has(f),
      sees: (f) => readable.has(f),
      refresh,
      logout: () => {
        setToken(null);
        router.replace('/login');
      },
    };
  }, [me, casinoId, refresh, router]);

  if (!value)
    return (
      <div className="flex min-h-screen items-center justify-center p-6 text-center text-sub">
        {me && !me.casinos.length ? (
          <div>
            <div className="text-fg font-semibold">No casino assigned to this account.</div>
            <div className="mt-1 text-sm">Ask your administrator to create a casino or to grant you access.</div>
            <button className="btn mt-4" onClick={() => { setToken(null); router.replace('/login'); }}>Log out</button>
          </div>
        ) : 'Loading M1 Casino Cloud...'}
      </div>
    );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
