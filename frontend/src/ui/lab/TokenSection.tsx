import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { setControlToken } from '@/api/client';
import { actions } from '@/api/actions';
import { useApp } from '@/store/store';
import { Button, SectionLabel } from '../primitives';
import { FeedbackLine, useAction } from './useAction';

export function TokenSection() {
  const hasToken = useApp((s) => s.hasToken);
  const [input, setInput] = useState('');
  const a = useAction();
  return (
    <section>
      <SectionLabel>제어 토큰</SectionLabel>
      <p className="mb-2 text-2xs leading-relaxed text-ink-3">
        서버 실행 시 만든 <code className="font-mono">EXIT_LINK_CONTROL_TOKEN</code>(32자 이상)을 입력합니다. 이 탭의 메모리에만 보관되며 새로고침하면 사라집니다.
      </p>
      {hasToken ? (
        <div className="flex items-center justify-between rounded-lg border border-action/30 bg-action/5 px-3 py-2 text-xs">
          <span className="flex items-center gap-2 text-action"><KeyRound size={14} /> 토큰 적용됨 (메모리)</span>
          <Button onClick={() => setControlToken(null)}>해제</Button>
        </div>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setControlToken(input);
            setInput('');
            // 토큰 확인: 부작용이 가장 적은 쓰기 요청(재관측)으로 검증합니다.
            void a.exec('t', actions.refreshNetwork, '토큰 확인 완료(재관측 요청 성공)').then((r) => {
              if (!r.ok && (r.code === 'write_unauthorized' || r.status === 403)) setControlToken(null);
            });
          }}
        >
          <input
            type="password"
            autoComplete="off"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="토큰 붙여넣기"
            aria-label="제어 토큰"
            className="h-8 min-w-0 flex-1 rounded-full border border-line bg-raised px-3 font-mono text-xs outline-none focus:border-ink-3"
          />
          <Button type="submit" variant="primary" disabled={input.trim().length < 32}>적용</Button>
        </form>
      )}
      <FeedbackLine msg={a.msg} />
    </section>
  );
}
