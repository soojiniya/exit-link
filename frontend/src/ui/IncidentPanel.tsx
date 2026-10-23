import { ArrowRight, CheckCircle2, CircleDashed, CircleHelp, Send, X, XCircle } from 'lucide-react';
import type { Place, WsEvacuationPlan } from '@contracts';
import { useApp } from '@/store/store';
import { useActiveScenario, useLatestDelivery, useNetworkDerived } from '@/store/selectors';
import { NODE_STATUS_LABEL, STATUS_COLOR, type NodeStatus } from '@/domain/network';
import { ago, dispositionLabel, ms, reasonLabel, timeOf } from '@/domain/format';
import { useNow } from './TopBar';
import { Button, Chip, Dot, Empty, SectionLabel, SourceBadge, cx } from './primitives';

function Divider() {
  return <div className="hairline my-5" />;
}

export function IncidentPanel({ highlightStart, onHighlightStart }: { highlightStart: string | null; onHighlightStart: (s: string | null) => void }) {
  const now = useNow();
  const scenario = useActiveScenario();
  const building = useApp((s) => s.building);
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const setControlOpen = useApp((s) => s.setControlOpen);
  const timeline = useApp((s) => s.timeline);
  const { network, nodes, latestFlow, experiment } = useNetworkDerived();
  const delivery = useLatestDelivery(scenario?.state.scenario_id);
  const places = new Map<string, Place>((building?.building.nodes ?? []).map((n) => [n.id, n]));
  const label = (id: string) => places.get(id)?.label ?? id;

  const h = scenario?.state.hazards;
  const fire = h?.fire_locations ?? [];
  const title = !scenario ? '활성 시나리오 없음' : fire.length ? `화재 · ${label(fire[0])}` : h && (h.blocked_nodes.length || h.dangerous_nodes.length) ? '위험 구역 지정' : '위험 없음';
  const sev = fire.length ? 'CRITICAL' : h && (h.blocked_nodes.length || h.dangerous_nodes.length) ? 'WARNING' : 'NORMAL';

  const counts = nodes.reduce<Record<NodeStatus, number>>((a, n) => ((a[n.status] += 1), a), { ok: 0, warn: 0, fail: 0, recovering: 0, unknown: 0, offline: 0 });
  const recent = timeline.filter((t) => t.severity === 'fail' || t.severity === 'warn' || t.severity === 'action' || t.kind === 'route.changed').slice(-5).reverse();
  const selNode = selection?.kind === 'node' ? nodes.find((n) => n.id === selection.id) : null;
  const selView = selNode ? network?.nodes.find((n) => n.node_id === selNode.id) : null;
  const owned = selNode ? experiment?.nodes.find((n) => n.node_id === selNode.id) : null;

  return (
    <aside className="glass-chrome panel-scroll relative z-10 flex h-full w-[320px] shrink-0 flex-col border-l xl:w-[380px]" aria-label="재난 및 통신 상세">
      <div className="flex-1 px-6 py-5">
        {/* 선택한 노드 */}
        {selNode && (
          <div className="glass-inset mb-5 rounded-2xl p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Dot color={STATUS_COLOR[selNode.status]} size={9} />
                <span className="font-mono text-sm font-semibold">{selNode.id}</span>
                <span className="text-xs" style={{ color: STATUS_COLOR[selNode.status] }}>{NODE_STATUS_LABEL[selNode.status]}</span>
              </div>
              <button className="text-ink-3 hover:text-ink" onClick={() => select(null)} aria-label="선택 해제"><X size={14} /></button>
            </div>
            <dl className="grid grid-cols-[72px_1fr] gap-y-1 text-2xs">
              <dt className="text-ink-3">위치</dt><dd>{label(selNode.locationId)} <span className="font-mono text-ink-3">{selNode.locationId}</span></dd>
              <dt className="text-ink-3">판정 근거</dt><dd className="text-ink-2">{selNode.reason}</dd>
              <dt className="text-ink-3">관측 시각</dt><dd className="font-mono">{timeOf(selNode.observedAt)}</dd>
              {owned && (<><dt className="text-ink-3">프로세스</dt><dd className="font-mono">PID {owned.pid} · {owned.running ? 'running' : 'stopped'}</dd></>)}
            </dl>
            {selView && selView.neighbors.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1">
                {selView.neighbors.map((nb) => (
                  <Chip key={nb.node_id} tone={nb.status === 'up' ? 'ok' : nb.status === 'down' ? 'fail' : nb.status === 'suspect' ? 'warn' : 'neutral'}>
                    <span className="font-mono">{nb.node_id}</span> {nb.status}
                  </Chip>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 1. 재난 상황 */}
        <div className="mb-1 flex items-center gap-2">
          <SourceBadge origin="SIM" />
          {scenario && <span className={cx('pill font-mono text-[10px] font-semibold tracking-[0.12em]', sev === 'CRITICAL' ? 'border-fail/45 bg-fail/15 text-[#FF9EA1] shadow-[0_0_14px_-4px_rgba(239,90,95,0.8)]' : sev === 'WARNING' ? 'border-warn/45 bg-warn/15 text-[#F4BB87]' : 'text-ink-3')}>{sev}</span>}
        </div>
        <h1 className="text-[22px] font-semibold leading-tight tracking-tight">{title}</h1>
        {scenario ? (
          <dl className="mt-3 grid grid-cols-[84px_1fr] gap-y-1.5 text-xs">
            <dt className="text-ink-3">시나리오</dt><dd className="font-mono">{scenario.state.scenario_id.slice(0, 8)} · rev {scenario.state.revision}</dd>
            <dt className="text-ink-3">갱신</dt><dd>{timeOf(scenario.state.updated_at)} <span className="text-ink-3">({ago(scenario.state.updated_at, now)})</span></dd>
            <dt className="text-ink-3">건물</dt><dd className="font-mono text-ink-2">{scenario.state.building_id}</dd>
          </dl>
        ) : (
          <p className="mt-2 text-xs text-ink-3">상단의 제어 버튼에서 토큰을 입력한 뒤 시나리오를 생성하세요.</p>
        )}

        {/* 2. 위험 구역 */}
        {h && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {h.fire_locations.map((id) => <Chip key={`f${id}`} tone="fail">화재 <span className="font-mono">{id}</span></Chip>)}
            {h.dangerous_nodes.map((id) => <Chip key={`d${id}`} tone="warn">위험 <span className="font-mono">{id}</span></Chip>)}
            {h.blocked_nodes.map((id) => <Chip key={`b${id}`} tone="fail">차단 <span className="font-mono">{id}</span></Chip>)}
            {h.blocked_passages.map((p) => <Chip key={`p${p.source}${p.target}`} tone="fail">통로 차단 <span className="font-mono">{p.source}–{p.target}</span></Chip>)}
            {!h.fire_locations.length && !h.dangerous_nodes.length && !h.blocked_nodes.length && !h.blocked_passages.length && <Chip>지정된 위험 구역 없음</Chip>}
          </div>
        )}

        <Divider />

        {/* 3. 통신 상태 */}
        <SectionLabel right={<SourceBadge origin="LIVE" />}>통신 노드 상태</SectionLabel>
        {!network ? (
          <Empty title="네트워크 관측 대기 중" />
        ) : (
          <>
            <div className="mb-3 grid grid-cols-3 gap-2">
              <Stat label="정상" value={`${counts.ok}/${nodes.length}`} color="#3FB27F" />
              <Stat label="의심·복구" value={String(counts.warn + counts.recovering)} color="#E08A3C" />
              <Stat label="장애" value={String(counts.fail)} color="#E5484D" />
            </div>
            {(counts.offline > 0 || counts.unknown > 0) && (
              <p className="mb-2 text-2xs text-ink-3">
                {counts.offline > 0 && `미실행 ${counts.offline}개(실험 미시작 또는 노드 미기동)`} {counts.unknown > 0 && `미관측 ${counts.unknown}개`}
              </p>
            )}
            <div className="grid grid-cols-6 gap-1">
              {nodes.map((n) => (
                <button
                  key={n.id}
                  title={`${n.id} · ${NODE_STATUS_LABEL[n.status]} · ${n.reason}`}
                  onClick={() => select({ kind: 'node', id: n.id })}
                  className={cx('flex flex-col items-center gap-1 rounded-md border py-1.5', selection?.kind === 'node' && selection.id === n.id ? 'border-ink-3 bg-raised' : 'border-line hover:bg-raised')}
                >
                  <Dot color={STATUS_COLOR[n.status]} pulse={n.status === 'fail'} />
                  <span className="font-mono text-[10px]">{n.id}</span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-2xs text-ink-3">
              {network.observation_status === 'observed' ? `마지막 TCP 관측 ${timeOf(network.observed_at)}` : network.observation_status === 'error' ? `관측 오류: ${network.monitor_error}` : '아직 관측되지 않음'} · 토폴로지 {network.configuration_source}
            </p>
          </>
        )}

        <Divider />

        {/* 4. 메시지 전달 경로 */}
        <SectionLabel right={<SourceBadge origin="LIVE" />}>현재 메시지 전달 경로</SectionLabel>
        {!latestFlow ? (
          <Empty title="이 세션에서 관측한 메시지 경로가 없습니다" hint="안내를 전송하면 route_selected 이벤트로 표시됩니다" />
        ) : (
          <div>
            {latestFlow.previousRoute && (
              <div className="mb-2 rounded-lg border border-fail/30 bg-fail/5 px-3 py-2">
                <div className="text-2xs font-semibold text-[#F2878A]">경로 전환 {latestFlow.previousReason === 'retry' ? '(재시도)' : '(직전 메시지 대비)'}</div>
                <div className="mt-1 font-mono text-2xs text-ink-3 line-through">{latestFlow.previousRoute.join(' → ')}</div>
              </div>
            )}
            <RouteSteps route={latestFlow.route} hops={latestFlow.hops} />
            <div className="mt-2 flex items-center gap-2 text-2xs text-ink-3">
              <StageBadge stage={latestFlow.stage} /> 시도 {latestFlow.attempt}회차 · {timeOf(latestFlow.updatedAt)} · <span className="font-mono">{latestFlow.messageId.slice(0, 8)}</span>
            </div>
          </div>
        )}

        <Divider />

        {/* 5. 긴급 대피 안내 */}
        <SectionLabel right={<SourceBadge origin="SIM" />}>긴급 대피 안내</SectionLabel>
        {!scenario || !scenario.plans.length ? (
          <Empty title="계산된 대피 경로가 없습니다" />
        ) : (
          <div className="space-y-2">
            {scenario.plans.map((p) => (
              <PlanCard key={p.start_location} plan={p} label={label} active={highlightStart === p.start_location} onClick={() => onHighlightStart(highlightStart === p.start_location ? null : p.start_location)} />
            ))}
            <p className="text-2xs text-ink-3">가정 거리(m_assumed) 기반 Dijkstra 결과이며 실제 안전을 검증하지 않습니다.</p>
          </div>
        )}

        <Divider />

        {/* 6. ACK·적용 여부 */}
        <SectionLabel right={<SourceBadge origin="LIVE" />}>안내 전달·적용 상태</SectionLabel>
        {!delivery ? (
          <Empty title="이 시나리오로 전송한 안내가 없습니다" />
        ) : (
          <div className="glass-inset rounded-2xl p-3">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="font-mono">{delivery.source_node} → {delivery.destination_node} · {delivery.audience_id}</span>
              <span className="text-2xs text-ink-3">{timeOf(delivery.observed_at)}</span>
            </div>
            <StatusRow ok={delivery.ack_received} label="ACK 수신" detail={delivery.transport_result?.ack ? `경로 ${delivery.transport_result.ack.route.join('→')}` : delivery.transport_error ?? undefined} />
            <StatusRow
              ok={delivery.transport_result ? delivery.transport_result.success : false}
              label="전송 결과"
              detail={delivery.transport_result ? `재시도 ${delivery.transport_result.retries} · ${ms(delivery.transport_result.elapsed_ms)}` : '결과 없음'}
            />
            <StatusRow
              ok={delivery.application_receipt ? delivery.application_receipt.disposition === 'applied' : null}
              label="안내 적용"
              detail={delivery.application_receipt ? `${dispositionLabel(delivery.application_receipt.disposition)} · rev ${delivery.application_receipt.received_scenario_revision}/v${delivery.application_receipt.received_route_version}` : delivery.receipt_query_error ? `미확인 · ${delivery.receipt_query_error}` : '미확인'}
            />
            {delivery.transport_result && delivery.transport_result.attempts.length > 1 && (
              <div className="mt-2 border-t border-line pt-2">
                {delivery.transport_result.attempts.map((a) => (
                  <div key={a.number} className="flex justify-between font-mono text-[10px] text-ink-3">
                    <span>#{a.number} {a.route.join('→')}</span>
                    <span className={a.outcome === 'ack' ? 'text-ok' : 'text-fail'}>{a.outcome}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-2 text-[10px] text-ink-3">ACK는 사람의 대피 완료를 뜻하지 않습니다.</p>
          </div>
        )}

        <Divider />

        {/* 7. 최근 장애·경로 변경 */}
        <SectionLabel>최근 장애 · 경로 변경</SectionLabel>
        {recent.length === 0 ? (
          <Empty title="기록 없음" />
        ) : (
          <ul className="space-y-1.5">
            {recent.map((t) => (
              <li key={t.id} className="flex gap-2 text-xs">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: t.severity === 'fail' ? '#E5484D' : t.severity === 'warn' ? '#E08A3C' : t.severity === 'action' ? '#7CC8FF' : '#3FB27F' }} />
                <div className="min-w-0">
                  <div className="truncate">{t.title}</div>
                  <div className="font-mono text-[10px] text-ink-3">{timeOf(t.at)} · {t.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="sticky bottom-0 flex gap-2 border-t border-white/10 bg-[#0a0f18]/90 px-6 py-4 backdrop-blur">
        <Button variant="outline" className="flex-1" onClick={() => setControlOpen(true)}>관제 제어</Button>
        <Button variant="primary" className="flex-1" onClick={() => setControlOpen(true)} disabled={!scenario?.plans.length}>
          <Send size={13} /> 안내 전송
        </Button>
      </div>
    </aside>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="glass-inset rounded-xl px-3 py-2">
      <div className="text-[10px] text-ink-3">{label}</div>
      <div className="font-mono text-lg font-medium" style={{ color }}>{value}</div>
    </div>
  );
}

function RouteSteps({ route, hops }: { route: string[]; hops: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {route.map((n, i) => (
        <span key={`${n}${i}`} className="flex items-center gap-1.5">
          <span className={cx('rounded-md border px-2 py-1 font-mono text-xs', hops.includes(n) ? 'border-action/60 bg-action/10 text-action' : 'border-line text-ink-2')}>{n}</span>
          {i < route.length - 1 && <ArrowRight size={12} className="text-ink-3" />}
        </span>
      ))}
    </div>
  );
}

function StageBadge({ stage }: { stage: string }) {
  const m: Record<string, [string, string]> = {
    routing: ['경로 계산', '#6B727C'],
    sending: ['전송 중', '#7CC8FF'],
    delivered: ['수신 확인', '#7CC8FF'],
    acked: ['ACK 수신', '#3FB27F'],
    failed: ['전송 실패', '#E5484D'],
  };
  const [t, c] = m[stage] ?? [stage, '#6B727C'];
  return <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold" style={{ color: c, background: `${c}1f` }}>{t}</span>;
}

function StatusRow({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string }) {
  const Icon = ok === null ? CircleHelp : ok ? CheckCircle2 : XCircle;
  const color = ok === null ? '#6B727C' : ok ? '#3FB27F' : '#E5484D';
  return (
    <div className="flex items-start gap-2 py-1">
      <Icon size={14} style={{ color }} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-xs">{label}</div>
        {detail && <div className="break-words font-mono text-[10px] text-ink-3">{detail}</div>}
      </div>
    </div>
  );
}

function PlanCard({ plan, label, active, onClick }: { plan: WsEvacuationPlan; label: (id: string) => string; active: boolean; onClick: () => void }) {
  if (plan.status === 'no_route') {
    return (
      <button onClick={onClick} className="w-full rounded-xl border border-fail/40 bg-fail/10 p-3 text-left">
        <div className="flex items-center gap-2 text-xs font-semibold text-[#F2878A]"><XCircle size={14} /> {label(plan.start_location)} — 대피 경로 없음</div>
        <div className="mt-1 text-2xs text-ink-3">사유: {reasonLabel(plan.reason)} · v{plan.route_version}</div>
      </button>
    );
  }
  return (
    <button onClick={onClick} className={cx('w-full rounded-xl border p-3 text-left transition', active ? 'border-ok/60 bg-ok/10' : 'border-line bg-raised/50 hover:border-[#3d434b]')}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold">{label(plan.start_location)}</span>
        <span className="font-mono text-xs text-ok">{plan.exit_id} · {plan.distance_m}m</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1 font-mono text-[10px] text-ink-2">
        {plan.path.map((p, i) => (
          <span key={p} className="flex items-center gap-1">
            {p}
            {i < plan.path.length - 1 && <CircleDashed size={6} className="text-ok" />}
          </span>
        ))}
      </div>
      <div className="mt-1 text-[10px] text-ink-3">경로 v{plan.route_version} · {timeOf(plan.calculated_at)} · {reasonLabel(plan.reason)}</div>
    </button>
  );
}
