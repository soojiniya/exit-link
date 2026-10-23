import type { ReactNode } from 'react';
import { SectionLabel } from './primitives';

/** 다음 단계에서 구현할 페이지. 가짜 수치를 채우지 않고 계획과 사용할 실제 API만 표시합니다. */
export function PlannedPage({ title, question, items, apis, children }: { title: string; question: string; items: string[]; apis: string[]; children?: ReactNode }) {
  return (
    <div className="panel-scroll h-full px-10 py-8">
      <div className="text-2xs text-ink-3">EXIT-LINK / {title}</div>
      <h1 className="mt-1 text-[32px] font-light tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-ink-2">{question}</p>
      <div className="mt-2 inline-flex rounded-md border border-warn/30 bg-warn/10 px-2 py-1 text-2xs text-[#EDAA6B]">다음 구현 단계 — 현재는 화면 구조만 준비되어 있습니다</div>
      {children && <div className="mt-6">{children}</div>}
      <div className="mt-8 grid max-w-4xl grid-cols-2 gap-6">
        <div className="rounded-xl border border-line bg-panel p-5">
          <SectionLabel>예정 구성</SectionLabel>
          <ul className="space-y-1.5 text-xs text-ink-2">{items.map((i) => <li key={i}>· {i}</li>)}</ul>
        </div>
        <div className="rounded-xl border border-line bg-panel p-5">
          <SectionLabel>사용할 실제 API</SectionLabel>
          <ul className="space-y-1.5 font-mono text-2xs text-ink-2">{apis.map((i) => <li key={i}>{i}</li>)}</ul>
        </div>
      </div>
    </div>
  );
}
