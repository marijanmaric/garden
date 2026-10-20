'use client';
import { useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Card, Notice, PageHeader } from '@/components/ui';
import { LedgerHandpays } from '@/components/ledger-cashier';
import { FreezeBanner, RailBadge, useOperatorContext } from '@/components/money-ui';

/**
 * F3: handpays of a casino without a cash desk (e.g. TITO + HANDPAY): approval and payout as a TITO voucher
 * or into the player's wallet. With Cash the same list is part of the cashier workstation.
 */
export default function HandpaysPage() {
  const { can, sees } = useSession();
  const ctx = useOperatorContext();
  const shift = useApi<any>(sees('cash') ? '/cashier/shift' : null, { refreshMs: 5000 });
  const ledger = ctx.data?.rails.HANDPAY === 'LEDGER';
  return (
    <div className="space-y-6">
      <PageHeader
        title="Handpays"
        subtitle="Jackpots that need an attendant: approval (four eyes above the limit) and payout. Every payment is a ledger booking."
        actions={ctx.data && <span className="text-xs text-sub">HANDPAY rail <RailBadge mode={ctx.data.rails.HANDPAY} /></span>}
      />
      <FreezeBanner freezes={ctx.data?.freezes} rails={['HANDPAY', 'TITO']} />
      {ctx.data && !ledger && <Notice>The HANDPAY rail is still in legacy mode: handpays are paid at the cashier until the HANDPAY cutover.</Notice>}
      {ctx.data && ledger && can('cash.transact') && (
        <Card title="Pending handpays"><LedgerHandpays ctx={ctx.data} shift={shift.data ?? null} reload={() => void shift.reload()} /></Card>
      )}
    </div>
  );
}
