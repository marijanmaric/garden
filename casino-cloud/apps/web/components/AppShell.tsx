'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LogOut, Menu, Moon, Sun, X } from 'lucide-react';
import { useSession } from '@/lib/session';
import { LiveProvider } from '@/lib/live';
import { LiveDot } from './EventFeed';
import { NAV } from './nav';
import { clsx } from './clsx';

function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains('dark')), []);
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('m1-theme', next ? 'dark' : 'light');
    setDark(next);
  };
  return (
    <button onClick={toggle} className="btn px-2" aria-label="Toggle theme">
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { can, moduleOn } = useSession();
  return (
    <nav className="flex h-full flex-col">
      <div className="flex h-16 items-center gap-2 border-b border-line px-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 text-sm font-black text-white">M1</div>
        <div className="leading-tight">
          <div className="text-sm font-bold tracking-wide">M1 CASINO CLOUD</div>
          <div className="text-[10px] uppercase tracking-widest text-sub">Management Platform</div>
        </div>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
        {NAV.map((group) => {
          const items = group.items.filter(
            (i) => (!i.permission || can(i.permission)) && (!i.anyPermission || i.anyPermission.some(can)) && (!i.module || moduleOn(i.module)),
          );
          if (!items.length) return null;
          return (
            <div key={group.title}>
              <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-sub">{group.title}</div>
              {items.map((item) => {
                const active = item.href === '/' ? pathname === '/' : pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onNavigate}
                    className={clsx(
                      'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition',
                      active ? 'bg-brand/10 font-semibold text-brand' : 'text-fg/80 hover:bg-muted',
                    )}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    <span className="flex-1">{item.label}</span>
                    {item.phase && <span className="rounded bg-muted px-1.5 text-[10px] text-sub">P{item.phase}</span>}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { me, casino, setCasinoId, logout } = useSession();
  const [open, setOpen] = useState(false);
  return (
    <LiveProvider>
      <div className="flex min-h-screen">
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-line bg-panel lg:block">
          <Sidebar />
        </aside>
        {open && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
            <aside className="absolute inset-y-0 left-0 w-72 border-r border-line bg-panel">
              <button className="absolute right-3 top-4 btn px-2" onClick={() => setOpen(false)} aria-label="Close menu">
                <X className="h-4 w-4" />
              </button>
              <Sidebar onNavigate={() => setOpen(false)} />
            </aside>
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col lg:pl-64">
          <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-line bg-panel/80 px-4 backdrop-blur md:px-6">
            <button className="btn px-2 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
              <Menu className="h-4 w-4" />
            </button>
            <select className="input w-auto max-w-[14rem] font-medium" value={casino.id} onChange={(e) => setCasinoId(e.target.value)}>
              {me.casinos.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <span className="hidden text-xs text-sub md:inline">{me.organization.name}</span>
            <div className="ml-auto flex items-center gap-3">
              <LiveDot />
              <ThemeToggle />
              <div className="hidden text-right leading-tight sm:block">
                <div className="text-sm font-medium">{me.user.name}</div>
                <div className="text-[10px] uppercase tracking-wide text-sub">{me.user.role.replace(/_/g, ' ')}</div>
              </div>
              <button className="btn px-2" onClick={logout} aria-label="Log out" title="Log out">
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </header>
          <main className="flex-1 p-4 md:p-6">{children}</main>
        </div>
      </div>
    </LiveProvider>
  );
}
