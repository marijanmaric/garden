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

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${apiBase()}/api/v1${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
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
