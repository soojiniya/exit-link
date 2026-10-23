import { useEffect, useMemo, useState } from 'react';
import type { HazardUpdate, WalkEdge, WsHazardUpdate } from '@contracts';
import { actions } from '@/api/actions';
import { useApp } from '@/store/store';
import { useActiveScenario } from '@/store/selectors';
import { WEST_STAIR_FIRE } from '@/domain/presets';
import { edgeKey } from '@/domain/layout';
import { Button, SectionLabel, SourceBadge, cx } from '../primitives';
import { FeedbackLine, needToken, useAction } from './useAction';

type Mark = 'none' | 'fire' | 'danger' | 'blocked';
const NEXT: Record<Mark, Mark> = { none: 'fire', fire: 'danger', danger: 'blocked', blocked: 'none' };
const STYLE: Record<Mark, string> = {
  none: 'border-line text-ink-2 hover:border-[#3d434b]',
  fire: 'border-fail bg-fail/20 text-[#F2878A]',
  danger: 'border-warn bg-warn/15 text-[#EDAA6B]',
  blocked: 'border-[#8a4a4c] bg-[#3a2224] text-[#d79a9c]',
};
const LABEL: Record<Mark, string> = { none: '', fire: '화재', danger: '위험', blocked: '차단' };
const EDGE_KIND: Record<WalkEdge['kind'], string> = { corridor: '복도', stairs: '계단', exit_access: '출구 접근' };

function marksOf(h?: WsHazardUpdate | HazardUpdate | null) {
  const m: Record<string, Mark> = {};
  h?.fire_locations?.forEach((id) => (m[id] = 'fire'));
  h?.dangerous_nodes?.forEach((id) => (m[id] = 'danger'));
  h?.blocked_nodes?.forEach((id) => (m[id] = 'blocked'));
  return m;
}
const passagesOf = (h?: { blocked_passages?: { source: string; target: string }[] } | null) => new Set((h?.blocked_passages ?? []).map((p) => edgeKey(p.source, p.target)));

/**
 * 위험 구역 편집기. HazardUpdate는 PATCH가 아니라 전체 교체이므로 화면의 초안 전체를 expected_revision과 함께 전송합니다.
 * 같은 상태를 다시 보내면 백엔드는 revision을 올리지 않습니다.
 */
