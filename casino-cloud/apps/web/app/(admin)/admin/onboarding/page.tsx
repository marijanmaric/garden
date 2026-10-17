'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Check } from 'lucide-react';
import { PRODUCT_MODULES, PRODUCT_MODULE_DEFS, closure, type ProductModule } from '@m1/shared';
import { api, useApi } from '@/lib/api';
import { Card, ErrorNote, Field, Notice, PageHeader } from '@/components/ui';
import { ModuleStateBadge, type ModuleCardData } from '@/components/admin-ui';
import { clsx } from '@/components/clsx';

const STEPS = ['Organization', 'Plan', 'Modules', 'Casino', 'Admin user', 'Machines', 'Configuration'] as const;
type Plan = { id: string; code: string; name: string; version: number; active: boolean; description: string | null; modules: string[]; limits: Record<string, number> };

/**
 * Onboarding: Organization -> Plan -> Modules -> Casino -> Admin user (the organisation is created here, in one
 * transaction with its subscription and admin) -> Machines -> Configuration (the resulting module states).
 */
export default function OnboardingPage() {
  const plans = useApi<{ plans: Plan[] }>('/platform/plans');
  const [step, setStep] = useState(0);
  const [org, setOrg] = useState({ name: '', slug: '' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [planId, setPlanId] = useState('');
  const [status, setStatus] = useState<'ACTIVE' | 'TRIAL'>('ACTIVE');
  const [endsAt, setEndsAt] = useState('');
  const [extra, setExtra] = useState<Set<ProductModule>>(new Set());
  const [casino, setCasino] = useState({ code: '', name: '', city: '', country: '' });
  const [admin, setAdmin] = useState({ name: '', email: '', password: '' });
  const [created, setCreated] = useState<{ orgId: string; casinoId: string } | null>(null);
  const [machines, setMachines] = useState({ prefix: '', count: '4' });
  const [made, setMade] = useState(0);
  const [modules, setModules] = useState<ModuleCardData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const plan = plans.data?.plans.find((p) => p.id === planId);
  const planModules = new Set((plan?.modules ?? ['CORE']) as ProductModule[]);
  const finalModules = closure([...planModules, ...extra]);
  const added = finalModules.filter((m) => !planModules.has(m));

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const createOrg = () => guard(async () => {
    const r = await api<{ id: string }>('/platform/organizations', { method: 'POST', json: {
      name: org.name, slug: org.slug, planId, status, endsAt: endsAt ? new Date(`${endsAt}T23:59:59Z`).toISOString() : null, admin, note: 'onboarding',
    } });
    // modules beyond the plan: overrides in dependency order, each with the onboarding as reason
    for (const m of PRODUCT_MODULES.filter((x) => added.includes(x)).sort((a, b) => closure([a]).length - closure([b]).length))
      await api(`/platform/organizations/${r.id}/entitlements/${m}`, { method: 'PUT', json: { entitled: true, reason: 'onboarding: added beyond the plan' } });
    const c = await api<{ id: string }>(`/platform/organizations/${r.id}/casinos`, { method: 'POST', json: { code: casino.code, name: casino.name, city: casino.city || undefined, country: casino.country || undefined } });
    setCreated({ orgId: r.id, casinoId: c.id });
    setStep(5);
  });

  const addMachines = () => guard(async () => {
    if (!created) return;
    const n = Math.max(0, Math.min(200, Number(machines.count) || 0));
    for (let i = made + 1; i <= made + n; i++) {
      const code = `${machines.prefix || casino.code}-${String(i).padStart(4, '0')}`;
      await api(`/platform/organizations/${created.orgId}/machines`, { method: 'POST', json: { casinoId: created.casinoId, machineCode: code, assetNo: `M${String(i).padStart(3, '0')}` } });
    }
    setMade(made + n);
  });

  const finish = () => guard(async () => {
    if (!created) return;
    const d = await api<{ modules: ModuleCardData[] }>(`/platform/organizations/${created.orgId}`);
    setModules(d.modules);
    setStep(6);
  });

  const canNext = [
    org.name.trim().length >= 2 && /^[a-z0-9-]{2,}$/.test(org.slug),
    !!planId,
    true,
    casino.code.trim().length >= 2 && casino.name.trim().length >= 2,
    admin.name.trim().length >= 2 && /\S+@\S+/.test(admin.email) && admin.password.length >= 12,
  ][step];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="Onboard a customer" subtitle="Organization, plan, modules, first casino, admin user and machines" />
      <ol className="flex flex-wrap gap-2" data-testid="onboarding-steps">
        {STEPS.map((s, i) => (
          <li key={s} className={clsx('flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium', i === step ? 'bg-brand text-white' : i < step ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-muted text-sub')}>
            {i < step ? <Check className="h-3 w-3" /> : <span>{i + 1}</span>}{s}
          </li>
        ))}
      </ol>
      <ErrorNote error={error ?? plans.error} />

      {step === 0 && (
        <Card title="Organization">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><input className="input" name="orgName" value={org.name} onChange={(e) => setOrg({ name: e.target.value, slug: slugTouched ? org.slug : e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') })} /></Field>
            <Field label="Slug" hint="lowercase letters, digits, dashes"><input className="input" name="orgSlug" value={org.slug} onChange={(e) => { setSlugTouched(true); setOrg({ ...org, slug: e.target.value }); }} /></Field>
          </div>
        </Card>
      )}

      {step === 1 && (
        <Card title="Plan">
          <div className="grid gap-3 md:grid-cols-2">
            {plans.data?.plans.filter((p) => p.active).map((p) => (
              <button key={p.id} type="button" onClick={() => setPlanId(p.id)} data-testid={`plan-${p.code}`}
                className={clsx('rounded-xl border p-3 text-left', planId === p.id ? 'border-brand ring-2 ring-brand/30' : 'border-line hover:bg-muted')}>
                <div className="font-semibold">{p.name} <span className="text-xs text-sub">v{p.version}</span></div>
                <div className="text-xs text-sub">{p.description}</div>
                <div className="mt-2 text-xs">{p.modules.map((m) => PRODUCT_MODULE_DEFS[m as ProductModule]?.name ?? m).join(' · ')}</div>
                <div className="mt-1 text-[11px] text-sub">{Object.entries(p.limits).map(([k, v]) => `${k.replace('MAX_', '').toLowerCase()} ${v}`).join(' · ') || 'no limits'}</div>
              </button>
            ))}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="Status"><select className="input" value={status} onChange={(e) => setStatus(e.target.value as 'ACTIVE' | 'TRIAL')}><option>ACTIVE</option><option>TRIAL</option></select></Field>
            <Field label="Ends (optional)"><input className="input" type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} /></Field>
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card title="Modules">
          <p className="mb-3 text-sm text-sub">The plan's modules are included. Further modules can be granted as an override; their dependencies are added automatically.</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {PRODUCT_MODULES.map((m) => {
              const inPlan = planModules.has(m);
              const on = finalModules.includes(m);
              return (
                <label key={m} className={clsx('flex items-start gap-2 rounded-lg border p-2 text-sm', on ? 'border-brand/40 bg-brand/5' : 'border-line')}>
                  <input type="checkbox" className="mt-0.5 accent-violet-600" checked={on} disabled={inPlan || (on && !extra.has(m))}
                    onChange={() => { const s = new Set(extra); s.has(m) ? s.delete(m) : s.add(m); setExtra(s); }} />
                  <span>
                    <span className="font-medium">{PRODUCT_MODULE_DEFS[m].name}</span>
                    <span className="block text-[11px] text-sub">{inPlan ? 'in plan' : on ? (extra.has(m) ? 'override' : 'added as dependency') : 'not included'}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {added.length > 0 && <div className="mt-3"><Notice>Granted beyond the plan: {added.map((m) => PRODUCT_MODULE_DEFS[m].name).join(', ')}.</Notice></div>}
        </Card>
      )}

      {step === 3 && (
        <Card title="First casino">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Code"><input className="input" name="casinoCode" value={casino.code} onChange={(e) => setCasino({ ...casino, code: e.target.value.toUpperCase() })} placeholder="SAL-001" /></Field>
            <Field label="Name"><input className="input" name="casinoName" value={casino.name} onChange={(e) => setCasino({ ...casino, name: e.target.value })} /></Field>
            <Field label="City"><input className="input" value={casino.city} onChange={(e) => setCasino({ ...casino, city: e.target.value })} /></Field>
            <Field label="Country"><input className="input" value={casino.country} onChange={(e) => setCasino({ ...casino, country: e.target.value })} /></Field>
          </div>
          <p className="mt-2 text-xs text-sub">A vault, a cash desk and a floor are created; money rails start in legacy mode until the customer's cutover.</p>
        </Card>
      )}

      {step === 4 && (
        <Card title="Customer admin user">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Name"><input className="input" name="adminName" value={admin.name} onChange={(e) => setAdmin({ ...admin, name: e.target.value })} /></Field>
            <Field label="Email"><input className="input" name="adminEmail" type="email" value={admin.email} onChange={(e) => setAdmin({ ...admin, email: e.target.value })} /></Field>
            <Field label="Initial password" hint="12+ characters"><input className="input" name="adminPassword" type="password" value={admin.password} onChange={(e) => setAdmin({ ...admin, password: e.target.value })} /></Field>
          </div>
          <div className="mt-4 rounded-lg bg-muted p-3 text-sm">
            Creates <b>{org.name}</b> on <b>{plan?.name}</b> ({status}{endsAt ? ` until ${endsAt}` : ''}) with {finalModules.length} modules, casino <b>{casino.name}</b> and admin <b>{admin.email}</b>.
          </div>
        </Card>
      )}

      {step === 5 && created && (
        <Card title="Machines">
          <p className="mb-3 text-sm text-sub">Organisation and casino created. Register machines (HARD limit of the plan applies).</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Code prefix"><input className="input" value={machines.prefix} placeholder={casino.code} onChange={(e) => setMachines({ ...machines, prefix: e.target.value })} /></Field>
            <Field label="Number of machines"><input className="input" name="machineCount" inputMode="numeric" value={machines.count} onChange={(e) => setMachines({ ...machines, count: e.target.value })} /></Field>
            <div className="flex items-end"><button className="btn w-full" disabled={busy} onClick={addMachines}>Add machines</button></div>
          </div>
          <div className="mt-3 text-sm" data-testid="machines-made">{made} machine(s) registered.</div>
        </Card>
      )}

      {step === 6 && modules && created && (
        <Card title="Configuration: enabled modules">
          <div className="grid gap-2 sm:grid-cols-3">
            {modules.map((m) => (
              <div key={m.module} className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-sm"><span>{m.name}</span><ModuleStateBadge state={m.state} /></div>
            ))}
          </div>
          <p className="mt-3 text-sm text-sub">The customer admin signs in with {admin.email}, sees "Your enabled modules" and "Available upgrades" under Organization, and continues with users, gateways and the money cutover.</p>
          <div className="mt-4 flex gap-2">
            <Link href={`/admin/organizations/${created.orgId}`} className="btn-primary">Open organization</Link>
            <Link href="/admin/onboarding" onClick={() => location.reload()} className="btn">Onboard another</Link>
          </div>
        </Card>
      )}

      <div className="flex justify-between">
        <button className="btn" disabled={step === 0 || step >= 5 || busy} onClick={() => setStep(step - 1)}>Back</button>
        {step < 4 && <button className="btn-primary" disabled={!canNext} onClick={() => setStep(step + 1)}>Next</button>}
        {step === 4 && <button className="btn-primary" disabled={!canNext || busy} onClick={createOrg}>Create organization</button>}
        {step === 5 && <button className="btn-primary" disabled={busy} onClick={finish}>Continue</button>}
      </div>
    </div>
  );
}
