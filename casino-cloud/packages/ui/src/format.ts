const eur = new Intl.NumberFormat('de-AT', { style: 'currency', currency: 'EUR' });
const eur0 = new Intl.NumberFormat('de-AT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const num = new Intl.NumberFormat('de-AT');

export const formatEuro = (n: number | null | undefined, compact = false) => (compact ? eur0 : eur).format(Number(n ?? 0));
export const formatNumber = (n: number | null | undefined) => num.format(Number(n ?? 0));

export function formatTime(iso: string | Date) {
  return new Date(iso).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDateTime(iso: string | Date | null | undefined) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('de-AT', { dateStyle: 'short', timeStyle: 'medium' });
}

export function timeAgo(iso: string | Date | null | undefined) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
