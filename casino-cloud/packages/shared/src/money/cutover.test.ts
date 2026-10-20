import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_KINDS, ACCOUNT_KIND_KEYS } from './accounts';
import { ACCOUNT_KIND_RAIL, CUTOVER_PREREQUISITES, CUTOVER_RAILS, LEGACY_CASH_TX_RAILS } from './cutover';
import { CASH_TX_TYPES } from '../cash';

test('cutover order is acyclic and complete', () => {
  const done = new Set<string>();
  for (let round = 0; round < CUTOVER_RAILS.length; round++)
    for (const r of CUTOVER_RAILS) if (CUTOVER_PREREQUISITES[r].every((p) => done.has(p))) done.add(r);
  assert.equal(done.size, CUTOVER_RAILS.length);
});

test('every money-holding account kind belongs to exactly one rail; suspense and P&L kinds to none', () => {
  const unowned = ACCOUNT_KIND_KEYS.filter((k) => !ACCOUNT_KIND_RAIL[k] && ['ASSET', 'LIABILITY'].includes(ACCOUNT_KINDS[k].class));
  assert.deepEqual(unowned.sort(), ['BANK_CLEARING', 'CARD_SETTLEMENT_RECEIVABLE', 'CASHLESS_EXCEPTION', 'LEGACY_FLOOR_CLEARING', 'TITO_EXCEPTION']);
  assert.ok(!ACCOUNT_KIND_RAIL.OPENING_EQUITY && !ACCOUNT_KIND_RAIL.GAMING_RESULT);
});

test('every legacy cash transaction type is mapped to the rails it moves money on', () => {
  assert.deepEqual(Object.keys(LEGACY_CASH_TX_RAILS).sort(), Object.keys(CASH_TX_TYPES).sort());
  for (const rails of Object.values(LEGACY_CASH_TX_RAILS)) assert.ok(rails.includes('CASH'));
});

test('F3 dependencies: HANDPAY and TITO need CASH only as a workflow; the payout medium is per payment', async () => {
  const { RAIL_IMPLEMENTATION_REQUIRES, CUTOVER_PREREQUISITES, CUTOVER_WORKFLOW_PREREQUISITES, railRelease, railReleaseBlockers } = await import('./cutover');
  const { MONEY_TRANSACTIONS, postings } = await import('./transactions');
  const { ACCOUNT_KIND_RAIL } = await import('./cutover');
  // A: derived from the posting matrix: every rail a HANDPAY posting touches, per payout medium
  const touched = (payTo: 'CASH' | 'WALLET' | 'TICKET') => {
    const t = new Set<string>();
    for (const type of ['HANDPAY_CREATE_JACKPOT', 'HANDPAY_PAY'] as const)
      for (const p of postings(type, { casinoId: 'c', amountCents: 100 as never, machineId: 'm', handpayId: 'h', cashierSessionId: 's', walletId: 'w', ticketId: 't', payTo }))
        if (ACCOUNT_KIND_RAIL[p.account.kind]) t.add(ACCOUNT_KIND_RAIL[p.account.kind]!);
    return [...t].sort();
  };
  assert.deepEqual(touched('CASH'), ['CASH', 'HANDPAY']);
  assert.deepEqual(touched('WALLET'), ['CASHLESS', 'HANDPAY']);
  assert.deepEqual(touched('TICKET'), ['HANDPAY', 'TITO']);
  assert.ok(MONEY_TRANSACTIONS.HANDPAY_PAY.rail === 'HANDPAY');
  assert.deepEqual([...RAIL_IMPLEMENTATION_REQUIRES.HANDPAY], []);
  assert.deepEqual([...RAIL_IMPLEMENTATION_REQUIRES.TITO], []);
  // B: unconditional prerequisites vs. workflow prerequisites (only where the other rail is in use)
  assert.deepEqual(CUTOVER_PREREQUISITES, { VAULT: [], CASH: ['VAULT'], HANDPAY: [], TITO: [], CASHLESS: [], MACHINE: ['VAULT', 'CASHLESS'] });
  assert.deepEqual(CUTOVER_WORKFLOW_PREREQUISITES, { VAULT: [], CASH: [], HANDPAY: ['CASH'], TITO: ['CASH'], CASHLESS: [], MACHINE: ['TITO', 'HANDPAY'] });
  // C: the maintenance window is complete since 7c
  const r = railRelease('HANDPAY');
  assert.deepEqual([r.implementationMissing, r.windowMissing, r.released], [[], [], true]);
  assert.deepEqual(railReleaseBlockers('HANDPAY'), []);
  assert.deepEqual(railRelease('CASHLESS').released, true);
});

test('F3: a ticket payout is only for a handpay; HANDPAY_PAY to a ticket needs the ticket', async () => {
  const { postings } = await import('./transactions');
  const base = { casinoId: 'c', amountCents: 500 as never, machineId: 'm', handpayId: 'h', payTo: 'TICKET' as const };
  assert.deepEqual(postings('HANDPAY_PAY', { ...base, ticketId: 't' }).map((p) => `${p.account.kind}${p.amountCents > 0 ? '+' : '-'}${Math.abs(p.amountCents)}`), ['HANDPAY_PAYABLE+500', 'TICKET_LIABILITY-500']);
  assert.throws(() => postings('HANDPAY_PAY', base), /ticket required/);
  assert.throws(() => postings('TITO_REDEEM_CASHIER', { casinoId: 'c', amountCents: 500 as never, ticketId: 't', cashierSessionId: 's', payTo: 'TICKET' }), /only for a handpay/);
});

