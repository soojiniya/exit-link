import { useState } from 'react';
import { actions } from '@/api/actions';
import { useApp } from '@/store/store';
import { WEST_STAIR_FIRE } from '@/domain/presets';
import { Button, SectionLabel, SourceBadge, cx } from '../primitives';
import { FeedbackLine, needToken, useAction } from './useAction';

/** 시나리오 생성: 출발지(대피 안내 대상)를 고르고 빈 시나리오 또는 프리셋으로 생성합니다. */
export function ScenarioCreator() {
  const hasToken = useApp((s) => s.hasToken);
  const building = useApp((s) => s.building);
  const count = useApp((s) => s.scenarioOrder.length);
  const [starts, setStarts] = useState<string[]>(WEST_STAIR_FIRE.starts);
  const a = useAction();
  const startable = (building?.building.nodes ?? []).filter((p) => p.kind !== 'exit');
  const floors = [...(building?.building.floors ?? [])].reverse();
  const reason = needToken(hasToken) ?? (count >= 32 ? '서버 세션당 시나리오는 32개까지입니다' : undefined);

  return (
    <section>
      <SectionLabel right={<SourceBadge origin="SIM" />}>재난 시나리오 생성</SectionLabel>
      <p className="mb-2 text-2xs text-ink-3">대피 안내 대상 위치(출발지)를 선택합니다. 출구는 출발지가 될 수 없습니다. 여러 곳을 고를 수 있습니다.</p>
      <div className="mb-3 space-y-1.5" role="group" aria-label="출발지 선택">
        {floors.map((f) => {
          const here = startable.filter((p) => p.floor === f);
          const exits = (building?.building.nodes ?? []).filter((p) => p.floor === f && p.kind === 'exit');
          return (
            <div key={f} className="flex items-stretch gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-1.5">
              <span className="flex w-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] font-mono text-[12px] font-semibold text-ink-2">{f}F</span>
              <div className="flex flex-1 flex-wrap gap-1.5">
                {here.map((p) => {
                  const on = starts.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      title={p.label}
                      aria-pressed={on}
                      onClick={() => setStarts((s) => (s.includes(p.id) ? s.filter((x) => x !== p.id) : [...s, p.id]))}
                      className={cx('rounded-lg border px-2.5 py-1 text-left transition', on ? 'border-action bg-action/[0.14] text-action shadow-[0_0_14px_-6px_rgba(124,200,255,0.9)]' : 'border-line text-ink-2 hover:border-white/25 hover:text-ink')}
                    >
                      <span className="font-mono text-[11.5px]">{on ? '✓ ' : ''}{p.id}</span>
                      <span className="block max-w-[110px] truncate text-[10px] text-ink-3">{p.label}</span>
                    </button>
                  );
                })}
                {exits.map((p) => (
                  <span key={p.id} title={`${p.label} — 출구는 출발지로 선택할 수 없습니다`} className="cursor-not-allowed rounded-lg border border-dashed border-white/10 px-2.5 py-1 text-left opacity-45">
                    <span className="font-mono text-[11.5px] text-ink-3">{p.id}</span>
                    <span className="block text-[10px] text-ink-3">출구 · 선택 불가</span>
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mb-2 text-2xs text-ink-3">선택 {starts.length}곳{starts.length ? ` · ${starts.join(', ')}` : ''}</div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={!!reason || !starts.length || !!a.busy} title={reason} onClick={() => a.exec('c', () => actions.createScenario(starts), (sc) => `시나리오 ${sc.state.scenario_id.slice(0, 8)} 생성 · 경로 ${sc.plans.length}개 계산`)}>
          위험 없이 생성
        </Button>
        <Button
          disabled={!!reason || !starts.length || !!a.busy}
          title={`${WEST_STAIR_FIRE.source} 1단계 입력`}
          onClick={() => a.exec('p', () => actions.createScenario(starts, WEST_STAIR_FIRE.steps[0].hazards, `시나리오 생성 · ${WEST_STAIR_FIRE.name}`), (sc) => `“${WEST_STAIR_FIRE.name}” 1단계로 생성 · rev ${sc.state.revision}`)}
        >
          프리셋: 서쪽 계단 화재
        </Button>
      </div>
      {(reason || !starts.length) && (
        <p className="mt-2 text-2xs text-ink-3" data-testid="scenario-disabled-reason">생성 불가: {reason ?? '출발지를 한 곳 이상 선택하세요'}</p>
      )}
      <FeedbackLine msg={a.msg} />
    </section>
  );
}
