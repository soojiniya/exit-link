import type { ServerFrame } from '@contracts';
import { call, WS_URL } from '@/api/client';
import { useApp } from '@/store/store';
import type { Snapshot, StreamEvent } from '@/store/types';
import { isPublicDemo } from '@/domain/mode';

/**
 * WebSocket 스트림 처리 (docs/stage-5-api-guide.md "WebSocket 이벤트 계약").
 * - 연결 직후 snapshot 1개로 상태 교체
 * - 같은 stream_id에서 sequence <= 적용 번호는 무시
 * - 번호가 비면 /events로 보충, reset_required 또는 stream_id 변경이면 /snapshot으로 교체
 * - 공개 읽기 전용 API(exit_link.public_app)에는 /events 가 없으므로 공개 데모에서는 /events 를 부르지 않습니다.
 *   기록 불러오기는 건너뛰고, 번호가 비면 바로 /snapshot 으로 교체합니다.
 * - 서버로는 아무 데이터도 보내지 않음(보내면 1008로 닫힘)
 */
class EventStream {
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer: number | null = null;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.timer) window.clearTimeout(this.timer);
    this.ws?.close();
  }

  private connect() {
    const { setConn } = useApp.getState();
    setConn(this.retry === 0 ? 'connecting' : 'reconnecting', useApp.getState().connError);
    let ws: WebSocket;
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      this.scheduleReconnect(`WebSocket 생성 실패: ${(e as Error).message}`);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
    };
    ws.onmessage = (msg) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(msg.data)) as ServerFrame;
      } catch {
        return;
      }
      // 프레임 순서를 보장하기 위해 직렬 큐에서 처리합니다.
      this.queue = this.queue.then(() => this.handle(frame)).catch((e) => console.error('[stream]', e));
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      const reason =
        ev.code === 1013 ? '클라이언트 큐 초과(1013) — 재접속 후 snapshot으로 복구합니다' :
        ev.code === 1008 ? '정책 위반(1008)으로 종료' :
        ev.code === 1006 ? '백엔드에 연결할 수 없음' : `연결 종료(${ev.code})`;
      this.scheduleReconnect(reason);
    };
  }

  private scheduleReconnect(reason: string) {
    useApp.getState().setConn('reconnecting', reason);
    const delay = Math.min(10_000, 800 * 2 ** this.retry);
    this.retry += 1;
    this.timer = window.setTimeout(() => this.connect(), delay);
  }

  private async handle(frame: ServerFrame) {
    const st = useApp.getState();
    if (frame.type === 'snapshot') {
      const fresh = st.streamId !== frame.payload.stream_id;
      st.replaceSnapshot(frame.payload);
      st.setConn('open', null);
      if (fresh) void this.loadHistory(frame.payload.stream_id, frame.payload.sequence);
      return;
    }
    const ev = frame as StreamEvent;
    if (ev.stream_id !== st.streamId) {
      await this.resnapshot();
      return;
    }
    if (ev.sequence <= st.sequence) return;
    if (ev.sequence > st.sequence + 1) {
      await this.fillGap(st.streamId, st.sequence);
      const current = useApp.getState();
      if (ev.stream_id !== current.streamId || current.sequence >= ev.sequence) return;
      if (ev.sequence !== current.sequence + 1) {
        await this.resnapshot();
        return;
      }
    }
    useApp.getState().applyEvent(ev);
  }

  /** 새로 연결한 경우 서버 보관 창(최근 512개)의 이벤트를 기록으로 불러옵니다. */
  private async loadHistory(streamId: string, sequence: number) {
    if (isPublicDemo()) return; // 공개 API 에 없는 경로 — 현재 상태 표시는 snapshot 으로 충분합니다
    try {
      const page = await call('GET /api/v1/events', { query: { stream_id: streamId, after: Math.max(0, sequence - 511) } });
      if (!page.reset_required) useApp.getState().ingestHistory(page.events as StreamEvent[]);
    } catch {
      /* 기록이 없어도 현재 상태 표시는 가능합니다 */
    }
  }

  private async fillGap(streamId: string, after: number) {
    useApp.getState().setConn('resyncing', null);
    if (isPublicDemo()) {
      await this.resnapshot(); // 공개 API 에는 /events 가 없으므로 snapshot 으로 다시 맞춥니다
      return;
    }
    try {
      const page = await call('GET /api/v1/events', { query: { stream_id: streamId, after } });
      if (page.reset_required || page.stream_id !== streamId) {
        await this.resnapshot();
        return;
      }
      for (const e of page.events) {
        const cur = useApp.getState();
        if ((e as StreamEvent).sequence > cur.sequence) cur.applyEvent(e as StreamEvent);
      }
      useApp.getState().setConn('open', null);
    } catch {
      await this.resnapshot();
    }
  }

  private async resnapshot() {
    useApp.getState().setConn('resyncing', null);
    try {
      const snap = await call('GET /api/v1/snapshot');
      useApp.getState().replaceSnapshot(snap as unknown as Snapshot);
      useApp.getState().setConn('open', null);
    } catch (e) {
      useApp.getState().setConn('reconnecting', (e as Error).message);
    }
  }
}

export const eventStream = new EventStream();

export async function loadBuilding() {
  const { setBuilding } = useApp.getState();
  try {
    setBuilding(await call('GET /api/v1/building'), null);
  } catch (e) {
    setBuilding(null, (e as Error).message);
    window.setTimeout(loadBuilding, 3000);
  }
}
