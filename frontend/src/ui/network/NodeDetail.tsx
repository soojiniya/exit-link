import { useMemo } from 'react';
import { Power, RefreshCw } from 'lucide-react';
import type { Place, WsNetworkView } from '@contracts';
import { useApp } from '@/store/store';
import { actions } from '@/api/actions';
import { NODE_STATUS_LABEL, STATUS_COLOR, type NodeState } from '@/domain/network';
import { toTimeline } from '@/store/timeline';
import { timeOf } from '@/domain/format';
import { Button, Dot, Empty, SectionLabel, SourceBadge, cx } from '../primitives';
import { FeedbackLine, needToken, useAction } from '../lab/useAction';
import { isPublicDemo } from '@/domain/mode';

const NB: Record<string, string> = { up: 'text-[#73C9A0]', suspect: 'text-[#EDAA6B]', down: 'text-[#F2878A]', unknown: 'text-ink-3' };

/** 노드 상세: 실제 관측(NetworkNodeView)과 이 노드 관련 이벤트 로그 */
export function NodeDetail({ node, network, places }: { node: NodeState | null; network: WsNetworkView; places: Map<string, Place> }) {
  const netEvents = useApp((s) => s.netEvents);
  const experiment = useApp((s) => s.experiment);
  const hasToken = useApp((s) => s.hasToken);
  const a = useAction();
  const view = node ? network.nodes.find((n) => n.node_id === node.id) : null;
  const topo = node ? network.topology.nodes.find((n) => n.id === node.id) : null;
  const owned = node ? experiment?.nodes.find((n) => n.node_id === node.id) : null;
  // 다른 노드가 이 노드를 어떻게 보고 있는지(이웃 보고)
  const reportedBy = node
    ? network.nodes.filter((o) => o.node_id !== node.id && o.reachable).flatMap((o) => o.neighbors.filter((nb) => nb.node_id === node.id).map((nb) => ({ by: o.node_id, ...nb })))
    : [];
  const events = useMemo(() => {
    if (!node) return [];
    return netEvents
      .filter((e) => e.payload.node_id === node.id || (e.payload.details as Record<string, unknown>)?.neighbor === node.id)
      .slice(-60)
      .reverse()
      .map((e) => toTimeline(e)!)
      .filter(Boolean);
  }, [netEvents, node]);

  if (!node) return <div className="p-6"><Empty title="토폴로지에서 노드를 선택하세요" /></div>;
  const c = STATUS_COLOR[node.status];
  const running = experiment?.status === 'running';

  return (
    <div className="space-y-6 px-5 py-5">
      <div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Dot color={c} size={10} pulse={node.status === 'fail'} />
            <span className="font-mono text-xl font-semibold">{node.id}</span>
            <span className="text-sm" style={{ color: c }}>{NODE_STATUS_LABEL[node.status]}</span>
          </div>
          <SourceBadge origin="LIVE" />
        </div>
        <dl className="mt-3 grid grid-cols-[88px_1fr] gap-y-1 text-xs">
          <dt className="text-ink-3">위치</dt><dd>{places.get(node.locationId)?.label} <span className="font-mono text-ink-3">{node.locationId}</span></dd>
          <dt className="text-ink-3">판정 근거</dt><dd className="text-ink-2">{node.reason}</dd>
          <dt className="text-ink-3">TCP</dt><dd className="font-mono">{topo?.host}:{topo?.port} · {view ? (view.reachable ? '응답' : '연결 불가') : '미관측'}</dd>
          <dt className="text-ink-3">Heartbeat</dt><dd className="font-mono">{view?.heartbeat_enabled == null ? '—' : view.heartbeat_enabled ? 'enabled' : 'disabled'}</dd>
          <dt className="text-ink-3">관측 시각</dt><dd className="font-mono">{timeOf(view?.observed_at)}</dd>
          <dt className="text-ink-3">프로세스</dt><dd className="font-mono">{owned ? `PID ${owned.pid} · ${owned.running ? 'running' : 'stopped'}` : '실험 소유 아님'}</dd>
          {view?.error && (<><dt className="text-ink-3">오류</dt><dd className="break-words font-mono text-[11px] text-[#F2878A]">{view.error}</dd></>)}
        </dl>
        {running && owned && !isPublicDemo() && (
          <div className="mt-3">
            {owned.running ? (
              <Button variant="danger" disabled={!hasToken || !!a.busy} title={needToken(hasToken)} onClick={() => a.exec('f', () => actions.failNode(node.id), `${node.id} 프로세스를 종료했습니다`)}><Power size={12} /> 장애 주입</Button>
            ) : (
              <Button variant="outline" disabled={!hasToken || !!a.busy} title={needToken(hasToken)} onClick={() => a.exec('r', () => actions.recoverNode(node.id), `${node.id} 재시작 요청`)}><RefreshCw size={12} /> 복구</Button>
            )}
            <FeedbackLine msg={a.msg} />
          </div>
        )}
      </div>

      <div>
        <SectionLabel>이 노드의 Heartbeat 이웃 판정</SectionLabel>
        {!view?.neighbors.length ? (
          <Empty title={view?.reachable ? '이웃 정보 없음' : '노드에 연결할 수 없어 이웃 판정을 읽지 못했습니다'} />
        ) : (
          <table className="w-full text-xs">
            <thead className="text-left text-[10px] text-ink-3"><tr><th className="font-normal">이웃</th><th className="font-normal">상태</th><th className="text-right font-normal">실패</th><th className="text-right font-normal">성공</th></tr></thead>
            <tbody>
              {view.neighbors.map((nb) => (
                <tr key={nb.node_id} className="border-t border-line"><td className="py-1 font-mono">{nb.node_id}</td><td className={cx('font-mono', NB[nb.status])}>{nb.status}</td><td className="text-right font-mono">{nb.failures}</td><td className="text-right font-mono">{nb.successes}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <SectionLabel>다른 노드가 본 {node.id}</SectionLabel>
        {!reportedBy.length ? <Empty title="보고 없음" /> : (
          <div className="flex flex-wrap gap-1.5">
            {reportedBy.map((r) => (
              <span key={r.by} className="rounded-md border border-line px-2 py-1 font-mono text-[11px]">
                {r.by} → <span className={NB[r.status]}>{r.status}</span> <span className="text-ink-3">f{r.failures}/s{r.successes}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {view && view.advertisements.length > 0 && (
        <div>
          <SectionLabel>링크 상태 광고(Advertisement)</SectionLabel>
          <div className="space-y-1">
            {view.advertisements.map((ad) => (
              <div key={ad.origin} className="rounded-md bg-raised px-2 py-1 font-mono text-[10px]">
                <span className="text-ink">{ad.origin}</span> <span className="text-ink-3">seq {ad.sequence} · {timeOf(ad.generated_at)}</span>
                <div className="mt-0.5 flex flex-wrap gap-x-2">{Object.entries(ad.links).map(([k, v]) => <span key={k} className={NB[v]}>{k}:{v}</span>)}</div>
              </div>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-ink-3">epoch는 큰 정수라 비교에 쓰지 않습니다.</p>
        </div>
      )}

      <div>
        <SectionLabel right={<span className="text-[10px] text-ink-3">최근 {events.length}건</span>}>이벤트 로그</SectionLabel>
        {!events.length ? <Empty title="이 세션에서 수신한 이벤트 없음" /> : (
          <ul className="space-y-1">
            {events.map((t) => (
              <li key={t.id} className="flex gap-2 text-[11px]">
                <span className="w-[62px] shrink-0 font-mono text-[10px] text-ink-3">{timeOf(t.at)}</span>
                <span className={cx(t.severity === 'fail' ? 'text-[#F2878A]' : t.severity === 'warn' ? 'text-[#EDAA6B]' : t.severity === 'ok' ? 'text-ink' : 'text-ink-2')}>{t.title}{t.detail ? <span className="text-ink-3"> · {t.detail}</span> : null}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
