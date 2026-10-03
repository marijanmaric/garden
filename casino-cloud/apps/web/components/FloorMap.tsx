'use client';
import { useMemo, useRef, useState } from 'react';
import { statusColor } from '@m1/ui';
import { useLive } from '@/lib/live';

export interface FloorMachine { id: string; asset_no: string; manufacturer: string; game: string; status: string; pos_x: number; pos_y: number; position_label: string; has_player: boolean }
export interface Fixture { id: string; label: string; kind: string; x: number; y: number; w: number; h: number }
export interface Floor { id: string; name: string; width: number; height: number; layout: Fixture[]; machines: FloorMachine[] }

const TW = 88;
const TH = 68;
const GRID = 10;
const snap = (n: number) => Math.round(n / GRID) * GRID;

const FIXTURE_FILL: Record<string, string> = { bar: '#8b5cf6', cashier: '#0ea5e9', entrance: '#64748b' };

interface Props {
  floor: Floor;
  editing: boolean;
  positions: Record<string, { x: number; y: number }>;
  fixtures: Fixture[];
  onMove: (id: string, x: number, y: number) => void;
  onMoveFixture: (id: string, x: number, y: number) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  fetchedAt: number;
}

export function FloorMap({ floor, editing, positions, fixtures, onMove, onMoveFixture, selected, onSelect, fetchedAt }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ kind: 'machine' | 'fixture'; id: string; dx: number; dy: number } | null>(null);
  const { events } = useLive();
  const [, force] = useState(0);

  // Newer live events override the last fetched status; recent events make a tile flash.
  const live = useMemo(() => {
    const status: Record<string, string> = {};
    const flash = new Set<string>();
    const now = Date.now();
    for (const e of events) {
      if (e.receivedAt > fetchedAt && !(e.assetNo in status)) status[e.assetNo] = e.status;
      if (now - e.receivedAt < 1200) flash.add(e.assetNo);
    }
    return { status, flash };
  }, [events, fetchedAt]);

  const toSvg = (e: React.PointerEvent) => {
    const pt = svg.current!.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    return pt.matrixTransform(svg.current!.getScreenCTM()!.inverse());
  };

  const start = (e: React.PointerEvent, kind: 'machine' | 'fixture', id: string, x: number, y: number) => {
    if (!editing) return;
    e.stopPropagation();
    const p = toSvg(e);
    drag.current = { kind, id, dx: p.x - x, dy: p.y - y };
    svg.current!.setPointerCapture(e.pointerId);
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toSvg(e);
    const x = Math.max(0, Math.min(floor.width, snap(p.x - d.dx)));
    const y = Math.max(0, Math.min(floor.height, snap(p.y - d.dy)));
    if (d.kind === 'machine') onMove(d.id, x, y);
    else onMoveFixture(d.id, x, y);
    force((n) => n + 1);
  };

  const end = () => {
    drag.current = null;
  };

  return (
    <svg
      ref={svg}
      viewBox={`0 0 ${floor.width} ${floor.height}`}
      className="w-full touch-none select-none rounded-xl border border-line bg-muted/40"
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onClick={() => onSelect(null)}
    >
      <defs>
        <pattern id="grid" width={40} height={40} patternUnits="userSpaceOnUse">
          <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgb(var(--line))" strokeWidth={1} />
        </pattern>
      </defs>
      <rect width={floor.width} height={floor.height} fill={editing ? 'url(#grid)' : 'transparent'} />
      <text x={20} y={34} className="fill-sub" fontSize={18} fontWeight={700} letterSpacing={3}>
        {floor.name.toUpperCase()}
      </text>

      {fixtures.map((f) => (
        <g key={f.id} onPointerDown={(e) => start(e, 'fixture', f.id, f.x, f.y)} style={{ cursor: editing ? 'move' : 'default' }}>
          <rect x={f.x} y={f.y} width={f.w} height={f.h} rx={14} fill={FIXTURE_FILL[f.kind] ?? '#64748b'} opacity={0.15} stroke={FIXTURE_FILL[f.kind] ?? '#64748b'} strokeDasharray="6 4" />
          <text x={f.x + f.w / 2} y={f.y + f.h / 2 + 6} textAnchor="middle" fontSize={18} fontWeight={700} letterSpacing={4} fill={FIXTURE_FILL[f.kind] ?? '#64748b'}>
            {f.label}
          </text>
        </g>
      ))}

      {floor.machines.map((m) => {
        const pos = positions[m.id] ?? { x: m.pos_x, y: m.pos_y };
        const status = live.status[m.asset_no] ?? m.status;
        const c = statusColor(status);
        const isSel = selected === m.id;
        return (
          <g
            key={m.id}
            transform={`translate(${pos.x - TW / 2} ${pos.y - TH / 2})`}
            onPointerDown={(e) => start(e, 'machine', m.id, pos.x, pos.y)}
            onClick={(e) => {
              e.stopPropagation();
              if (!editing) onSelect(m.id);
            }}
            style={{ cursor: editing ? 'move' : 'pointer' }}
          >
            {live.flash.has(m.asset_no) && <rect x={-6} y={-6} width={TW + 12} height={TH + 12} rx={14} fill="none" stroke={c.hex} strokeWidth={3} className="animate-flash" />}
            <rect width={TW} height={TH} rx={10} fill="rgb(var(--panel))" stroke={isSel ? 'rgb(var(--brand))' : c.hex} strokeWidth={isSel ? 4 : 2.5} />
            <rect width={TW} height={8} rx={4} fill={c.hex} />
            <text x={TW / 2} y={37} textAnchor="middle" fontSize={18} fontWeight={800} fill="rgb(var(--fg))">
              {m.asset_no}
            </text>
            <text x={TW / 2} y={56} textAnchor="middle" fontSize={11} fill="rgb(var(--sub))">
              {m.manufacturer}
            </text>
            {m.has_player && <circle cx={TW - 9} cy={18} r={4} fill="#0ea5e9"><title>Player active</title></circle>}
            <title>{`${m.asset_no} · ${m.manufacturer} · ${m.game} · ${status}`}</title>
          </g>
        );
      })}
    </svg>
  );
}
