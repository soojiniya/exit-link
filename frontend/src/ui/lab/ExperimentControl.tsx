import { Play, Power, RefreshCw, Square } from 'lucide-react';
import { actions } from '@/api/actions';
import { useApp } from '@/store/store';
import { useNetworkDerived } from '@/store/selectors';
import { NODE_STATUS_LABEL, STATUS_COLOR } from '@/domain/network';
import { Button, Dot, SectionLabel, SourceBadge, cx } from '../primitives';
import { FeedbackLine, needToken, useAction } from './useAction';

/** 실험 프로세스 시작·종료와 노드별 장애·복구. 표시 상태는 실제 관측(useNetworkDerived)입니다. */
export function ExperimentControl({ compact = false }: { compact?: boolean }) {
  const hasToken = useApp((s) => s.hasToken);
  const network = useApp((s) => s.network);
  const { experiment, nodes } = useNetworkDerived();
  const a = useAction();
  const running = experiment?.status === 'running';
  const owned = new Map((experiment?.nodes ?? []).map((n) => [n.node_id, n]));
  const disabledReason = needToken(hasToken) ?? (!experiment?.enabled ? '서버에서 실험 제어가 비활성화되어 있습니다' : undefined);

  return (
    <section>
      <SectionLabel right={<SourceBadge origin="CTRL" />}>TCP 노드 장애 · 복구</SectionLabel>
      <div className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-raised px-3 py-2 text-xs">
        <div className="min-w-0">
          <div>
            실험 <b className="font-mono">{experiment?.status ?? '—'}</b>
            {experiment?.experiment_id && <span className="ml-2 font-mono text-2xs text-ink-3">{experiment.experiment_id.slice(0, 8)}</span>}
          </div>
          <div className="text-[10px] text-ink-3">
            {!experiment?.enabled ? 'EXIT_LINK_ENABLE_EXPERIMENTS 미설정 — 조회만 가능' : `관측 대상: ${network?.configuration_source === 'owned_experiment' ? '실험 소유 노드(임시 포트)' : '프로젝트 기본 포트 9101~9106'}`}
          </div>
          {experiment?.last_error && <div className="text-[10px] text-[#F2878A]">{experiment.last_error}</div>}
        </div>
        {running ? (
          <Button variant="outline" disabled={!!disabledReason || !!a.busy} title={disabledReason} onClick={() => a.exec('stop', actions.stopExperiment, '실험을 종료하고 프로세스를 정리했습니다')}>
            <Square size={12} /> {a.busy === 'stop' ? '종료 중…' : '종료'}
          </Button>
        ) : (
          <Button variant="primary" disabled={!!disabledReason || !!a.busy || experiment?.status === 'starting'} title={disabledReason} onClick={() => a.exec('start', actions.startExperiment, '독립 노드 프로세스 6개를 시작했습니다')}>
            <Play size={12} /> {a.busy === 'start' ? '시작 중…' : '실험 시작(실제 프로세스)'}
          </Button>
        )}
      </div>
      {disabledReason && <p className="-mt-1 mb-3 text-2xs text-ink-3" data-testid="experiment-disabled-reason">실험 시작 불가: {disabledReason}</p>}
      <div className={cx('grid gap-2', compact ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3')} data-testid="lab-node-grid">
        {!nodes.length && <div className="col-span-full text-2xs text-ink-3">노드 관측 정보를 아직 받지 못했습니다.</div>}
        {nodes.map((n) => {
          const o = owned.get(n.id);
          const c = STATUS_COLOR[n.status];
          const alarm = n.status === 'fail' || n.status === 'warn' || n.status === 'recovering';
          return (
            <div
              key={n.id}
              data-testid={`lab-node-${n.id}`}
              data-status={n.status}
              className="flex items-center justify-between gap-2 rounded-xl border px-2.5 py-2 transition"
              style={{ borderColor: alarm ? `${c}66` : 'rgba(255,255,255,0.08)', background: alarm ? `${c}10` : 'rgba(255,255,255,0.02)' }}
            >
              <div className="flex min-w-0 items-center gap-2">
                <Dot color={c} pulse={n.status === 'fail' || n.status === 'recovering'} />
                <div className="min-w-0">
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-mono text-[13px] font-semibold">{n.id}</span>
                    <span className="text-[11px] font-medium" style={{ color: n.status === 'ok' ? '#7CE0B2' : n.status === 'offline' || n.status === 'unknown' ? '#8D98AB' : c }}>{NODE_STATUS_LABEL[n.status]}</span>
                  </div>
                  <div className="truncate text-[10px] text-ink-3" title={n.reason}>
                    TCP {n.reachable === null ? '미관측' : n.reachable ? '응답' : '응답 없음'}
                    {o ? ` · PID ${o.pid}${o.running ? '' : ' · 종료됨'}` : ''}
                  </div>
                </div>
              </div>
              {running && o ? (
                o.running ? (
                  <Button variant="danger" className="h-7 shrink-0 px-2.5" disabled={!hasToken || !!a.busy} title="프로세스 강제 종료" onClick={() => a.exec(n.id, () => actions.failNode(n.id), `${n.id} 프로세스를 종료했습니다 — 장애 확정은 Heartbeat 이벤트로 확인합니다`)}>
                    <Power size={12} /> 장애 주입
                  </Button>
                ) : (
                  <Button variant="outline" className="h-7 shrink-0 px-2.5" disabled={!hasToken || !!a.busy} onClick={() => a.exec(n.id, () => actions.recoverNode(n.id), `${n.id} 재시작 요청 — Heartbeat 재확인을 기다립니다`)}>
                    <RefreshCw size={12} /> 복구
                  </Button>
                )
              ) : null}
            </div>
          );
        })}
      </div>
      {!running && <p className="mt-2 text-2xs text-ink-3">장애·복구 주입은 실험(백엔드 소유 프로세스) 실행 중에만 가능합니다.</p>}
      <FeedbackLine msg={a.msg} />
    </section>
  );
}
