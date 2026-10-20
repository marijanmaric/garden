'use client';
import { useState } from 'react';
import { formatEuro, formatNumber, timeAgo } from '@m1/ui';
import { ApiError, api, useApi } from '@/lib/api';
import { Card, ErrorNote, Field, Modal, Notice, PageHeader } from '@/components/ui';
import { useSession } from '@/lib/session';
import { PlayerWalletCard, type PlayerLookup } from '@/components/player-wallet';

/** Step 7e: player / card lookup with the CASHLESS wallet (balances and history from the ledger). */
function CardLookup({ initial }: { initial?: string }) {
  const [card, setCard] = useState(initial ?? '');
  const [p, setP] = useState<PlayerLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const look = async (c = card) => {
    setError(null); setP(null);
    if (!c.trim()) return;
    try { setP(await api(`/players/lookup/${encodeURIComponent(c.trim())}`)); } catch (e) { setError(e instanceof ApiError && e.status === 404 ? 'Unknown player card' : (e as Error).message); }
  };
  return (
    <Card title="Player card lookup">
      <form className="mb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void look(); }}>
        <input className="input max-w-xs font-mono" placeholder="Scan or type player card" value={card} onChange={(e) => setCard(e.target.value)} data-testid="player-card-input" />
        <button className="btn-primary" data-testid="player-card-go">Look up</button>
      </form>
      {error && <Notice tone="bad">{error}</Notice>}
      {p && <PlayerWalletCard p={p} />}
    </Card>
  );
}

type Dialog = null | { kind: 'register' } | { kind: 'card'; playerId: string } | { kind: 'verify'; playerId: string; name: string } | { kind: 'cardStatus'; cardId: string; to: 'ACTIVE' | 'BLOCKED' | 'LOST'; card: string };

/** Cage onboarding (player.manage): register, card, identity verification, block / unblock. No money moves here. */
function PlayerDialog({ d, onClose, onDone }: { d: Exclude<Dialog, null>; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<Record<string, string>>({ status: 'VERIFIED', documentType: 'ID_CARD' });
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    setError(null);
    try {
      if (d.kind === 'register') await api('/players', { method: 'POST', json: { profile: { firstName: f.firstName || undefined, lastName: f.lastName || undefined, birthDate: f.birthDate || undefined }, card: f.cardNumber ? { cardNumber: f.cardNumber } : undefined } });
      if (d.kind === 'card') await api(`/players/${d.playerId}/cards`, { method: 'POST', json: { cardNumber: f.cardNumber } });
      if (d.kind === 'verify') await api(`/players/${d.playerId}/verification`, { method: 'POST', json: { status: f.status, method: 'IN_PERSON', documentType: f.documentType, documentNumber: f.documentNumber || undefined, validUntil: f.validUntil || undefined } });
      if (d.kind === 'cardStatus') await api(`/players/cards/${d.cardId}/status`, { method: 'POST', json: { status: d.to, reason: f.reason || undefined } });
      onDone(); onClose();
    } catch (e) { setError((e as Error).message); }
  };
  const title = d.kind === 'register' ? 'Register player' : d.kind === 'card' ? 'Issue card' : d.kind === 'verify' ? `Identity verification: ${d.name}` : `${d.to === 'ACTIVE' ? 'Unblock' : d.to === 'LOST' ? 'Report lost' : 'Block'} card ${d.card}`;
  return (
    <Modal title={title} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }} data-testid="player-dialog">
        {d.kind === 'register' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name"><input className="input" name="firstName" onChange={set('firstName')} /></Field>
            <Field label="Last name"><input className="input" name="lastName" onChange={set('lastName')} /></Field>
            <Field label="Birth date"><input className="input" type="date" name="birthDate" onChange={set('birthDate')} /></Field>
            <Field label="Card number (optional)"><input className="input font-mono" name="cardNumber" onChange={set('cardNumber')} /></Field>
          </div>
        )}
        {d.kind === 'card' && <Field label="Card number"><input className="input font-mono" name="cardNumber" onChange={set('cardNumber')} autoFocus /></Field>}
        {d.kind === 'verify' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Decision"><select className="input" name="status" value={f.status} onChange={set('status')}><option>VERIFIED</option><option>REJECTED</option><option>PENDING</option></select></Field>
            <Field label="Document"><select className="input" value={f.documentType} onChange={set('documentType')}><option value="ID_CARD">ID card</option><option value="PASSPORT">Passport</option><option value="DRIVING_LICENCE">Driving licence</option></select></Field>
            <Field label="Document number" hint="stored masked and hashed only"><input className="input" name="documentNumber" onChange={set('documentNumber')} /></Field>
            <Field label="Valid until"><input className="input" type="date" onChange={set('validUntil')} /></Field>
          </div>
        )}
        {d.kind === 'cardStatus' && <Field label="Reason"><input className="input" name="reason" onChange={set('reason')} /></Field>}
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn-primary">Save</button></div>
      </form>
    </Modal>
  );
}

