'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { MACHINE_STATUSES } from '@m1/shared';
import { statusColor } from '@m1/ui';
import { api, useApi } from '@/lib/api';
import { useLiveRefresh } from '@/lib/live';
import { useSession } from '@/lib/session';
import { Card, ErrorNote, PageHeader, StatusBadge } from '@/components/ui';
import { FloorMap, type Fixture, type Floor } from '@/components/FloorMap';
import { EventFeed } from '@/components/EventFeed';
import { clsx } from '@/components/clsx';

export default function FloorPage() {
  const { casino, can } = useSession();
  const { data: floors, error, reload } = useApi<Floor[]>(`/floors?casinoId=${casino.id}`);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [floorId, setFloorId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selFixture, setSelFixture] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => setFetchedAt(Date.now()), [floors]);
  useLiveRefresh(() => !editing && void reload(), 3000, ['machine.status', 'alert.created', 'alert.updated']);

  const floor = floors?.find((f) => f.id === floorId) ?? floors?.[0];
  useEffect(() => {
    if (!floor || editing) return;
    setFixtures(floor.layout);
    setPositions({});
  }, [floor, editing]);

  if (!floors || !floor) return <div className="text-sub">{error ? <ErrorNote error={error} /> : 'Loading floor plan...'}</div>;
  const machine = floor.machines.find((m) => m.id === selected);

  const save = async () => {
    setSaving(true);
    try {
      await api(`/floors/${floor.id}/layout`, {
        method: 'PUT',
        json: {
          machines: floor.machines.map((m) => ({ id: m.id, x: positions[m.id]?.x ?? m.pos_x, y: positions[m.id]?.y ?? m.pos_y })),
          fixtures,
        },
      });
      setEditing(false);
      setMsg('Layout saved and recorded in the audit log.');
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const addFixture = () => {
    const label = prompt('Area label (e.g. BAR, CASHIER, STAGE)', 'AREA');
    if (!label) return;
    const f: Fixture = { id: `fx-${Date.now()}`, label: label.toUpperCase().slice(0, 30), kind: 'bar', x: 80, y: 80, w: 220, h: 90 };
    setFixtures((x) => [...x, f]);
    setSelFixture(f.id);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Floor Control"
        subtitle="Live floor plan. Enable edit mode to arrange machines and areas by drag & drop."
        actions={
          can('floor.edit') &&
          (editing ? (
            <>
              <button className="btn" onClick={addFixture}><Plus className="h-4 w-4" /> Area</button>
              {selFixture && (
                <button className="btn" onClick={() => { setFixtures((x) => x.filter((f) => f.id !== selFixture)); setSelFixture(null); }}>
                  <Trash2 className="h-4 w-4" /> Remove area
                </button>
              )}
              <button className="btn" onClick={() => setEditing(false)}><X className="h-4 w-4" /> Cancel</button>
              <button className="btn-primary" onClick={save} disabled={saving}><Save className="h-4 w-4" /> {saving ? 'Saving...' : 'Save layout'}</button>
            </>
          ) : (
            <button className="btn" onClick={() => { setMsg(null); setEditing(true); }}><Pencil className="h-4 w-4" /> Edit layout</button>
          ))
        }
      />
      {msg && <div className="rounded-lg bg-muted px-3 py-2 text-sm">{msg}</div>}

      <div className="flex flex-wrap items-center gap-2">
        {floors.map((f) => (
          <button key={f.id} disabled={editing} onClick={() => { setFloorId(f.id); setSelected(null); }}
            className={clsx('rounded-lg px-3 py-1.5 text-sm font-medium', f.id === floor.id ? 'bg-brand text-white' : 'bg-panel ring-1 ring-line hover:bg-muted')}>
            {f.name} <span className="opacity-70">({f.machines.length})</span>
          </button>
        ))}
        <div className="ml-auto flex flex-wrap gap-3 text-xs text-sub">
          {MACHINE_STATUSES.map((s) => (
            <span key={s} className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: statusColor(s).hex }} />{s}</span>
          ))}
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-4">
        <div className="xl:col-span-3">
          <FloorMap
            floor={floor}
            editing={editing}
            positions={positions}
            fixtures={fixtures}
            onMove={(id, x, y) => setPositions((p) => ({ ...p, [id]: { x, y } }))}
            onMoveFixture={(id, x, y) => { setSelFixture(id); setFixtures((fx) => fx.map((f) => (f.id === id ? { ...f, x, y } : f))); }}
            selected={selected}
            onSelect={setSelected}
            fetchedAt={fetchedAt}
          />
        </div>
        <div className="space-y-6">
          <Card title={machine ? `Machine ${machine.asset_no}` : 'Machine'}>
            {machine ? (
              <div className="space-y-2 text-sm">
                <StatusBadge status={machine.status} />
                <div><span className="text-sub">Manufacturer:</span> {machine.manufacturer}</div>
                <div><span className="text-sub">Game:</span> {machine.game}</div>
                <div><span className="text-sub">Position:</span> {machine.position_label}</div>
                <div><span className="text-sub">Player:</span> {machine.has_player ? 'active session' : 'none'}</div>
                <Link className="btn-primary mt-2 w-full" href={`/machines/${machine.id}`}>Open machine details</Link>
              </div>
            ) : (
              <div className="text-sm text-sub">Click a machine on the floor plan.</div>
            )}
          </Card>
          <Card title="Live Events" bodyClass="max-h-96 overflow-y-auto">
            <EventFeed limit={25} />
          </Card>
        </div>
      </div>
    </div>
  );
}
