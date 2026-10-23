import { useEffect, useState } from 'react';
import { Send } from 'lucide-react';
import { actions } from '@/api/actions';
import { useApp } from '@/store/store';
import { useActiveScenario } from '@/store/selectors';
import { Button, SectionLabel, SourceBadge } from '../primitives';
import { FeedbackLine, needToken, useAction } from './useAction';

const SELECT = 'h-8 w-full rounded-md border border-line bg-raised px-2 font-mono text-xs';

/**
 * 대피 안내 전송: send_guidance → ReliableSend → 독립 TCP 노드 → ACK/GuidanceReceipt.
 * HTTP 200은 전달 성공이 아니므로 결과 문구도 ACK·전송 결과·적용 상태로 만듭니다.
 */
export function GuidanceForm({ showAdvanced = false }: { showAdvanced?: boolean }) {
  const hasToken = useApp((s) => s.hasToken);
  const network = useApp((s) => s.network);
  const experiment = useApp((s) => s.experiment);
  const scenario = useActiveScenario();
  const a = useAction();
  const plans = scenario?.plans ?? [];
  const nodes = network?.topology.nodes ?? [];
  const [start, setStart] = useState('');
  const [src, setSrc] = useState('N1');
  const [dst, setDst] = useState('');
  const [ttl, setTtl] = useState('');
  const [retries, setRetries] = useState('');
  const [timeout, setTimeoutS] = useState('');

  useEffect(() => {
    if (!plans.find((p) => p.start_location === start)) setStart(plans[0]?.start_location ?? '');
  }, [plans, start]);
  useEffect(() => {
    const at = nodes.find((n) => n.location_id === start);
    if (at) setDst(at.id);
    else if (!dst && nodes.length) setDst(nodes.at(-1)!.id);
  }, [start, nodes.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const plan = plans.find((p) => p.start_location === start);
  const reason =
    needToken(hasToken) ??
    (!scenario ? '활성 시나리오가 없습니다' : !plans.length ? '계산된 경로가 없습니다' : src === dst ? '발신·수신 노드가 같습니다' : undefined);
  const num = (v: string) => (v.trim() === '' ? undefined : Number(v));

  return (
    <section>
      <SectionLabel right={<SourceBadge origin="LIVE" />}>대피 안내 전송 (실제 TCP)</SectionLabel>
      <div className="grid grid-cols-3 gap-2 text-2xs">
        <label className="space-y-1">
          <span className="text-ink-3">대상 위치</span>
          <select value={start} onChange={(e) => setStart(e.target.value)} className={SELECT} disabled={!plans.length} aria-label="대상 위치">
            {plans.map((p) => <option key={p.start_location}>{p.start_location}</option>)}
          </select>
          <span className="block text-[10px] leading-snug text-ink-3">활성 시나리오의 대피 경로 출발지</span>
        </label>
        <label className="space-y-1">
          <span className="text-ink-3">발신 노드</span>
          <select value={src} onChange={(e) => setSrc(e.target.value)} className={SELECT} aria-label="발신 노드">
            {nodes.map((n) => <option key={n.id}>{n.id}</option>)}
          </select>
          <span className="block text-[10px] leading-snug text-ink-3">메시지를 보내는 TCP 노드</span>
        </label>
        <label className="space-y-1">
          <span className="text-ink-3">수신 노드</span>
          <select value={dst} onChange={(e) => setDst(e.target.value)} className={SELECT} aria-label="수신 노드">
            {nodes.map((n) => <option key={n.id}>{n.id}</option>)}
          </select>
          <span className="block text-[10px] leading-snug text-ink-3">대상 위치의 노드(있으면 자동 선택)</span>
        </label>
      </div>
      {showAdvanced && (
        <div className="mt-2 grid grid-cols-3 gap-2 text-2xs">
          {[
            ['TTL', ttl, setTtl, '최대 홉 수'],
            ['최대 재시도', retries, setRetries, '실패 시 다시 보낼 횟수'],
            ['타임아웃(s)', timeout, setTimeoutS, 'ACK 대기 시간(초)'],
          ].map(([l, v, set, help]) => (
            <label key={l as string} className="space-y-1">
              <span className="text-ink-3">{l as string}</span>
              <input
                inputMode="numeric"
                value={v as string}
                onChange={(e) => (set as (s: string) => void)(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="서버 기본값"
                aria-label={l as string}
                className="h-8 w-full rounded-md border border-line bg-raised px-2 font-mono text-xs outline-none placeholder:text-ink-3"
              />
              <span className="block text-[10px] leading-snug text-ink-3">{help as string} · 비우면 서버 기본값</span>
            </label>
          ))}
        </div>
      )}
      {plan && (
        <p className="mt-2 text-2xs text-ink-3">
          전송할 경로: {plan.status === 'route_found' ? <span className="font-mono text-ink-2">{plan.path.join(' → ')} ({plan.distance_m}m)</span> : <span className="text-[#F2878A]">경로 없음({plan.reason}) — 그대로 전송됩니다</span>} · rev {scenario?.state.revision}/v{plan.route_version}
        </p>
      )}
      {experiment?.status !== 'running' && <p className="mt-1 text-2xs text-warn">실험이 실행 중이 아니면 노드가 없어 전송은 실패로 관측됩니다.</p>}
      {reason && <p className="mt-1 text-2xs text-ink-3" data-testid="guidance-disabled-reason">전송 불가: {reason}</p>}
      <Button
        variant="primary"
        className="mt-3 w-full"
        disabled={!!reason || !!a.busy}
        title={reason}
        onClick={() =>
          a.exec(
            'g',
            () =>
              actions.sendGuidance(scenario!.state.scenario_id, {
                start_location: start,
                source_node: src,
                destination_node: dst,
                expected_revision: scenario!.state.revision,
                ttl: num(ttl),
                max_retries: num(retries),
                timeout_seconds: num(timeout),
              }),
            (d) => ({
              bad: !(d.ack_received && d.transport_result?.success),
              text: `HTTP 200 · ${d.ack_received ? 'ACK 수신' : 'ACK 없음'} · ${d.transport_result ? (d.transport_result.success ? '전송 성공' : '전송 실패') : d.transport_error ?? '전송 결과 없음'} · ${d.application_receipt ? `적용 ${d.application_receipt.disposition}` : d.receipt_query_error ? '적용 미확인(조회 오류)' : '적용 미확인'}`,
            }),
          )
        }
      >
        <Send size={13} /> {a.busy ? '전송·ACK 대기 중…' : `${src} → ${dst} 안내 전송`}
      </Button>
      <FeedbackLine msg={a.msg} />
    </section>
  );
}
