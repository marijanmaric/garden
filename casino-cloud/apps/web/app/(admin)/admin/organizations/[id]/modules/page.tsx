'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { ModuleCard, ReasonDialog, type ModuleCardData } from '@/components/admin-ui';
import { useOrg } from '@/components/admin-org';

type Action = { m: ModuleCardData; kind: 'grant' | 'revoke' | 'plan' | 'on' | 'off' };

/**
 * Commercial state (grant / revoke override against the plan) is separate from the customer's switch
 * (on / off) and from the operational rail state, which only the money service changes.
 */
export default function OrgModulesPage() {
  const { id, d, reload } = useOrg();
  const [a, setA] = useState<Action | null>(null);
  if (!d) return <div className="text-sub">Loading...</div>;
  const override = (m: string) => d.overrides.find((o) => o.module_key === m);
  const run = async (reason: string) => {
    if (!a) return;
    if (a.kind === 'on' || a.kind === 'off') await api(`/platform/organizations/${id}/modules/${a.m.module}`, { method: 'PUT', json: { enabled: a.kind === 'on', reason } });
    else await api(`/platform/organizations/${id}/entitlements/${a.m.module}`, { method: 'PUT', json: { entitled: a.kind === 'grant' ? true : a.kind === 'revoke' ? false : null, reason } });
    await reload();
  };
  const label: Record<Action['kind'], string> = { grant: 'Grant', revoke: 'Withhold', plan: 'Back to plan', on: 'Switch on', off: 'Switch off' };
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {d.modules.map((m) => {
          const ov = override(m.module);
          return (
            <ModuleCard key={m.module} m={m} actions={m.module !== 'CORE' && (
              <>
                {!m.purchased && <button className="btn-primary" onClick={() => setA({ m, kind: 'grant' })}>Grant</button>}
                {m.purchased && !ov && <button className="btn" onClick={() => setA({ m, kind: 'revoke' })}>Withhold</button>}
                {ov && <button className="btn" onClick={() => setA({ m, kind: 'plan' })} title={`Override: ${ov.reason}`}>Back to plan</button>}
                {m.purchased && (m.enabled
                  ? <button className="btn" disabled={!m.canDisable} onClick={() => setA({ m, kind: 'off' })}>Switch off</button>
                  : <button className="btn" disabled={!m.canEnable} onClick={() => setA({ m, kind: 'on' })}>Switch on</button>)}
                {ov && <span className="self-center text-[11px] text-sub">override: {ov.entitled ? 'granted' : 'withheld'} ({ov.reason})</span>}
              </>
            )} />
          );
        })}
      </div>
      {a && (
        <ReasonDialog
          title={`${label[a.kind]}: ${a.m.name}`}
          description={a.kind === 'grant' ? `Purchases ${a.m.name} for this organisation beyond its plan.${a.m.requires.length ? ` Requires: ${a.m.requires.join(', ')}.` : ''}` : a.kind === 'revoke' || a.kind === 'plan' ? 'Data is never deleted. Refused while open money items or dependent modules exist.' : undefined}
          confirm={label[a.kind]}
          onClose={() => setA(null)}
          onConfirm={run}
        />
      )}
    </>
  );
}