const TIER: Record<string, string> = { BRONZE: 'text-orange-700 dark:text-orange-400', SILVER: 'text-slate-500', GOLD: 'text-yellow-600', PLATINUM: 'text-cyan-600', VIP: 'text-fuchsia-600' };

export default function PlayersPage() {
  const [search, setSearch] = useState('');
  const { data, error, reload } = useApi<any[]>(`/players${search ? `?search=${encodeURIComponent(search)}` : ''}`, { refreshMs: 5000 });
  const { can } = useSession();
  const manage = can('player.manage');
  const [dialog, setDialog] = useState<Dialog>(null);
  return (
    <div>
      <PageHeader title="Players" subtitle="Player accounts, cards, identity verification and CASHLESS wallets." actions={manage && <button className="btn-primary" onClick={() => setDialog({ kind: 'register' })} data-testid="register-player">Register player</button>} />
      <ErrorNote error={error} />
      <div className="mb-6"><CardLookup /></div>
      <input className="input mb-4 max-w-xs" placeholder="Search name or card..." value={search} onChange={(e) => setSearch(e.target.value)} />
      <Card bodyClass="overflow-x-auto">
        <table className="table">
          <thead><tr><th>Card</th><th>Name</th><th>Status</th><th>Tier</th><th className="text-right">Points</th><th className="text-right">Bets</th><th className="text-right">Visits</th><th>Last visit</th><th>Now playing</th>{manage && <th />}</tr></thead>
          <tbody>
            {data?.map((p) => (
              <tr key={p.id}>
                <td className="font-mono text-xs">{p.card_number}</td>
                <td>{p.first_name} {p.last_name}</td>
                <td className="text-xs">{p.status}{p.card_status && p.card_status !== 'ACTIVE' ? ` · card ${p.card_status}` : ''}<div className="text-sub">ID {p.verification_status?.toLowerCase()}</div></td>
                <td className={`text-xs font-bold ${TIER[p.tier]}`}>{p.tier}</td>
                <td className="text-right tabular-nums">{formatNumber(p.points)}</td>
                <td className="text-right tabular-nums">{formatEuro(p.total_coin_in)}</td>
                <td className="text-right">{p.visits}</td>
                <td className="text-xs text-sub">{timeAgo(p.last_visit_at)}</td>
                <td>{p.current_machine ? <span className="badge bg-sky-500/15 text-sky-600 ring-sky-500/30">{p.current_machine}</span> : ''}</td>
                {manage && (
                  <td className="whitespace-nowrap text-right">
                    {!p.card_id || (p.card_status !== 'ACTIVE' && p.card_status !== 'BLOCKED')
                      ? <button className="btn px-2 py-1 text-xs" onClick={() => setDialog({ kind: 'card', playerId: p.id })}>Issue card</button>
                      : <button className="btn px-2 py-1 text-xs" onClick={() => setDialog({ kind: 'cardStatus', cardId: p.card_id, card: p.card_number, to: p.card_status === 'ACTIVE' ? 'BLOCKED' : 'ACTIVE' })}>{p.card_status === 'ACTIVE' ? 'Block card' : 'Unblock card'}</button>}{' '}
                    <button className="btn px-2 py-1 text-xs" onClick={() => setDialog({ kind: 'verify', playerId: p.id, name: `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || p.player_no })}>Verify ID</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {dialog && <PlayerDialog d={dialog} onClose={() => setDialog(null)} onDone={() => void reload()} />}
    </div>
  );
}
