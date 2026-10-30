import { Link } from 'react-router-dom';
import { Box } from 'lucide-react';
import { TokenSection } from '@/ui/lab/TokenSection';
import { ScenarioCreator } from '@/ui/lab/ScenarioCreator';
import { HazardEditor } from '@/ui/lab/HazardEditor';
import { ExperimentControl } from '@/ui/lab/ExperimentControl';
import { GuidanceForm } from '@/ui/lab/GuidanceForm';
import { DeliveryList, FailoverTracker, PlanResults, ScenarioList } from '@/ui/lab/Results';
import { DisabledNotice, EnvChecklist, LabStatusStrip, LabStepper, LabTimeline, PublicReadOnlyNotice, RecordedShortcuts, StepCard, labSteps, useLabEnv } from '@/ui/lab/LabOverview';
import { isPublicDemo } from '@/domain/mode';
import { SourceBadge } from '@/ui/primitives';

/**
 * Simulation Lab — Experiment Control Center.
 * 흐름: 01 환경·권한 → 02 시나리오(가상) → 03 실험 실행(실제 프로세스) → 04 장애·메시지 제어(실제 TCP) → 05 결과·기록.
 * 모든 요청은 api/actions.ts 한 곳을 거치고(기존 컴포넌트 그대로), 화면 값은 응답·WebSocket 수신값만 씁니다.
 * 실험이 비활성화된 환경에서는 조회만 가능하며, 저장된 실험 기록(REPLAY)으로 안내합니다.
 * 공개 데모(VITE_DEMO_MODE=1)에서는 토큰 입력과 쓰기 제어를 렌더링하지 않습니다(api/client.ts도 쓰기 요청을 차단).
 */
export default function SimulationLab() {
  const env = useLabEnv();
  const steps = labSteps(env);
  const readOnly = isPublicDemo();
  const locked = <PublicReadOnlyNotice compact />;
  return (
    <div className="panel-scroll h-full">
      <div className="mx-auto max-w-[1600px] space-y-8 px-6 pb-16 pt-8 md:px-8">
        {/* A. 상단 헤더 */}
        <header className="space-y-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="eyebrow">Simulation Lab · Experiment Control Center</div>
              <h1 className="mt-3 text-[clamp(30px,3vw,44px)] font-light leading-none tracking-[-0.035em] text-ink">
                <span className="text-sheen font-normal">실험 제어 센터</span>
              </h1>
              <p className="mt-2 max-w-[78ch] text-[13.5px] leading-relaxed text-ink-3">
                재난 시나리오(가상)를 구성하고, 실제 TCP 노드 프로세스에 장애를 주입한 뒤 경로 재계산·대체 경로 전환·안내 전달을 기록합니다.
                제어 버튼은 실제 FastAPI 요청을 보내며, 표시 값은 응답과 실시간 수신값만 사용합니다.
              </p>
            </div>
            <Link to="/twin" className="lift inline-flex h-9 items-center gap-1.5 rounded-full border border-white/12 bg-white/[0.04] px-3.5 text-[12.5px] text-ink-2 hover:border-white/25 hover:text-ink">
              <Box size={14} /> Digital Twin에서 보기
            </Link>
          </div>
          <LabStatusStrip env={env} />
        </header>

        {/* B. 진행 단계 */}
        <section className="space-y-3" aria-label="실험 진행 흐름">
          <LabStepper steps={steps} />
          {readOnly ? <PublicReadOnlyNotice /> : <DisabledNotice env={env} />}
        </section>

        {/* C. 제어 영역 */}
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          <StepCard id="lab-sec-env" no="01" title="환경 및 제어 권한" desc="쓰기 요청에는 서버의 제어 토큰이 필요합니다." right={<SourceBadge origin="CTRL" />}>
            {readOnly ? locked : <TokenSection />}
            <EnvChecklist env={env} />
          </StepCard>
          <StepCard id="lab-sec-run" no="03" title="실험 실행 · TCP 노드" desc="실험 시작·장애 주입은 실제 노드 프로세스를 실행·종료합니다." right={<SourceBadge origin="CTRL" />}>
            {readOnly ? locked : <ExperimentControl />}
          </StepCard>
          <StepCard id="lab-sec-scenario" no="02" title="시나리오 구성" desc="대피 안내 대상 위치를 고르고 시나리오를 생성합니다(가상 데이터)." right={<SourceBadge origin="SIM" />}>
            <div className="space-y-6">
              {readOnly ? locked : <ScenarioCreator />}
              <ScenarioList />
            </div>
          </StepCard>
          <StepCard title="위험 구역 · 통로 차단" desc="활성 시나리오의 화재·위험·차단을 지정하고 대피 경로를 재계산합니다." right={<SourceBadge origin="SIM" />}>
            {readOnly ? locked : <HazardEditor />}
          </StepCard>
          <StepCard id="lab-sec-control" no="04" title="안내 메시지 전송" desc="활성 시나리오의 경로를 실제 TCP 노드로 전송하고 ACK 로 확인합니다." right={<SourceBadge origin="LIVE" />}>
            {readOnly ? locked : <GuidanceForm showAdvanced />}
          </StepCard>
          <StepCard title="대피 경로 · 대체 경로 전환" desc="경로 계산 결과와 장애 후 전환 과정(실제 수신 이벤트)." right={<SourceBadge origin="LIVE" />}>
            <div className="space-y-6">
              <PlanResults />
              <FailoverTracker />
            </div>
          </StepCard>
        </div>

        {/* D. 결과 · 기록 */}
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.5fr_1fr]">
          <StepCard id="lab-sec-results" no="05" title="결과 및 기록 타임라인" desc="이 탭의 제어 요청(CTRL)과 실시간으로 받은 이벤트(LIVE·SIM)만 표시합니다. 새로고침하면 초기화됩니다.">
            <LabTimeline />
          </StepCard>
          <StepCard title="안내 전송 결과" desc="ACK·전송 결과·적용 상태(HTTP 200 은 전달 성공이 아님)." right={<SourceBadge origin="LIVE" />}>
            <DeliveryList />
          </StepCard>
        </div>

        {/* 저장된 실험 기록 */}
        <StepCard id="lab-sec-recorded" title="저장된 실험 기록 · Recorded Experiments" desc="새 실험이 아니라 이미 측정해 저장한 실제 TCP 기록입니다. 현재 LIVE 상태와 섞지 않으며, 카드를 누르면 해당 사례의 CINEMATIC 화면이 열립니다." right={<span className="pill border-ice/30 bg-ice/[0.07] text-2xs text-ice">저장된 기록 · 실시간 아님</span>}>
          <RecordedShortcuts />
        </StepCard>
      </div>
    </div>
  );
}
