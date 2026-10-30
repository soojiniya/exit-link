import type { ApiError, Operations } from '@contracts';
import { isPublicDemo } from '@/domain/mode';

/**
 * docs/contracts/stage5/types.ts의 Operations 매핑을 그대로 사용하는 REST 클라이언트.
 * URL·필드명은 계약 파일 기준이며 임의로 바꾸지 않습니다.
 */
export const API_ORIGIN: string = (import.meta.env?.VITE_API_ORIGIN as string | undefined) ?? 'http://127.0.0.1:8000';
export const WS_URL: string = API_ORIGIN.replace(/^http/, 'ws') + '/ws/v1/events';

// 제어 토큰은 메모리에만 보관합니다(localStorage·소스·빌드에 저장하지 않음).
let controlToken: string | null = null;
const tokenListeners = new Set<(has: boolean) => void>();
const httpStatuses = new WeakMap<object, number>();
export const httpStatusOf = (data: unknown): number | undefined =>
  data !== null && typeof data === 'object' ? httpStatuses.get(data) : undefined;
export const setControlToken = (t: string | null) => {
  // 공개 데모는 읽기 전용입니다: 제어 토큰을 받지도, 보관하지도 않습니다.
  controlToken = !isPublicDemo() && t && t.trim() ? t.trim() : null;
  tokenListeners.forEach((fn) => fn(controlToken !== null));
};
export const hasControlToken = () => controlToken !== null;
export const onTokenChange = (fn: (has: boolean) => void) => {
  tokenListeners.add(fn);
  return () => tokenListeners.delete(fn);
};

export type OpKey = keyof Operations;
type PathOf<K extends OpKey> = Operations[K] extends { path: infer P } ? { path: P } : { path?: never };
type QueryOf<K extends OpKey> = Operations[K] extends { query: infer Q } ? { query: Q } : { query?: never };
type BodyOf<K extends OpKey> = Operations[K] extends { body: infer B } ? { body: B } : { body?: never };
export type OpArgs<K extends OpKey> = PathOf<K> & QueryOf<K> & BodyOf<K>;
export type OpResponse<K extends OpKey> = Operations[K]['response'];

export class ApiRequestError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function call<K extends OpKey>(op: K, args: OpArgs<K> = {} as OpArgs<K>): Promise<OpResponse<K>> {
  const [method, template] = (op as string).split(' ') as [string, string];
  const a = args as { path?: Record<string, string | number>; query?: Record<string, unknown>; body?: unknown };
  let url = template.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(String(a.path?.[k] ?? '')));
  if (a.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(a.query)) if (v !== null && v !== undefined) qs.set(k, String(v));
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  const headers: Record<string, string> = {};
  if (a.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    if (isPublicDemo()) throw new ApiRequestError(0, 'public_read_only', '공개 데모는 읽기 전용입니다. 저장된 실험 기록은 REPLAY에서 확인하세요.');
    if (!controlToken) throw new ApiRequestError(0, 'token_missing', '제어 토큰이 없어 읽기 전용입니다.');
    headers['X-Exit-Link-Token'] = controlToken;
  }
  let res: Response;
  try {
    res = await fetch(API_ORIGIN + url, { method, headers, body: a.body !== undefined ? JSON.stringify(a.body) : undefined });
  } catch (e) {
    throw new ApiRequestError(0, 'network_error', `백엔드에 연결할 수 없습니다 (${API_ORIGIN}). ${(e as Error).message}`);
  }
  if (!res.ok) {
    let code = `http_${res.status}`;
    let message = res.statusText;
    try {
      const err = (await res.json()) as Partial<ApiError> & { detail?: unknown };
      if (err.detail && typeof err.detail === 'object' && 'code' in err.detail) {
        code = (err.detail as { code: string }).code;
        message = (err.detail as { message: string }).message;
      } else if (err.detail) message = JSON.stringify(err.detail);
    } catch {
      /* 본문 없음 */
    }
    throw new ApiRequestError(res.status, code, message);
  }
  const data = await res.json();
  if (data !== null && typeof data === 'object') httpStatuses.set(data, res.status);
  return data as OpResponse<K>;
}
