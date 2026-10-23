import { pValue, pp, rowOf, study } from '@/domain/study';

/**
 * 연구 결과 해석 주의사항(Analytics · STORY 공용). 수치는 domain/study(검증된 분석 JSON)에서 읽어 서식만 바꿉니다.
 * 차트 라이브러리에 의존하지 않도록 StudyResults 에서 분리했습니다.
 */
export function caveatItems(): string[] {
  const seqBefore = rowOf(study.by_stratum, 'sequential_failures/before_send', 'delivered')!;
  const single = ['single_failure/before_send', 'single_failure/inflight'].map((s) => rowOf(study.by_stratum, s, 'delivered')!);
  return [
    `Fixed 기준선은 장애 대상 노드 N2를 지나는 고정 경로(N1→N2→N4)이고 재시도 ${study.settings.fixed_retries}회입니다. 단일 장애의 큰 차이는 “우회 기능 유무”를 확인한 결과에 가깝습니다.`,
    `단일 장애 100%는 유효 표본 기준입니다(${single.map((r) => `${r.exit_link_success}/${r.exit_link_n}`).join(', ')}). 시간 기준 위반으로 제외된 t122에는 EXIT-LINK 실패 1건이 있었습니다.`,
    `연속 장애 · 전송 전의 차이 ${pp(seqBefore.diff_exit_minus_fixed)}는 부호 검정 p=${pValue(seqBefore.sign_test_p)}이지만 Holm 보정 후 p=${pValue(seqBefore.sign_test_p_holm_within_metric_8_strata)}로 통계적으로 유의하지 않습니다.`,
    'ACK 지연은 성공 메시지만으로 계산한 조건부 지표입니다.',
    '신뢰구간 폭이 0인 층은 표본 안에서 변이가 없었다는 뜻이며 불확실성이 없다는 뜻이 아닙니다(층별 29–30쌍).',
    '정상(장애 없음)과 경로 없음 조건에서는 두 방식의 차이가 없습니다.',
    '단일 PC의 loopback TCP와 가상 6노드 토폴로지에서 측정한 통신 지표입니다. 실제 대피 시간 단축이나 실제 건물·무선 환경의 성능은 검증하지 않았습니다.',
  ];
}
