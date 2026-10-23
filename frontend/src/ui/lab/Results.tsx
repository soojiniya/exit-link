import { useMemo, useState } from 'react';
import { ArrowRight, CheckCircle2, CircleDashed, CircleHelp, XCircle } from 'lucide-react';
import { actions } from '@/api/actions';
import { useApp } from '@/store/store';
import { useActiveScenario } from '@/store/selectors';
import { latestFailover } from '@/domain/failover';
import { dispositionLabel, ms, reasonLabel, timeOf } from '@/domain/format';
import type { Delivery, LabRecord } from '@/store/types';
import { Button, Chip, Empty, SectionLabel, SourceBadge, cx } from '../primitives';
import { FeedbackLine, needToken, useAction } from './useAction';

/** 시나리오 목록과 선택. 서버 메모리 기준이며 재시작하면 비워집니다. */
export function ScenarioList() {
  const order = useApp((s) => s.scenarioOrder);
  const scenarios = useApp((s) => s.scenarios);
  const active = useApp((s) => s.activeScenarioId);
  const setActive = useApp((s) => s.setActiveScenario);
  return (
    <section>
      <SectionLabel right={<span className="text-2xs text-ink-3">{order.length}/32</span>}>시나리오</SectionLabel>
      {!order.length ? (
        <Empty title="서버에 시나리오가 없습니다" hint="아래에서 생성하세요" />
      ) : (
        <div className="space-y-1.5">
          {[...order].reverse().map((id) => {
            const sc = scenarios[id];
            const h = sc.state.hazards;
            const noRoute = sc.plans.filter((p) => p.status === 'no_route').length;
            return (
              <button key={id} onClick={() => setActive(id)} className={cx('w-full rounded-lg border px-3 py-2 text-left transition', active === id ? 'border-action/60 bg-action/5' : 'border-line hover:border-[#3d434b]')}>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs">#{order.indexOf(id) + 1} · {id.slice(0, 8)}</span>
                  <span className="font-mono text-2xs text-ink-3">rev {sc.state.revision}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
                  {h.fire_locations.map((x) => <span key={x} className="text-[#F2878A]">화재 {x}</span>)}
                  {h.blocked_nodes.length > 0 && <span className="text-[#d79a9c]">차단 {h.blocked_nodes.length}</span>}
                  {h.blocked_passages.length > 0 && <span className="text-[#d79a9c]">통로 {h.blocked_passages.length}</span>}
                  <span className="text-ink-3">경로 {sc.plans.length - noRoute}/{sc.plans.length}</span>
                  {noRoute > 0 && <span className="text-[#F2878A]">경로 없음 {noRoute}</span>}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** 대피 경로 결과(재계산 포함)와 출발지 추가 */
export function PlanResults() {
  const scenario = useActiveScenario();
  const building = useApp((s) => s.building);
  const hasToken = useApp((s) => s.hasToken);
  const a = useAction();
  const [start, setStart] = useState('');
  if (!scenario) return null;
  const used = new Set(scenario.plans.map((p) => p.start_location));
  const candidates = (building?.building.nodes ?? []).filter((p) => p.kind !== 'exit' && !used.has(p.id));
  return (
    <section>
      <SectionLabel right={<SourceBadge origin="SIM" />}>대피 경로 계산 결과</SectionLabel>
      <div className="space-y-2">
        {scenario.plans.map((p) => (
          <div key={p.start_location} className={cx('rounded-lg border px-3 py-2', p.status === 'no_route' ? 'border-fail/40 bg-fail/10' : 'border-line')}>
            <div className="flex items-center justify-between text-xs">
              <span className="font-mono">{p.start_location}</span>
              {p.status === 'route_found' ? (
                <span className="font-mono text-ok">{p.exit_id} · {p.distance_m}m</span>
              ) : (
                <span className="flex items-center gap-1 text-[#F2878A]"><XCircle size={12} /> 경로 없음 · {reasonLabel(p.reason)}</span>
              )}
            </div>
            {p.status === 'route_found' && <div className="mt-1 font-mono text-[10px] text-ink-2">{p.path.join(' → ')}</div>}
            <div className="mt-1 flex flex-wrap gap-1">
              {p.candidates.map((c) => (
                <span key={c.exit_id} className={cx('rounded border px-1 font-mono text-[10px]', c.status === 'available' ? 'border-ok/30 text-[#73C9A0]' : 'border-fail/30 text-[#F2878A]')}>
                  {c.exit_id} {c.status}{c.distance_m != null ? ` ${c.distance_m}m` : ''}
                </span>
              ))}
              <span className="text-[10px] text-ink-3">v{p.route_version} · rev {p.scenario_revision} · {timeOf(p.calculated_at)}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <select value={start} onChange={(e) => setStart(e.target.value)} className="h-8 flex-1 rounded-md border border-line bg-raised px-2 font-mono text-xs" aria-label="추가할 출발지">
          <option value="">출발지 추가…</option>
          {candidates.map((p) => <option key={p.id} value={p.id}>{p.id} · {p.label}</option>)}
        </select>
        <Button disabled={!start || !hasToken || !!a.busy} title={needToken(hasToken)} onClick={() => a.exec('p', () => actions.addPlan(scenario.state.scenario_id, start), (p) => (p.status === 'route_found' ? `${start}: ${p.exit_id}까지 ${p.distance_m}m` : { bad: true, text: `${start}: 대체 경로 없음(${reasonLabel(p.reason)})` })).then(() => setStart(''))}>
          경로 계산
        </Button>
      </div>
      <FeedbackLine msg={a.msg} />
    </section>
  );
}

function Status({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string | null }) {
  const Icon = ok === null ? CircleHelp : ok ? CheckCircle2 : XCircle;
  return (
    <div className="flex items-start gap-1.5">
      <Icon size={12} className="mt-0.5 shrink-0" style={{ color: ok === null ? '#6B727C' : ok ? '#3FB27F' : '#E5484D' }} />
      <span className="text-[11px]">{label}{detail && <span className="ml-1 font-mono text-[10px] text-ink-3">{detail}</span>}</span>
    </div>
  );
}

export function DeliveryCard({ d }: { d: Delivery }) {
  const tr = d.transport_result;
  return (
    <div className="rounded-lg border border-line px-3 py-2">
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="font-mono">{d.source_node} → {d.destination_node} · {d.audience_id}</span>
        <span className="font-mono text-[10px] text-ink-3">{timeOf(d.observed_at)} · {d.message_id.slice(0, 8)}</span>
      </div>
      <div className="grid grid-cols-3 gap-1">
        <Status ok={d.ack_received} label="ACK" />
        <Status ok={tr ? tr.success : false} label="전송" detail={tr ? `${ms(tr.elapsed_ms)} · 재시도 ${tr.retries}` : d.transport_error ? '오류' : null} />
        <Status ok={d.application_receipt ? d.application_receipt.disposition === 'applied' : null} label={d.application_receipt ? dispositionLabel(d.application_receipt.disposition) : '적용 미확인'} />
      </div>
      {tr && (
        <div className="mt-1.5 space-y-0.5">
          {tr.attempts.map((at) => (
            <div key={at.number} className="flex items-center justify-between font-mono text-[10px]">
              <span className="text-ink-2">#{at.number} {at.route.join('→')}</span>
              <span className={at.outcome === 'ack' ? 'text-ok' : 'text-[#F2878A]'}>{at.outcome} · {ms(at.duration_ms)}</span>
            </div>
          ))}
        </div>
      )}
      {d.transport_error && <div className="mt-1 break-words font-mono text-[10px] text-[#F2878A]">{d.transport_error}</div>}
      {d.receipt_query_error && <div className="mt-1 break-words font-mono text-[10px] text-ink-3">receipt 조회 오류: {d.receipt_query_error}</div>}
    </div>
  );
}

/** 이 시나리오로 보낸 안내의 실제 전송 결과(최근 512개 보관 창) */
export function DeliveryList({ limit = 6 }: { limit?: number }) {
  const scenario = useActiveScenario();
  const deliveries = useApp((s) => s.deliveries);
  const order = useApp((s) => s.deliveryOrder);
  const list = useMemo(() => order.map((id) => deliveries[id]).filter((d) => !scenario || d.scenario_id === scenario.state.scenario_id).slice(-limit).reverse(), [order, deliveries, scenario, limit]);
  return (
    <section>
      <SectionLabel right={<SourceBadge origin="LIVE" />}>전송 결과</SectionLabel>
      {!list.length ? <Empty title="이 시나리오로 보낸 안내가 없습니다" /> : <div className="space-y-2">{list.map((d) => <DeliveryCard key={d.message_id} d={d} />)}</div>}
      <p className="mt-2 text-[10px] text-ink-3">ACK는 사람의 대피 완료를 뜻하지 않습니다(human_evacuation_verified=false).</p>
    </section>
  );
}

/** 장애 → 감지 → 대체 경로 → 전달 → 복구 단계 추적 */
export function FailoverTracker() {
  const netEvents = useApp((s) => s.netEvents);
  const labLog = useApp((s) => s.labLog);
  const ep = useMemo(() => latestFailover(netEvents, labLog), [netEvents, labLog]);
  return (
    <section>
      <SectionLabel right={<SourceBadge origin="LIVE" />}>장애 후 대체 경로 전환 과정</SectionLabel>
      {!ep ? (
        <Empty title="관측된 장애가 없습니다" hint="실험 실행 중 노드에 장애를 주입하면 단계별로 기록됩니다" />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <Chip tone="fail">장애 노드 <span className="font-mono">{ep.node}</span></Chip>
            {ep.previousRoute && <span className="font-mono text-[11px] text-[#F2878A] line-through">{ep.previousRoute.join('→')}</span>}
            {ep.previousRoute && ep.newRoute && <ArrowRight size={12} className="text-ink-3" />}
            {ep.newRoute && <span className="font-mono text-[11px] text-action">{ep.newRoute.join('→')}</span>}
          </div>
          <ol className="relative ml-1.5 border-l border-line">
            {ep.steps.map((s) => (
              <li key={s.key} className="mb-2.5 ml-4">
                <span className={cx('absolute -left-[5px] mt-1 h-2.5 w-2.5 rounded-full border', s.at ? 'border-action bg-action' : 'border-line bg-base')} />
                <div className="flex items-center justify-between text-xs">
                  <span className={s.at ? 'text-ink' : 'text-ink-3'}>{s.title}</span>
                  <span className="font-mono text-[10px] text-ink-3">{s.at ? timeOf(s.at) : '대기'}{s.deltaMs != null ? ` · +${Math.round(s.deltaMs)}ms` : ''}</span>
                </div>
                {(s.detail || s.by) && <div className="text-[10px] text-ink-3">{s.by ? `${s.by} · ` : ''}{s.detail}</div>}
              </li>
            ))}
          </ol>
          <p className="text-[10px] text-ink-3">+ms는 노드 프로세스 로그 시각끼리의 차이입니다. 브라우저 요청 시각과는 비교하지 않습니다.</p>
        </>
      )}
    </section>
  );
}

const KIND_LABEL: Record<LabRecord['kind'], string> = { scenario: '시나리오', hazard: '위험', plan: '경로', guidance: '안내', experiment: '실험', node: '노드', network: '관측' };

/** 실험 단계 기록: 이 탭에서 실행한 제어 요청과 HTTP 결과, 관측 결과 요약 */
export function LabLog() {
  const log = useApp((s) => s.labLog);
  return (
    <section className="flex h-full min-h-0 flex-col">
      <SectionLabel right={<span className="text-2xs text-ink-3">이 탭에서 실행한 {log.length}건 · 새로고침 시 초기화</span>}>실험 단계 기록</SectionLabel>
      {!log.length ? (
        <Empty title="아직 실행한 단계가 없습니다" />
      ) : (
        <div className="panel-scroll min-h-0 flex-1">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-panel text-left text-[10px] text-ink-3">
              <tr>
                <th className="w-8 py-1 font-normal">#</th>
                <th className="w-[70px] font-normal">시각</th>
                <th className="w-14 font-normal">구분</th>
                <th className="font-normal">단계</th>
                <th className="w-16 font-normal">HTTP</th>
                <th className="font-normal">결과</th>
              </tr>
            </thead>
            <tbody>
              {log.map((r, i) => (
                <tr key={r.id} className="border-t border-line align-top">
                  <td className="py-1.5 font-mono text-[10px] text-ink-3">{i + 1}</td>
                  <td className="py-1.5 font-mono text-[10px] text-ink-3">{timeOf(r.at)}</td>
                  <td className="py-1.5 text-[11px] text-ink-2">{KIND_LABEL[r.kind]}</td>
                  <td className="py-1.5">
                    {r.label}
                    {r.target && <div className="font-mono text-[10px] text-ink-3">{r.target}</div>}
                  </td>
                  <td className={cx('py-1.5 font-mono text-[11px]', r.ok ? 'text-ok' : 'text-[#F2878A]')}>{r.ok ? '200' : r.status || 'ERR'}</td>
                  <td className="py-1.5 pr-2">
                    {r.ok ? (
                      <span className={cx('text-[11px]', r.observed === 'bad' ? 'text-[#F2878A]' : 'text-ink-2')}>
                        {r.observed === 'bad' && <XCircle size={11} className="mr-1 inline" />}
                        {r.observed === 'good' && <CircleDashed size={11} className="mr-1 inline text-ok" />}
                        {r.summary}
                      </span>
                    ) : (
                      <span className="text-[11px] text-[#F2878A]">{r.code} — {r.message}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
