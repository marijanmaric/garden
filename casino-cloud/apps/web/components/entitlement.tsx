'use client';
import Link from 'next/link';
import { Lock, PauseCircle } from 'lucide-react';
import { FEATURES, PRODUCT_MODULE_DEFS, type Feature, type ProductModule } from '@m1/shared';
import { useSession } from '@/lib/session';
import { Card } from './ui';

/** Modules a feature needs that the organisation does not have (for the explanation). */
function missingModules(feature: Feature, effective: Set<string>): ProductModule[] {
  const f = FEATURES[feature] as { modules: readonly ProductModule[]; anyOf?: readonly ProductModule[] };
  const out = f.modules.filter((m) => !effective.has(m));
  if (f.anyOf && !f.anyOf.some((m) => effective.has(m))) out.push(f.anyOf[0]);
  return out;
}

/**
 * Shown instead of a page whose feature is not part of the organisation's plan (also on a direct URL).
 * The API refuses the same feature with 403 MODULE_NOT_ENTITLED; this page only explains it.
 */
export function NotEntitled({ feature }: { feature: Feature }) {
  const { me, can } = useSession();
  const ent = me.entitlements;
  const effective = new Set(ent.modules.filter((m) => m.effective).map((m) => m.module));
  const missing = missingModules(feature, effective);
  const disabled = missing.filter((m) => ent.modules.find((x) => x.module === m)?.state === 'DISABLED');
  return (
    <div className="mx-auto max-w-xl py-10" data-testid="not-entitled">
      <Card>
        <div className="flex items-start gap-4">
          <div className="rounded-xl bg-amber-500/10 p-3 text-amber-600"><Lock className="h-6 w-6" /></div>
          <div className="space-y-2 text-sm">
            <h1 className="text-lg font-semibold">{disabled.length ? 'This module is switched off' : 'Not included in your plan'}</h1>
            <p className="text-sub">
              {disabled.length ? 'This module is switched off for your organisation.' : 'This feature is not included in your current plan.'}
              {ent.subscription && <> Current plan: <b>{ent.subscription.plan.name}</b>.</>}
            </p>
            {missing.length > 0 && (
              <ul className="space-y-1">
                {missing.map((m) => (
                  <li key={m}><b>{PRODUCT_MODULE_DEFS[m].name}</b>: {PRODUCT_MODULE_DEFS[m].description}</li>
                ))}
              </ul>
            )}
            <p className="text-sub">
              {can('org.manage')
                ? disabled.length ? <>Switch it on under <Link className="text-brand" href="/organization">Organization</Link>.</> : 'Contact your platform administrator to upgrade.'
                : 'Contact your administrator to upgrade.'}
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** Renders children only when the feature is visible; otherwise the explanation page. */
export function FeatureGate({ feature, children }: { feature: Feature; children: React.ReactNode }) {
  const { sees } = useSession();
  return sees(feature) ? <>{children}</> : <NotEntitled feature={feature} />;
}

/** Read-only banner: inactive subscription (data stays readable, new actions are refused by the API). */
export function SubscriptionBanner() {
  const { me } = useSession();
  const s = me.entitlements.subscription;
  if (!s || s.usable) return null;
  return (
    <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300" data-testid="subscription-banner">
      <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        Your subscription is <b>{s.endsAt && new Date(s.endsAt) <= new Date() ? 'expired' : s.status.toLowerCase()}</b>: existing data stays readable,
        new actions are not possible. Contact your administrator.
      </span>
    </div>
  );
}