export function HazardEditor({ compact = false }: { compact?: boolean }) {
  const hasToken = useApp((s) => s.hasToken);
  const building = useApp((s) => s.building);
  const scenario = useActiveScenario();
  const a = useAction();
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [passages, setPassages] = useState<Set<string>>(new Set());
  const rev = scenario?.state.revision;
  const sid = scenario?.state.scenario_id;
  useEffect(() => {
    setMarks(marksOf(scenario?.state.hazards));
    setPassages(passagesOf(scenario?.state.hazards));
  }, [sid, rev]); // eslint-disable-line react-hooks/exhaustive-deps

  const places = building?.building.nodes ?? [];
  const edges = building?.building.edges ?? [];
  const floors = [...(building?.building.floors ?? [])].reverse();

  const body = useMemo((): HazardUpdate => {
    const pick = (m: Mark) => Object.entries(marks).filter(([, v]) => v === m).map(([k]) => k);
    return {
      fire_locations: pick('fire'),
      dangerous_nodes: pick('danger'),
      blocked_nodes: pick('blocked'),
      blocked_passages: edges.filter((e) => passages.has(edgeKey(e.source, e.target))).map((e) => ({ source: e.source, target: e.target })),
    };
  }, [marks, passages, edges]);

  const current = scenario?.state.hazards;
  const dirty = useMemo(() => {
    if (!current) return false;
    const same = (x: string[], y: string[]) => x.length === y.length && x.every((v) => y.includes(v));
    return !(
      same(body.fire_locations!, current.fire_locations) &&
      same(body.dangerous_nodes!, current.dangerous_nodes) &&
      same(body.blocked_nodes!, current.blocked_nodes) &&
      same([...passages], [...passagesOf(current)])
    );
  }, [body, current, passages]);

  if (!scenario) {
    return (
      <section>
        <SectionLabel right={<SourceBadge origin="SIM" />}>화재 · 위험 구역 · 통로 차단</SectionLabel>
        <p className="text-2xs text-ink-3">활성 시나리오가 없습니다. 먼저 시나리오를 생성하거나 선택하세요.</p>
      </section>
    );
  }
  const reason = needToken(hasToken);

  return (
    <section>
      <SectionLabel right={<SourceBadge origin="SIM" />}>화재 · 위험 구역 · 통로 차단</SectionLabel>
      <p className="mb-2 text-2xs text-ink-3">위치를 누를 때마다 화재 → 위험 → 차단 → 해제 순으로 바뀝니다. rev {scenario.state.revision} 기준 전체 교체.</p>
      <div className="mb-2 flex flex-wrap gap-1.5 text-[10px]" aria-hidden>
        {(['fire', 'danger', 'blocked'] as Mark[]).map((m) => <span key={m} className={cx('rounded-md border px-1.5 py-0.5', STYLE[m])}>{LABEL[m]}</span>)}
        <span className="rounded-md border border-line px-1.5 py-0.5 text-ink-3">지정 없음</span>
      </div>
      <div className="mb-3 space-y-1.5">
        {floors.map((f) => (
          <div key={f} className="flex items-stretch gap-1.5">
            <span className="w-6 pt-1.5 font-mono text-2xs text-ink-3">{f}F</span>
            <div className={cx('grid flex-1 gap-1.5', compact ? 'grid-cols-3' : 'grid-cols-6')}>
              {places
                .filter((p) => p.floor === f)
                .map((p) => {
                  const m = marks[p.id] ?? 'none';
                  return (
                    <button key={p.id} title={p.label} onClick={() => setMarks((s) => ({ ...s, [p.id]: NEXT[m] }))} className={cx('rounded-md border px-1.5 py-1 text-left transition', STYLE[m])}>
                      <div className="font-mono text-2xs">{p.id}</div>
                      <div className="h-3 text-[10px]">{LABEL[m] || (p.kind === 'exit' ? '출구' : p.kind === 'stair' ? '계단참' : '복도')}</div>
                    </button>
                  );
                })}
            </div>
          </div>
        ))}
      </div>

      <div className="mb-1 text-2xs text-ink-3">통로·계단 차단 (blocked_passages)</div>
      <div className={cx('mb-3 grid gap-1', compact ? 'grid-cols-2' : 'grid-cols-3')}>
        {edges.map((e) => {
          const k = edgeKey(e.source, e.target);
          const on = passages.has(k);
          return (
            <button
              key={k}
              aria-pressed={on}
              onClick={() => setPassages((s) => {
                const n = new Set(s);
                if (on) n.delete(k);
                else n.add(k);
                return n;
              })}
              className={cx('flex items-center justify-between rounded-md border px-2 py-1 text-left font-mono text-[10px]', on ? 'border-fail/60 bg-fail/10 text-[#F2878A] line-through' : 'border-line text-ink-2 hover:text-ink')}
            >
              <span>{e.source}–{e.target}</span>
              <span className="font-sans text-ink-3 no-underline">{EDGE_KIND[e.kind]}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={!!reason || !!a.busy}
          title={reason}
          onClick={() =>
            a.exec('h', () => actions.replaceHazards(scenario.state.scenario_id, scenario.state.revision, body), (sc) => {
              const none = sc.plans.filter((p) => p.status === 'no_route').map((p) => p.start_location);
              const head = sc.state.revision === scenario.state.revision ? '같은 상태라 revision 유지' : `rev ${scenario.state.revision} → ${sc.state.revision} 교체 · 대피 경로 ${sc.plans.length}개 재계산`;
              return none.length ? { bad: true, text: `${head} · 대체 경로 없음: ${none.join(', ')}` } : head;
            })
          }
        >
          {dirty ? '변경 적용' : '현재 상태 재전송'}
        </Button>
        {WEST_STAIR_FIRE.steps.map((st) => (
          <Button key={st.label} title={`${WEST_STAIR_FIRE.source}`} onClick={() => { setMarks(marksOf(st.hazards)); setPassages(passagesOf(st.hazards)); }}>
            {st.label}
          </Button>
        ))}
        <Button onClick={() => { setMarks(marksOf(current)); setPassages(passagesOf(current)); }} disabled={!dirty}>되돌리기</Button>
        {dirty && <span className="text-2xs text-action">적용 전 초안</span>}
      </div>
      {reason && <p className="mt-2 text-2xs text-ink-3">적용 불가: {reason}</p>}
      <FeedbackLine msg={a.msg} />
    </section>
  );
}
