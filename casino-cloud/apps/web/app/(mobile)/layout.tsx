'use client';
import { SessionProvider } from '@/lib/session';
import { LiveProvider } from '@/lib/live';
import { FeatureGate } from '@/components/entitlement';

/** Full-screen layout for tablets: no sidebar, no top navigation. */
export default function MobileLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <FeatureGate feature="cash"><LiveProvider>{children}</LiveProvider></FeatureGate>
    </SessionProvider>
  );
}
