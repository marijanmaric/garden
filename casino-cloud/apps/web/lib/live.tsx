'use client';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { StreamMessage } from '@m1/shared';
import { apiBase, getToken } from './api';
import { useSession } from './session';

type Listener = (msg: StreamMessage) => void;
export type LiveEvent = Extract<StreamMessage, { kind: 'machine.event' }>['event'] & { receivedAt: number };

interface LiveValue {
  connected: boolean;
  events: LiveEvent[];
  subscribe: (fn: Listener) => () => void;
}

const Ctx = createContext<LiveValue>({ connected: false, events: [], subscribe: () => () => {} });
export const useLive = () => useContext(Ctx);

/** Calls `fn` (throttled) whenever relevant realtime messages arrive. */
export function useLiveRefresh(fn: () => void, ms = 2000, kinds?: StreamMessage['kind'][]) {
  const { subscribe } = useLive();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = subscribe((msg) => {
      if (kinds && !kinds.includes(msg.kind)) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        fnRef.current();
      }, ms);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, ms, kinds?.join()]);
}

/** One SSE connection per selected casino, shared by all pages. Reconnects automatically. */
export function LiveProvider({ children }: { children: React.ReactNode }) {
  const { casino } = useSession();
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const listeners = useRef(new Set<Listener>());
  const subscribe = useRef((fn: Listener) => {
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  }).current;

  useEffect(() => {
    setEvents([]);
    const token = getToken();
    if (!token) return;
    const es = new EventSource(`${apiBase()}/api/v1/stream?token=${encodeURIComponent(token)}&casinoId=${casino.id}`);
    es.addEventListener('ready', () => setConnected(true));
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      const msg = JSON.parse(e.data) as StreamMessage;
      if (msg.kind === 'machine.event') setEvents((prev) => [{ ...msg.event, receivedAt: Date.now() }, ...prev].slice(0, 150));
      listeners.current.forEach((fn) => fn(msg));
    };
    return () => {
      es.close();
      setConnected(false);
    };
  }, [casino.id]);

  return <Ctx.Provider value={{ connected, events, subscribe }}>{children}</Ctx.Provider>;
}
