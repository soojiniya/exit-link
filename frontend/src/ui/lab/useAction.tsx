import { useState } from 'react';
import type { ActionResult } from '@/api/actions';
import { cx } from '../primitives';

export type Feedback = { ok: boolean; text: string } | null;

/** 버튼 단위 진행 상태와 결과 메시지. 요청 자체와 기록은 api/actions.ts가 담당합니다. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Feedback>(null);
  /** okText가 { bad: true }를 돌려주면 HTTP는 성공했지만 관측 결과가 실패인 경우(예: ACK 없음)로 표시합니다. */
  const exec = async <T,>(key: string, fn: () => Promise<ActionResult<T>>, okText: string | ((d: T) => string | { text: string; bad?: boolean })) => {
    setBusy(key);
    setMsg(null);
    const r = await fn();
    setBusy(null);
    if (r.ok) {
      const t = typeof okText === 'function' ? okText(r.data) : okText;
      setMsg(typeof t === 'string' ? { ok: true, text: t } : { ok: !t.bad, text: t.text });
    } else setMsg({ ok: false, text: `${r.status ? `${r.status} · ` : ''}${r.code} — ${r.message}` });
    return r;
  };
  return { busy, msg, exec, setMsg };
}

export function FeedbackLine({ msg }: { msg: Feedback }) {
  if (!msg) return null;
  return <div role="status" className={cx('mt-2 rounded-md px-2.5 py-1.5 text-2xs leading-relaxed', msg.ok ? 'bg-ok/10 text-[#73C9A0]' : 'bg-fail/10 text-[#F2878A]')}>{msg.text}</div>;
}

export function needToken(hasToken: boolean) {
  return hasToken ? undefined : '제어 토큰이 필요합니다';
}
