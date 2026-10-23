import { Info } from 'lucide-react';
import { useApp } from '@/store/store';
import { timeOf } from '@/domain/format';
import { cx } from './primitives';

/** 현재 화면이 다루는 기록 범위. 서버 보관 한도는 docs/stage-5-api-guide.md 기준입니다. */
export function RetentionNotice({ compact = false }: { compact?: boolean }) {
  const streamId = useApp((s) => s.streamId);
  const deliveries = useApp((s) => s.deliveryOrder.length);
  const netEvents = useApp((s) => s.netEvents);
  const scenarios = useApp((s) => s.scenarioOrder.length);
  const oldest = netEvents[0]?.payload.timestamp;
  const newest = netEvents.at(-1)?.payload.timestamp;
  return (
    <div className={cx('glass-inset flex items-start gap-2 rounded-xl text-2xs text-ink-3', compact ? 'px-3 py-2' : 'px-4 py-3')}>
      <Info size={14} className="mt-0.5 shrink-0 text-glow/80" />
      <div className="leading-relaxed">
        <span className="text-ink-2">기록 범위: </span>
        백엔드 메모리의 전송 결과 <b className="font-mono text-ink-2">{deliveries}</b>/512건 · 시나리오 <b className="font-mono text-ink-2">{scenarios}</b>/32개 · 통신 이벤트{' '}
        <b className="font-mono text-ink-2">{netEvents.length}</b>건
        {oldest && <> ({timeOf(oldest)} ~ {timeOf(newest)})</>}
        {!compact && (
          <>
            {' '}— 서버의 최근 512개 이벤트 보관 창과 이 탭 연결 이후 수신분입니다. 백엔드를 재시작하면 모두 초기화되며(stream{' '}
            <span className="font-mono">{streamId?.slice(0, 8) ?? '—'}</span>), 영구 저장(SQLite)과 과거 실험 파일 조회 API는 없습니다.
            Heartbeat 상태 변화·송수신 로그 외의 gossip 로그는 스트림에서 제외됩니다.
          </>
        )}
      </div>
    </div>
  );
}
