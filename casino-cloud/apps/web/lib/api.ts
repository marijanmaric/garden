'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

const TOKEN_KEY = 'm1-token';

/** API base: NEXT_PUBLIC_API_URL, otherwise the same host on port 4000 (works for localhost and LAN tablets). */
export function apiBase(): string {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  if (typeof window === 'undefined') return 'http://localhost:4000';
  return `${window.location.protocol}//${window.location.hostname}:4000`;
}

export const getToken = () => (typeof window === 'undefined' ? null : localStorage.getItem(TOKEN_KEY));
export const setToken = (t: string | null) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Random idempotency key. Uses getRandomValues, which also works on plain-http LAN tablets. */
export function newIdempotencyKey(prefix = 'k'): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Money / cashier actions. The API requires an Idempotency-Key on these. */
const MONEY_ROUTE = /^\/(tickets\/(redeem|issue|[^/]+\/(cancel|void|reprint|adjust))|cashier\/(session\/(open|close)|transactions|handpays\/[^/]+)|cash\/collections|transactions\/adjustments)$/;

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const { json, idempotencyKey, ...rest } = init;
  const headers: Record<string, string> = { ...(rest.headers as Record<string, string>) };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (json !== undefined) headers['content-type'] = 'application/json';
  const isMoney = (rest.method ?? 'GET').toUpperCase() === 'POST' && MONEY_ROUTE.test(path);
  if (isMoney) headers['idempotency-key'] = idempotencyKey ?? newIdempotencyKey();

  // Money calls are retried on network failure with the SAME key, so a lost response never books twice.
  let res: Response | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${apiBase()}/api/v1${path}`, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body });
      break;
    } catch (err) {
      if (!isMoney || attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && token) {
    setToken(null);
    if (typeof window !== 'undefined' && !location.pathname.startsWith('/login')) location.href = '/login';
  }
  if (!res.ok) throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  return body as T;
}

/** Minimal data hook: fetch on mount / key change, optional polling, manual reload. */
export function useApi<T = any>(path: string | null, opts: { refreshMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const pathRef = useRef(path);
  pathRef.current = path;

  const reload = useCallback(async () => {
    const p = pathRef.current;
    if (!p) return;
    try {
      const d = await api<T>(p);
      if (pathRef.current === p) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(!!path);
    void reload();
    if (!opts.refreshMs || !path) return;
    const t = setInterval(reload, opts.refreshMs);
    return () => clearInterval(t);
  }, [path, opts.refreshMs, reload]);

  return { data, error, loading, reload, setData };
}

/** Downloads an authenticated file (e.g. report export) and saves it in the browser. */
export async function download(path: string, fallbackName: string) {
  const res = await fetch(`${apiBase()}/api/v1${path}`, { headers: { authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
