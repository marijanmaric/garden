'use client';
import { SessionProvider } from '@/lib/session';
import { LiveProvider } from '@/lib/live';

/** Full-screen layout for tablets: no sidebar, no top navigation. */
export default function MobileLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <LiveProvider>{children}</LiveProvider>
    </SessionProvider>
  );
}