test('7c/7d: the maintenance window VAULT, CASH, HANDPAY, TITO is released; MACHINE is released per machine since 7d', async () => {
  const { RAIL_PRODUCTION_READY, railRelease, maintenanceWindowOf } = await import('./cutover');
  assert.deepEqual([...maintenanceWindowOf('TITO')], ['VAULT', 'CASH', 'HANDPAY', 'TITO']);
  for (const rail of ['VAULT', 'CASH', 'HANDPAY', 'TITO'] as const) assert.equal(railRelease(rail).released, true, rail);
  assert.deepEqual([...maintenanceWindowOf('MACHINE')], ['MACHINE']);
  assert.deepEqual(railRelease('MACHINE'), { rail: 'MACHINE', implementationMissing: [], cutoverPrerequisites: ['VAULT', 'CASHLESS'], windowMissing: [], released: true });
  assert.deepEqual([...RAIL_PRODUCTION_READY], ['VAULT', 'CASH', 'HANDPAY', 'TITO', 'CASHLESS', 'MACHINE']);
});

test('7c: TITO postings touch TICKET_LIABILITY and CASH / CASHLESS / MACHINE, or the D1 clearing of a legacy machine', async () => {
  const { postings } = await import('./transactions');
  const base = { casinoId: 'c', amountCents: 250 as never, machineId: 'm', ticketId: 't', cashierSessionId: 's', walletId: 'w' };
  const kinds = (type: Parameters<typeof postings>[0], extra: Record<string, unknown> = {}) => postings(type, { ...base, ...extra }).map((p) => `${p.account.kind}${p.amountCents > 0 ? '+' : '-'}`);
  assert.deepEqual(kinds('TITO_ISSUE_MACHINE'), ['MACHINE_CREDIT+', 'TICKET_LIABILITY-']);
  assert.deepEqual(kinds('TITO_ISSUE_MACHINE', { floorClearing: true }), ['LEGACY_FLOOR_CLEARING+', 'TICKET_LIABILITY-']);
  assert.deepEqual(kinds('TITO_REDEEM_MACHINE', { floorClearing: true }), ['TICKET_LIABILITY+', 'LEGACY_FLOOR_CLEARING-']);
  assert.deepEqual(kinds('TITO_EXCEPTION', { floorClearing: true, ticketId: undefined }), ['TITO_EXCEPTION+', 'LEGACY_FLOOR_CLEARING-']);
  assert.deepEqual(kinds('TITO_ISSUE_CASHIER'), ['DRAWER+', 'TICKET_LIABILITY-']);
  assert.deepEqual(kinds('TITO_ISSUE_CASHIER', { payFrom: 'WALLET' }), ['WALLET_AVAILABLE+', 'TICKET_LIABILITY-']);
  assert.deepEqual(kinds('TITO_REDEEM_CASHIER'), ['TICKET_LIABILITY+', 'DRAWER-']);
  assert.deepEqual(kinds('TITO_REDEEM_CASHIER', { payTo: 'WALLET' }), ['TICKET_LIABILITY+', 'WALLET_AVAILABLE-']);
  assert.deepEqual(kinds('TITO_EXPIRY'), ['TICKET_LIABILITY+', 'EXPIRED_TICKET_INCOME-']);
  assert.deepEqual(kinds('TITO_CANCEL'), ['TICKET_LIABILITY+', 'TITO_ADJUSTMENT-']);
  // the clearing account is per machine and never belongs to a rail
  assert.equal(ACCOUNT_KINDS.LEGACY_FLOOR_CLEARING.owner, 'MACHINE');
  assert.equal(ACCOUNT_KIND_RAIL.LEGACY_FLOOR_CLEARING, undefined);
});

test('7c rail matrix: every HANDPAY and TITO posting touches only its own rail, its (workflow) dependencies, CASHLESS (wallet option) and the machine side', async () => {
  const { postings, MONEY_TRANSACTIONS } = await import('./transactions');
  const { RAIL_IMPLEMENTATION_REQUIRES, CUTOVER_WORKFLOW_PREREQUISITES } = await import('./cutover');
  const variants = [{}, { payTo: 'WALLET' }, { payFrom: 'WALLET' }, { floorClearing: true }];
  for (const [type, def] of Object.entries(MONEY_TRANSACTIONS)) {
    if (def.rail !== 'HANDPAY' && def.rail !== 'TITO') continue;
    const own = def.rail;
    const allowed = new Set<string>([own, ...RAIL_IMPLEMENTATION_REQUIRES[own], ...CUTOVER_WORKFLOW_PREREQUISITES[own], 'CASHLESS', 'MACHINE']);
    for (const v of variants)
      for (const p of postings(type as never, { casinoId: 'c', amountCents: 100 as never, machineId: 'm', ticketId: 't', handpayId: 'h', cashierSessionId: 's', walletId: 'w', ...v } as never)) {
        const rail = ACCOUNT_KIND_RAIL[p.account.kind];
        if (rail) assert.ok(allowed.has(rail), `${type} touches ${rail}`);
      }
  }
  // HANDPAY touches TITO only as a voucher payout (variant not listed above), TITO never touches HANDPAY
  for (const [type, def] of Object.entries(MONEY_TRANSACTIONS))
    for (const v of variants)
      if (def.rail === 'HANDPAY' || def.rail === 'TITO')
        for (const p of postings(type as never, { casinoId: 'c', amountCents: 100 as never, machineId: 'm', ticketId: 't', handpayId: 'h', cashierSessionId: 's', walletId: 'w', ...v } as never))
          assert.notEqual(ACCOUNT_KIND_RAIL[p.account.kind], def.rail === 'HANDPAY' ? 'TITO' : 'HANDPAY', type);
});
