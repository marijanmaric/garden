'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState } from 'react';
import { Building2, ClipboardList, LayoutDashboard, LogOut, Package, Rocket, ScrollText } from 'lucide-react';
import { api, getToken, setToken } from '@/lib/api';
import { clsx } from './clsx';

interface AdminMe { user: { id: string; name: string; email: string; role: string; isPlatformAdmin: boolean }; organization: { id: string; name: string } }
const Ctx = createContext<AdminMe | null>(null);
export const useAdmin = () => useContext(Ctx)!;

const NAV = [
  { href: '/admin', label: 'Overview', icon: LayoutDashboard },
  { href: '/admin/organizations', label: 'Organizations', icon: Building2 },
  { href: '/admin/onboarding', label: 'Onboarding', icon: Rocket },
  { href: '/admin/plans', label: 'Plans', icon: Package },
  { href: '/admin/audit', label: 'Platform audit', icon: ScrollText },
];

/**
 * The platform administration portal: separate from the casino app (no casino, no money screens). The API
 * refuses every /platform route for anyone but a platform administrator; this shell only mirrors that.
 */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<AdminMe | null>(null);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    if (!getToken()) { router.replace('/login'); return; }
    api<AdminMe>('/auth/me').then((m) => (m.user.isPlatformAdmin ? setMe(m) : setDenied(true))).catch(() => router.replace('/login'));
  }, [router]);
  const logout = () => { setToken(null); router.replace('/login'); };
  if (denied) return (
    <div className="flex min-h-screen items-center justify-center p-6 text-center" data-testid="admin-denied">
      <div><div className="text-lg font-semibold">Platform administrators only</div>
        <div className="mt-1 text-sm text-sub">This area manages customer organisations. <Link className="text-brand" href="/">Back to the casino app</Link></div></div>
    </div>
  );
  if (!me) return <div className="flex min-h-screen items-center justify-center text-sub">Loading platform administration...</div>;
  return (
    <Ctx.Provider value={me}>
      <div className="flex min-h-screen">
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-line bg-panel lg:block">
          <div className="flex h-16 items-center gap-2 border-b border-line px-5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-slate-700 to-slate-900 text-sm font-black text-white">M1</div>
            <div className="leading-tight"><div className="text-sm font-bold tracking-wide">M1 PLATFORM</div><div className="text-[10px] uppercase tracking-widest text-sub">SaaS administration</div></div>
          </div>
          <nav className="space-y-1 px-3 py-4">
            {NAV.map((i) => {
              const active = i.href === '/admin' ? pathname === '/admin' : pathname.startsWith(i.href);
              return (
                <Link key={i.href} href={i.href} className={clsx('flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm', active ? 'bg-brand/10 font-semibold text-brand' : 'text-fg/80 hover:bg-muted')}>
                  <i.icon className="h-4 w-4" />{i.label}
                </Link>
              );
            })}
          </nav>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col lg:pl-60">
          <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-line bg-panel/80 px-4 backdrop-blur md:px-6">
            <ClipboardList className="h-4 w-4 text-sub lg:hidden" />
            <nav className="flex gap-3 overflow-x-auto text-sm lg:hidden">{NAV.map((i) => <Link key={i.href} href={i.href} className="whitespace-nowrap text-sub">{i.label}</Link>)}</nav>
            <span className="hidden text-xs text-sub lg:inline">{me.organization.name}</span>
            <div className="ml-auto flex items-center gap-3">
              <div className="hidden text-right leading-tight sm:block"><div className="text-sm font-medium">{me.user.name}</div><div className="text-[10px] uppercase tracking-wide text-sub">Platform administrator</div></div>
              <button className="btn px-2" onClick={logout} aria-label="Log out" title="Log out"><LogOut className="h-4 w-4" /></button>
            </div>
          </header>
          <main className="flex-1 p-4 md:p-6">{children}</main>
        </div>
      </div>
    </Ctx.Provider>
  );
}
