import { STRATA, pValue, pp } from '@/domain/study';
import { allOrNothing, fair, fairClass, fairRow } from '@/domain/fairRetry';

/**
 * fair_retry_v1 해석 주의사항. 수치는 domain/fairRetry(검증된 요약 JSON)에서 읽어 서식만 바꿉니다.
 * aligned_v3 의 caveats.ts 와 분리했습니다(두 연구의 조건이 다르므로 문구를 섞지 않음).
 */
export function fairCaveatItems(): string[] {
  const o = fairRow('overall', 'delivered')!;
  const s = fair.settings;
  const strata = STRATA.map((x) => ({ ...x, r: fairRow(x.scope, 'delivered')!, c: fairClass(x.scope, 'delivered')! }));
  const fixedAllOrNothing = strata.every((x) => allOrNothing(x.r.fixed_retry_rate));
  const notSig = strata.filter((x) => x.c.significant_after_holm === false);
  const items = [
    `두 방식 모두 최초 전송 포함 최대 ${s.max_attempts}회(재시도 ${s.max_retries}회), 홉 타임아웃 ${s.node_hop_timeout_seconds}초, 클라이언트 마감 ${s.client_timeout_seconds}초, 관측 창 ${s.observation_window_seconds}초로 같습니다. 남은 차이는 경로 정책(Fixed + Retry는 항상 ${s.fixed_retry_route})과 Heartbeat 유무입니다.`,
    `전체 비교(${pp(o.diff_exit_minus_fixed_retry, 2)})는 사전 등록된 단일 1차 검정이라 보정하지 않았고(부호 검정 p=${pValue(o.sign_test_p)}), 조건별 검정 8개에는 Holm 보정을 적용했습니다.`,
    ...notSig.map((x) => `${x.label}의 차이 ${pp(x.r.diff_exit_minus_fixed_retry)}는 보정 전 p=${pValue(x.r.sign_test_p)}이지만 Holm 보정 후 p=${pValue(x.c.holm_p)}로 통계적으로 유의하지 않습니다.`),
    ...(fixedAllOrNothing ? [`Fixed + Retry의 전체 95% CI 폭이 0인 이유: ${strata.length}개 조건 각각에서 ${s.repetitions_per_stratum}개 블록이 모두 성공하거나 모두 실패했습니다. 층화 bootstrap은 조건 안에서만 블록을 다시 뽑으므로 평균이 바뀌지 않습니다. 표본 안에 변이가 없었다는 뜻이며 불확실성이 없다는 뜻이 아닙니다.`] : []),
    fair.ack_6s_equals_delivered_everywhere
      ? '6초 이내 ACK(ack_6s)는 보조 지표입니다. 이번 실험에서는 전달된 메시지가 모두 6초 안에 ACK를 받아 모든 조건에서 delivered와 같은 값이며, 별도의 검정으로 세지 않습니다.'
      : '6초 이내 ACK(ack_6s)는 보조 지표이며 별도의 검정으로 세지 않습니다.',
    'ACK 지연은 ACK를 받은 메시지만으로 계산한 조건부 지표입니다. 두 방식의 성공 메시지는 조건 구성이 달라 지연을 직접 비교할 수 없습니다.',
    `제어 트래픽은 Heartbeat·HeartbeatReply 애플리케이션 프레임(4바이트 길이 + JSON) 바이트를 ${s.observation_window_seconds}초로 나눈 값입니다. TCP/IP 헤더·연결 수립·데이터 프레임·계측 로그는 포함하지 않습니다.`,
    '단일 PC의 loopback TCP와 가상 6노드 토폴로지에서 측정한 통신 지표입니다. 실제 대피 시간 단축이나 실제 건물·무선 환경의 성능은 검증하지 않았습니다.',
    'aligned_v3(초기 비교)와는 재시도 정책과 실행이 다른 별개 연구입니다. 두 연구의 수치를 합치거나 서로 대신하지 않습니다.',
  ];
  return items;
}
