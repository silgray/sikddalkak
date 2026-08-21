import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MathfieldElement } from 'mathlive';
import '../styles.css';
import { FieldClip } from './FieldClip';
import { MathField } from './MathField';

/**
 * 선택 범위 양끝 드래그 핸들(`SelectionHandles.tsx`)의 동작 핀.
 *
 * 계약 셋:
 *   ① 선택이 있으면 양끝에 핸들이 서고, 그 x가 **실제 원자 경계**와 맞는다
 *   ② 끝 핸들을 끌면 선택이 그쪽으로 자라고, **원자 경계로 스냅**된다
 *   ③ 양끝은 서로를 넘지 못한다 (최소 원자 하나가 남는다)
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  window.matchMedia = REAL_MATCH_MEDIA;
});

const REAL_MATCH_MEDIA = window.matchMedia.bind(window);

/** 헤드리스 창 크기는 러너 몫이라 모바일 판정만 갈아끼운다 (`mobile.ts` 참고). */
function pretendMobile(on: boolean): void {
  window.matchMedia = ((query: string) => {
    if (query.includes('640px')) {
      return {
        matches: on,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      } as unknown as MediaQueryList;
    }
    return REAL_MATCH_MEDIA(query);
  }) as typeof window.matchMedia;
}

const settle = () => new Promise((r) => setTimeout(r, 120));

type Mounted = { mf: MathfieldElement; host: HTMLElement };

async function mount(initial: string, width = 320): Promise<Mounted> {
  const host = document.createElement('div');
  host.style.width = `${width}px`;
  host.style.display = 'flex';
  document.body.append(host);
  const root: Root = createRoot(host);
  root.render(
    createElement(FieldClip, {
      watch: initial,
      children: createElement(MathField, { value: initial }),
    }),
  );
  await settle();
  const mf = host.querySelector('math-field') as MathfieldElement;
  cleanups.push(() => {
    root.unmount();
    host.remove();
  });
  return { mf, host };
}

const handles = (host: HTMLElement) => ({
  start: host.querySelector('.sel-handle-start') as HTMLElement | null,
  end: host.querySelector('.sel-handle-end') as HTMLElement | null,
});

const selectedLatex = (mf: MathfieldElement): string | null =>
  mf.selectionIsCollapsed ? null : mf.getValue(mf.selection, 'latex');

/** 핸들을 잡고 `x` 까지 끌었다 놓는다. */
function dragHandle(handle: HTMLElement, x: number, y: number): void {
  const opts = { pointerId: 7, isPrimary: true, pointerType: 'touch', bubbles: true, cancelable: true };
  handle.setPointerCapture = () => {};
  handle.releasePointerCapture = () => {};
  const from = handle.getBoundingClientRect();
  handle.dispatchEvent(
    new PointerEvent('pointerdown', { ...opts, clientX: from.left + from.width / 2, clientY: from.top }),
  );
  handle.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: x, clientY: y }));
  handle.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: x, clientY: y }));
}

describe('선택 핸들 — 양끝 조정', () => {
  it('선택이 생기면 양끝에 핸들이 서고 원자 경계에 맞는다', async () => {
    pretendMobile(true);
    const { mf, host } = await mount('1+xy');
    mf.focus();
    // `xy` (오프셋 2..4) 선택.
    mf.selection = { ranges: [[2, 4]], direction: 'forward' };
    await settle();
    expect(selectedLatex(mf)).toBe('xy');

    const { start, end } = handles(host);
    expect(start).not.toBeNull();
    expect(end).not.toBeNull();

    // 컨테이너(`.mf`) 기준 좌표가 실제 원자 상자와 맞는지 확인한다.
    const box = (host.querySelector('.mf') as HTMLElement).getBoundingClientRect();
    const x = mf.getElementInfo(3)?.bounds?.left ?? NaN; // `x` 의 왼쪽
    const yRight = mf.getElementInfo(4)?.bounds?.right ?? NaN; // `y` 의 오른쪽
    expect(start!.offsetLeft).toBeCloseTo(x - box.left, 0);
    expect(end!.offsetLeft).toBeCloseTo(yRight - box.left, 0);
  });

  it('선택이 없으면 핸들도 없다', async () => {
    pretendMobile(true);
    const { mf, host } = await mount('1+xy');
    mf.focus();
    // ⚠ `focus()` 자체가 내용을 통째로 선택한다(실측) — 캐럿만 있는 상태를 보려면
    // 명시적으로 접어야 한다.
    mf.position = 0;
    await settle();
    expect(mf.selectionIsCollapsed).toBe(true);
    expect(handles(host).start).toBeNull();
  });

  it('시작 핸들을 왼쪽으로 끌면 선택이 원자 경계로 스냅되며 자란다', async () => {
    pretendMobile(true);
    const { mf, host } = await mount('1+xy');
    mf.focus();
    mf.selection = { ranges: [[2, 4]], direction: 'forward' };
    await settle();
    const { start } = handles(host);
    // `1` 의 한가운데로 끈다 — 원자 경계(오프셋 0)까지 스냅돼야 한다.
    const one = mf.getElementInfo(1)!.bounds!;
    dragHandle(start!, one.left + one.width / 2, one.top + one.height / 2);
    await settle();
    expect(selectedLatex(mf)).toBe('1+xy');
  });

  it('끝 핸들을 왼쪽으로 끌면 선택이 줄고, 양끝을 넘지는 않는다', async () => {
    pretendMobile(true);
    const { mf, host } = await mount('1+xy');
    mf.focus();
    mf.selection = { ranges: [[0, 4]], direction: 'forward' };
    await settle();
    expect(selectedLatex(mf)).toBe('1+xy');
    const { end } = handles(host);
    // 시작(오프셋 0)보다 더 왼쪽으로 끌어도 원자 하나는 남는다.
    const one = mf.getElementInfo(1)!.bounds!;
    dragHandle(end!, one.left - 40, one.top + one.height / 2);
    await settle();
    expect(selectedLatex(mf)).toBe('1');
  });

  it('데스크톱에서는 핸들을 그리지 않는다', async () => {
    pretendMobile(false);
    const { mf, host } = await mount('1+xy');
    mf.focus();
    mf.selection = { ranges: [[2, 4]], direction: 'forward' };
    await settle();
    expect(handles(host).start).toBeNull();
  });
});
