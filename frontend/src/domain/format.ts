import type { WsGuidanceReceipt } from '@contracts';

export const ms = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? `${v < 10 ? v.toFixed(1) : Math.round(v)}ms` : '—');
export const routeText = (r?: string[] | null) => (r && r.length ? r.join(' → ') : '—');

export function timeOf(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function ago(iso?: string | null, now = Date.now()) {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  return `${Math.floor(s / 3600)}시간 전`;
}

export const dispositionLabel = (d: WsGuidanceReceipt['disposition']) =>
  ({ applied: '적용됨', stale: '이전 버전', duplicate: '중복', version_conflict: '버전 충돌', publisher_conflict: '발신자 충돌' })[d];

export const reasonLabel = (r: string) =>
  ({ minimum_distance: '최단 거리', start_blocked: '출발지 차단', no_available_exit: '사용 가능한 출구 없음' } as Record<string, string>)[r] ?? r;
