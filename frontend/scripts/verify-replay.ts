/**
 * npm run verify:replay  (읽기 전용)
 *
 * 1. public/replay/*.json 의 모든 이벤트·메시지 결과를 원본 실험 기록(data/measured/v3-6d329cd9/<cell>)과 1:1 대조
 *    - provenance 의 trial/journal/노드 로그 SHA-256 = 현재 원본 파일
 *    - 각 이벤트 = 같은 노드 로그의 같은 이벤트(benchmark_perf_ns − window_start 가 offset_ms 와 0.001ms 이내), 필드 값 동일
 *    - fault_confirmed = trial.json faults 의 confirmed_perf_ns
 *    - 관측 구간 안의 프로토콜 이벤트가 빠짐없이 들어 있음(heartbeat 계측·gossip 행 제외)
 * 2. 공통 재생 엔진(domain/replayEngine)이 기록을 일관되게 해석하는지 검사
 * 3. REPLAY 코드가 LIVE 스토어·API·WebSocket 을 쓰지 않는지 검사
 * 5. CINEMATIC 연출(카메라 샷·캡션·펄스·경로 전환 빛)이 기록 이벤트에만 근거하고 기록을 바꾸지 않는지 검사
 * 4. 3D Digital Twin 좌표 매핑: 재생 토폴로지 = 프로젝트 communication.json, 모든 위치 ID 가
 *    building.json(층)·building-layout.json(평면 좌표)에 있고 노드 좌표가 서로 겹치지 않음
 * 원본 폴더가 없으면 1번은 '건너뜀'으로 표시하고 실패로 처리합니다(검증되지 않은 상태를 통과로 보고하지 않음).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isManifest, isReplayCase, eventsSorted, linkViewsAt, messageProgressAt, nodeViewsAt, replayDuration, timelineMarks, type ReplayCase,
} from '../src/domain/replayEngine';
import { caseFacts } from '../src/ui/overview/recordedCases';
import { sceneBeats, sceneTime, sceneWindows } from '../src/ui/story/storyScenes';
import { PULSE_MS, SWEEP_MS, captionAt, directorShot, keyRouteShot, pulsesAt, routeSweepAt } from '../src/ui/replay/cinematicDirector';

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = resolve(FRONTEND, '..');
const RUN = resolve(PROJECT, 'data', 'measured', 'v3-6d329cd9');
const PUB = resolve(FRONTEND, 'public', 'replay');
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

let checks = 0;
const problems: string[] = [];
const check = (ok: boolean, msg: string) => { checks++; if (!ok) problems.push(msg); };

const manifest: unknown = JSON.parse(readFileSync(resolve(PUB, 'manifest.json'), 'utf8'));
check(isManifest(manifest), 'manifest 형식');
const cases = isManifest(manifest) ? manifest.cases : [];

const AGG = new Set(['benchmark_control_frame', 'benchmark_probe_attempt', 'state_updated']);
const IGNORE = new Set(['seq', 'offset_ms', 'event', 'node']);

for (const entry of cases) {
  const c = entry.id;
  const doc: unknown = JSON.parse(readFileSync(resolve(PUB, entry.file), 'utf8'));
  check(isReplayCase(doc), `${c}: 재생 JSON 형식`);
  if (!isReplayCase(doc)) continue;
  const d: ReplayCase = doc;
  check(d.cell.cell === c && eventsSorted(d.events), `${c}: 사례 ID·시간 정렬`);
  check(d.events.every((e, i) => e.seq === i), `${c}: seq 연속`);

  // ── 1. 원본 대조 ──
  const dir = resolve(RUN, c);
  if (!existsSync(resolve(dir, 'trial.json'))) { check(false, `${c}: 원본 ${dir} 없음 — 원본 대조를 하지 못했습니다`); continue; }
  const trial = JSON.parse(readFileSync(resolve(dir, 'trial.json'), 'utf8'));
  const ws: number = trial.window_start_perf_ns;
  const we: number = trial.observation_ended_perf_ns;
  const off = (p: number) => (p - ws) / 1e6;
  check(d.provenance.trial_sha256 === sha(resolve(dir, 'trial.json')), `${c}: trial.json 해시`);
  check(d.provenance.journal_sha256 === sha(resolve(dir, 'journal.jsonl')), `${c}: journal.jsonl 해시`);
  for (const [f, h] of Object.entries(d.provenance.node_log_sha256 ?? {})) check(h === sha(resolve(dir, 'p', f)), `${c}: ${f} 해시`);
  check(d.cell.experiment_id === trial.experiment_id && d.cell.method === trial.method && d.cell.condition === trial.condition, `${c}: 셀 정보`);
  check(Math.abs((d.clock.observation_end_offset_ms ?? -1) - off(we)) < 1e-3, `${c}: 관측 종료 시각`);
  check(same(d.topology?.edges, trial.topology.edges.map((e: { source: string; target: string }) => [e.source, e.target])), `${c}: 토폴로지 링크`);

  const raw: Record<string, any>[] = [];
  for (const p of trial.processes as { log: string }[]) {
    for (const line of readFileSync(resolve(dir, 'p', p.log), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      if (!AGG.has(e.event)) raw.push(e);
    }
  }
  const used = new Set<Record<string, any>>();
  for (const e of d.events) {
    if (e.event === 'fault_confirmed') {
      const f = (trial.faults as Record<string, any>[]).filter((x) => x.node === e.node);
      check(f.length === 1 && Math.abs(off(f[0].confirmed_perf_ns) - e.offset_ms) < 1e-3, `${c}: 장애 ${e.node} 시각`);
      continue;
    }
    const m = raw.filter((r) => r.event === e.event && r.node === e.node && r.message_id === e.message_id && Math.abs(off(r.benchmark_perf_ns) - e.offset_ms) < 1e-3);
    check(m.length === 1, `${c}: 이벤트 ${e.seq}(${e.event}) 원본 일치 ${m.length}건`);
    if (m.length !== 1) continue;
    used.add(m[0]);
    for (const [k, v] of Object.entries(e)) if (!IGNORE.has(k)) check(same(m[0][k], v), `${c}: 이벤트 ${e.seq} ${k}`);
  }
  const missing = raw.filter((r) => !used.has(r) && r.benchmark_perf_ns >= ws && r.benchmark_perf_ns <= we);
  check(missing.length === 0, `${c}: 관측 구간 안 원본 이벤트 ${missing.length}건 누락 (${[...new Set(missing.map((r) => r.event))].join(', ')})`);
  check((trial.faults as unknown[]).length === d.events.filter((e) => e.event === 'fault_confirmed').length, `${c}: 장애 수`);
  for (const m of d.messages) {
    const r = (trial.messages as Record<string, any>[]).find((x) => x.message_id === m.message_id);
    check(!!r, `${c}: 메시지 ${m.position} 원본`);
    if (!r) continue;
    const res = m.result ?? {};
    check(r.position === m.position && Math.abs(off(r.started_perf_ns) - (m.started_offset_ms ?? NaN)) < 1e-3, `${c}: 메시지 ${m.position} 시작`);
    check(res.ack === r.ack_received && res.error === r.error && same(res.route, r.route) && res.retries === r.retries && res.client_elapsed_ms === r.client_elapsed_ms && res.delivered_observed === r.delivered_observed, `${c}: 메시지 ${m.position} 결과`);
    const ra = (r.raw_response?.attempts ?? []).map((a: Record<string, any>) => [a.number, a.route, a.duration_ms, a.outcome]);
    check(same(ra, (m.attempts ?? []).map((a) => [a.number, a.route, a.duration_ms, a.outcome])), `${c}: 메시지 ${m.position} 시도 기록`);
  }

  // ── 2. 공통 엔진 해석 ──
  const end = replayDuration(d);
  const edges = new Set((d.topology?.edges ?? []).flatMap(([a, b]) => [`${a}-${b}`, `${b}-${a}`]));
  for (const m of d.messages) {
    const fin = messageProgressAt(d, m, end);
    check(fin.stage === (m.result?.ack ? 'acked' : 'failed'), `${c}: 메시지 ${m.position} 끝 상태 ${fin.stage} ≠ 기록 ACK ${m.result?.ack}`);
    check(fin.ackRecorded === !!m.result?.ack, `${c}: 메시지 ${m.position} ACK 기록 해석`);
    check(fin.retryRecorded === (m.result?.retries ?? 0) > 0, `${c}: 메시지 ${m.position} 재전송 기록 해석`);
    check(messageProgressAt(d, m, -1).stage === 'pending', `${c}: 메시지 ${m.position} 시작 전`);
    // 모든 이벤트 시각에서: 링크 강조·마커는 토폴로지 링크 위에만, 보간 표시는 transit/ack 마커만
    for (const e of d.events) {
      const p = messageProgressAt(d, m, e.offset_ms);
      for (const l of p.legs) check(edges.has(`${l.from}-${l.to}`), `${c}: 토폴로지 밖 링크 강조 ${l.from}-${l.to}`);
      if (p.marker) {
        check(edges.has(`${p.marker.from}-${p.marker.to}`), `${c}: 토폴로지 밖 마커 ${p.marker.from}-${p.marker.to}`);
        check(p.marker.interpolated === (p.marker.kind === 'transit' || p.marker.kind === 'ack'), `${c}: 보간 표시 규칙`);
        check(p.marker.frac >= 0 && p.marker.frac <= 1, `${c}: 마커 위치 범위`);
      }
    }
  }
  check(nodeViewsAt(d, end).filter((n) => n.status === 'fail').length === d.events.filter((e) => e.event === 'fault_confirmed').length, `${c}: 장애 노드 수`);
  check(nodeViewsAt(d, -1).every((n) => n.status === 'unknown'), `${c}: 기록 전 노드는 미관측`);
  check(linkViewsAt(d, end).length === (d.topology?.edges.length ?? 0), `${c}: 링크 수`);
  check(timelineMarks(d).every((k) => k.t >= 0 && k.t <= end), `${c}: 타임라인 마커 범위`);

  // 사례별 기록 특성(데이터에서 직접 확인되는 것만)
  const ackAt = (pos: number) => d.events.find((e) => e.event === 'ack_received' && e.node === 'N1' && e.message_id === d.messages[pos]?.message_id)?.offset_ms ?? NaN;
  if (c === 't010') {
    check(ackAt(1) < ackAt(0) && ackAt(0) < ackAt(2), 't010: N1 ACK 기록 순서 1 → 0 → 2');
    const rc = d.events.find((e) => e.event === 'route_changed');
    check(!!rc && same(rc.excluded_links, [['N1', 'N2']]), 't010: route_changed 제외 링크 N1-N2');
    const p = messageProgressAt(d, d.messages[0], (rc?.offset_ms ?? 0) + 1);
    check(same(p.previousRoute, ['N1', 'N2', 'N4']) && same(p.route, ['N1', 'N3', 'N4']) && p.attempt === 2, 't010: 메시지 0 이전/현재 경로 해석');
    const before = messageProgressAt(d, d.messages[0], 1000);
    check(before.stage === 'connecting' && before.legs.some((l) => l.from === 'N1' && l.to === 'N2' && l.state === 'connecting'), 't010 +1000ms: 메시지 0 N1→N2 연결 시도 중');
    check(nodeViewsAt(d, 10).find((n) => n.id === 'N2')?.status === 'fail', 't010: N2 장애 확인 후 빨강');
  }
  if (c === 't000') {
    check(d.cell.method === 'fixed' && d.messages.every((m) => m.result?.ack === false), 't000: Fixed ACK 미수신 3건');
    check(!d.events.some((e) => e.event.startsWith('neighbor_')), 't000: 이웃 판정 기록 없음');
    check(linkViewsAt(d, end).every((l) => l.status === 'unknown'), 't000: 링크 상태 기록 없음');
  }
  if (c === 't012') check(d.messages.every((m) => m.result?.ack === true) && !d.events.some((e) => e.event === 'fault_confirmed'), 't012: 장애 없음 · ACK 3건');
}

// ── 4. 3D 좌표 매핑 ──
{
  const comm = JSON.parse(readFileSync(resolve(PROJECT, 'src/exit_link/data/simulation/communication.json'), 'utf8'));
  const building = JSON.parse(readFileSync(resolve(PROJECT, 'src/exit_link/data/simulation/building.json'), 'utf8'));
  const lay = JSON.parse(readFileSync(resolve(FRONTEND, 'src/data/building-layout.json'), 'utf8'));
  const floorOf = new Map<string, number>(building.nodes.map((n: { id: string; floor: number }) => [n.id, n.floor]));
  const commNodes = comm.nodes.map((n: { id: string; location_id: string }) => `${n.id}@${n.location_id}`).join(',');
  const commEdges = comm.edges.map((e: { source: string; target: string }) => `${e.source}-${e.target}`).join(',');
  for (const entry of cases) {
    const d = JSON.parse(readFileSync(resolve(PUB, entry.file), 'utf8')) as ReplayCase;
    const nodes = d.topology?.nodes ?? [];
    check(nodes.map((n) => `${n.id}@${n.location_id}`).join(',') === commNodes, `${entry.id}: 재생 노드·위치 = 프로젝트 communication.json`);
    check((d.topology?.edges ?? []).map(([a, b]) => `${a}-${b}`).join(',') === commEdges, `${entry.id}: 재생 링크 = 프로젝트 communication.json`);
    const pts = new Set<string>();
    for (const n of nodes) {
      const f = floorOf.get(n.location_id ?? '');
      const p = lay.places[n.location_id ?? ''];
      check(typeof f === 'number', `${entry.id}: ${n.id} 위치 ${n.location_id} 가 building.json 에 없음`);
      check(Array.isArray(p?.position), `${entry.id}: ${n.id} 위치 ${n.location_id} 가 building-layout.json 에 없음`);
      if (p && typeof f === 'number') {
        // 노드 박스(footprint) 안에 표시 좌표가 있어야 건물 모델과 어긋나지 않습니다.
        const [x, z] = p.position;
        const [x0, z0, x1, z1] = p.footprint;
        check(x >= x0 && x <= x1 && z >= z0 && z <= z1, `${entry.id}: ${n.id} 표시 좌표가 ${n.location_id} 구역 밖`);
        pts.add(`${x},${z},${f}`);
      }
    }
    check(pts.size === nodes.length, `${entry.id}: 노드 3D 좌표 중복`);
    const interFloor = (d.topology?.edges ?? []).filter(([a, b]) => {
      const la = nodes.find((n) => n.id === a)?.location_id ?? '';
      const lb = nodes.find((n) => n.id === b)?.location_id ?? '';
      return floorOf.get(la) !== floorOf.get(lb);
    });
    check(interFloor.length > 0, `${entry.id}: 층간 링크 확인 (${interFloor.map((e) => e.join('-')).join(', ')})`);
  }
}

// ── 5. CINEMATIC 연출(카메라 샷·캡션·펄스·경로 전환 빛)이 기록에만 근거하는지 ──
for (const entry of cases) {
  const d = JSON.parse(readFileSync(resolve(PUB, entry.file), 'utf8')) as ReplayCase;
  const c = entry.id;
  const before = JSON.stringify(d);
  const ids = new Set((d.topology?.nodes ?? []).map((n) => n.id));
  const end = replayDuration(d);
  const ts = [-1, 0, ...d.events.flatMap((e) => [e.offset_ms - 0.01, e.offset_ms, e.offset_ms + 0.5, e.offset_ms + 400, e.offset_ms + 1000]), end];
  const src = (id?: string) => d.events.find((e) => e.message_id === id)?.node;
  for (const t of ts) {
    const past = d.events.filter((e) => e.offset_ms <= t);
    const cap = captionAt(d, t);
    if (cap) {
      const e = d.events.find((x) => String(x.seq) === cap.key);
      check(!!e && e.offset_ms <= t && cap.t === e.offset_ms, `${c} t=${t}: 캡션은 재생 위치 이전의 기록 이벤트`);
      if (e) {
        if (cap.en === 'ACK RECEIVED') check(e.event === 'ack_received' && e.node === src(e.message_id), `${c}: ACK 캡션 = 발신 노드 ack_received 기록`);
        if (cap.en === 'TRANSMISSION FAILED') check(e.event === 'error' && d.messages.find((m) => m.message_id === e.message_id)?.result?.ack === false, `${c}: 전송 실패 캡션 = 결과 ack=false 메시지의 error 기록`);
        if (cap.en === 'ALTERNATIVE ROUTE SELECTED') check(e.event === 'route_changed' && same(cap.route, e.route), `${c}: 우회 캡션 = route_changed 기록 경로`);
        if (cap.en.includes('FAULT CONFIRMED')) check(e.event === 'fault_confirmed' && cap.en.includes(e.node ?? '?'), `${c}: 장애 캡션 = fault_confirmed 기록 노드`);
      }
    } else check(!past.some((e) => ['fault_confirmed', 'route_changed', 'error', 'neighbor_down'].includes(e.event)), `${c} t=${t}: 캡션 누락`);
    const shot = directorShot(d, t, null);
    check(shot.nodes.every((n) => ids.has(n)), `${c} t=${t}: 샷 노드는 기록 토폴로지 안`);
    if (shot.style === 'reroute') check(past.some((e) => e.event === 'route_changed'), `${c} t=${t}: 우회 샷은 route_changed 기록 이후`);
    if (shot.style === 'fault') check(past.some((e) => e.event === 'fault_confirmed'), `${c} t=${t}: 장애 샷은 fault_confirmed 기록 이후`);
    if (shot.style === 'failed') check(d.messages.some((m) => m.result?.ack === false), `${c} t=${t}: 실패 샷은 ACK 미수신 기록이 있을 때만`);
    if (!past.length) check(shot.style === 'overview', `${c}: 첫 기록 전 = 전체 보기`);
    for (const p of pulsesAt(d, t)) {
      const ok = past.some((e) => e.node === p.node && t - e.offset_ms <= PULSE_MS[p.kind] && (p.kind === 'fault' ? e.event === 'fault_confirmed' : p.kind === 'ack' ? e.event === 'ack_received' && e.node === src(e.message_id) : e.event === 'received'));
      check(ok && p.progress >= 0 && p.progress <= 1, `${c} t=${t}: 펄스 ${p.kind}@${p.node} 는 기록 이벤트 직후에만`);
    }
    const sw = routeSweepAt(d, t);
    if (sw) check(past.some((e) => e.event === 'route_changed' && t - e.offset_ms <= SWEEP_MS && same(e.route, sw.route)), `${c} t=${t}: 경로 전환 빛은 route_changed 직후에만`);
  }
  check(keyRouteShot(d).nodes.every((n) => ids.has(n)), `${c}: 발표자 집중 샷 노드는 기록 토폴로지 안`);
  check(JSON.stringify(d) === before, `${c}: 연출 계산이 기록을 바꾸지 않음`);
  if (c === 't012') {
    check(ts.every((t) => !['fault', 'reroute', 'failed'].includes(directorShot(d, t, null).style)), 't012: 장애·우회·실패 샷 없음');
    check(ts.every((t) => { const k = captionAt(d, t); return !k || k.en === 'ACK RECEIVED'; }), 't012: 캡션은 ACK 수신뿐');
  }
  if (c === 't010') {
    const k = captionAt(d, 1700);
    check(k?.en === 'ALTERNATIVE ROUTE SELECTED' && same(k.route, ['N1', 'N3', 'N4']) && same(k.oldRoute, ['N1', 'N2', 'N4']), 't010 +1700ms: 우회 캡션 N1→N2→N4 ⇒ N1→N3→N4');
    const a = captionAt(d, 1787.7);
    check(a?.en === 'ACK RECEIVED' && a.ko.includes('우회 전달 성공'), 't010 +1787.7ms: 우회 후 ACK 캡션');
    check(captionAt(d, 1559.6)?.en === 'CONNECTION FAILED — RETRY SCHEDULED', 't010 +1559.6ms: M0 연결 실패 + 재전송 예약 기록');
    const s = directorShot(d, 1600, null);
    check(s.style === 'reroute' && same(s.nodes, ['N1', 'N2', 'N3', 'N4']), 't010 +1600ms: 우회 샷 = N1·N2·N3·N4 한 프레임');
    check(directorShot(d, 4, null).style === 'overview' && directorShot(d, 5, null).style === 'fault', 't010: N2 장애 기록(+4.73ms) 전후 샷 전환');
    check(!routeSweepAt(d, 1559.9) && !!routeSweepAt(d, 1560) && !routeSweepAt(d, 1559.9714 + SWEEP_MS + 1), 't010: 경로 전환 빛은 route_changed(+1559.97ms) 기록 구간에만');
  }
  if (c === 't000') {
    check(captionAt(d, end)?.en === 'TRANSMISSION FAILED' && directorShot(d, end, null).style === 'failed', 't000 끝: 전송 실패 캡션·실패 샷');
    check(ts.every((t) => !pulsesAt(d, t).some((p) => p.kind === 'ack')), 't000: ACK 펄스 없음');
    check(ts.every((t) => !routeSweepAt(d, t)), 't000: 경로 전환 빛 없음');
  }
}

// ── 6. Overview 사례 카드 사실값 = 저장된 기록 ──
{
  const F = Object.fromEntries(cases.map((e) => [e.id, caseFacts(e, JSON.parse(readFileSync(resolve(PUB, e.file), 'utf8')) as ReplayCase)]));
  for (const e of cases) {
    const d = JSON.parse(readFileSync(resolve(PUB, e.file), 'utf8')) as ReplayCase;
    const f = F[e.id];
    check(f.acked === d.messages.filter((m) => m.result?.ack === true).length && f.total === d.messages.length, `${e.id}: 카드 ACK 수 = 결과 기록`);
    check(same(f.faults.map((x) => x.node), d.events.filter((x) => x.event === 'fault_confirmed').map((x) => x.node)), `${e.id}: 카드 장애 노드 = fault_confirmed 기록`);
    check(f.retries === d.messages.reduce((s, m) => s + (m.result?.retries ?? 0), 0), `${e.id}: 카드 재전송 = 결과 기록`);
    check((f.method === 'Fixed') === (d.cell.method === 'fixed'), `${e.id}: 카드 방식`);
  }
  check(F.t012 && same(F.t012.firstRoute, ['N1', 'N2', 'N4']) && F.t012.acked === 3 && !F.t012.faults.length && !F.t012.reroute, 't012 카드: N1→N2→N4 · ACK 3/3 · 장애 없음');
  check(F.t010 && same(F.t010.reroute?.from, ['N1', 'N2', 'N4']) && same(F.t010.reroute?.to, ['N1', 'N3', 'N4']) && same(F.t010.faults.map((x) => x.node), ['N2']) && F.t010.retries === 1 && F.t010.acked === 3, 't010 카드: N2 장애 · N1→N2→N4 ⇒ N1→N3→N4 · 재전송 1 · ACK 3/3');
  check(F.t000 && F.t000.method === 'Fixed' && F.t000.acked === 0 && same(F.t000.faults.map((x) => x.node), ['N2', 'N3']) && F.t000.errors.every((x) => x === 'connection_failed'), 't000 카드: Fixed · N2·N3 장애 · ACK 0/3 · connection_failed');
}

// ── 3. LIVE 와 분리 ──
for (const f of ['src/domain/replayEngine.ts', 'src/ui/network/ReplayMonitor.tsx', 'src/ui/replay/useReplayPlayback.ts', 'src/ui/replay/useTwinReplay.ts', 'src/ui/replay/TwinReplayPanels.tsx', 'src/three/ReplayNetworkLayer.tsx', 'src/pages/Story.tsx', 'src/ui/twin/HudTile.tsx', 'src/ui/replay/cinematicDirector.ts', 'src/ui/overview/recordedCases.ts', 'src/ui/network/NetworkHud.tsx', 'src/ui/replay/inspector.ts', 'src/ui/story/storyScenes.ts', 'src/ui/story/StoryNetwork.tsx', 'src/ui/story/useSceneProgress.ts', 'src/ui/study/caveats.ts']) {
  const text = readFileSync(resolve(FRONTEND, f), 'utf8');
  for (const bad of [/from '@\/store\//, /from '@\/api\//, /from '@\/realtime\//, /\bnew\s+WebSocket\b/, /\buseApp\b/, /method:\s*'(POST|PUT|PATCH|DELETE)'/]) {
    check(!bad.test(text), `${f}: LIVE 모듈·쓰기 요청 금지 (${bad})`);
  }
  for (const m of text.matchAll(/fetch\(([^,)]+)/g)) check(/^[`'"]\/replay\//.test(m[1].trim()), `${f}: /replay/ 정적 파일 외 fetch ${m[1]}`);
}

// TopologyFlow: 재생 중 매 프레임 새 노드 객체가 와도 React Flow 가 재측정(숨김·엣지 미표시)하지 않도록 고정 크기를 항상 넘김
{
  const tf = readFileSync(resolve(FRONTEND, 'src/ui/network/TopologyFlow.tsx'), 'utf8');
  check(/measured: \{ width: NODE_W, height: NODE_H \}/.test(tf) && /width: NODE_W,\s*height: NODE_H,/.test(tf), 'TopologyFlow: 노드 measured·width·height 고정(재생 중 토폴로지 사라짐 방지)');
  check(/measured: \{ width: BAND_W, height: BAND_H \}/.test(tf), 'TopologyFlow: 층 띠 measured 고정');
}

// STORY 장면 구간: 장면 = 사례 1개, 구간 경계는 기록 이벤트 시각과 정확히 일치
{
  const byId: Record<string, ReplayCase> = Object.fromEntries(cases.map((e) => [e.id, JSON.parse(readFileSync(resolve(PUB, e.file), 'utf8')) as ReplayCase]));
  const w = sceneWindows(byId);
  const t010 = byId.t010;
  const t012 = byId.t012;
  const srcAck = (c: ReplayCase) => c.events.filter((e) => e.event === 'ack_received' && e.node === c.events.find((x) => x.message_id === e.message_id)?.node);
  const rc = t010.events.find((e) => e.event === 'route_changed')!;
  check(w.normal?.caseId === 't012' && w.normal.t1 === srcAck(t012).at(-1)!.offset_ms, 'STORY 01: t012 · 마지막 ACK 기록 시각까지');
  const err = t010.events.filter((e) => e.event === 'error' && e.message_id === rc.message_id && e.offset_ms <= rc.offset_ms).at(-1)!;
  const recv = t010.events.find((e) => e.event === 'received' && e.message_id === rc.message_id && e.offset_ms >= rc.offset_ms)!;
  check(w.fault?.caseId === 't010' && w.fault.t1 === err.offset_ms && w.fault.focus === rc.message_id, 'STORY 02: t010 · M0 연결 실패 기록 시각까지');
  check(w.reroute?.t0 === err.offset_ms && w.reroute.t1 === recv.offset_ms, 'STORY 03: 연결 실패 → 우회 경로 목적지 수신');
  check(w.ack?.t0 === recv.offset_ms && w.ack.t1 === srcAck(t010).at(-1)!.offset_ms, 'STORY 04: 수신 → 마지막 ACK');
  for (const k of ['normal', 'fault', 'reroute', 'ack'] as const) {
    const x = w[k]!;
    check(sceneTime(x, 0) === x.t0 && sceneTime(x, 1) === x.t1 && sceneTime(x, 0.5) === (x.t0 + x.t1) / 2, `STORY ${k}: 스크롤 → 기록 시각 선형 대응`);
    for (const bt of sceneBeats(byId[x.caseId], x)) check(byId[x.caseId].events.some((e) => e.seq === bt.seq && e.offset_ms === bt.t && e.offset_ms >= x.t0 && e.offset_ms <= x.t1), `STORY ${k}: 이야기 줄 #${bt.seq} = 같은 사례 기록 이벤트(구간 안)`);
  }
  const story = readFileSync(resolve(FRONTEND, 'src/pages/Story.tsx'), 'utf8');
  for (const bad of [/from '@\/store\//, /from '@\/api\//, /from '@\/realtime\//, /\buseApp\b/, /\bfetch\(/]) check(!bad.test(story), `Story.tsx: LIVE·백엔드 금지 (${bad})`);
}

// /replay Playback Inspector: 공통 엔진만 사용 · 건물 정의는 스토어에서 읽기만 · 백엔드 요청·쓰기 없음
{
  const f = 'src/pages/Replay.tsx';
  const text = readFileSync(resolve(FRONTEND, f), 'utf8');
  for (const bad of [/from '@\/api\//, /from '@\/realtime\//, /\bnew\s+WebSocket\b/, /method:\s*'(POST|PUT|PATCH|DELETE)'/, /\bfetch\(/, /getState\(\)/, /setBuilding/, /requestAnimationFrame|setInterval/]) {
    check(!bad.test(text), `${f}: LIVE·쓰기·자체 재생 루프 금지 (${bad})`);
  }
  check([...text.matchAll(/useApp\(/g)].length === 1 && /useApp\(\(s\) => s\.building\)/.test(text), `${f}: 스토어는 건물 정의 읽기(useApp(s => s.building))만`);
  const engineImport = text.match(/import \{([^}]+)\} from '@\/domain\/replayEngine'/)?.[1] ?? '';
  for (const fn of ['loadManifest', 'loadReplayCase', 'replayDuration', 'messageProgressAt', 'nodeViewsAt', 'linkViewsAt', 'neighborViews', 'timelineMarks', 'describeEvent']) check(new RegExp(`\\b${fn}\\b`).test(engineImport), `${f}: 공통 엔진 ${fn} 사용`);
  check(/from '@\/ui\/replay\/useReplayPlayback'/.test(text) && /from '@\/ui\/network\/TopologyFlow'/.test(text), `${f}: 공통 재생 시계·토폴로지 재사용`);
  check(!/\.route\s*=|lastRecordedRoute|confirmedFaults/.test(text), `${f}: 자체 경로·장애 판정 없음(엔진 결과만 표시)`);
}

if (problems.length) {
  console.error(`verify:replay 실패 ${problems.length}/${checks}`);
  for (const p of problems.slice(0, 40)) console.error(' -', p);
  process.exit(1);
}
console.log(`verify:replay OK · 검사 ${checks}건 · 사례 ${cases.map((c) => c.id).join(', ')} · 원본 대조·엔진 해석·3D 좌표 매핑·LIVE 분리 확인`);
