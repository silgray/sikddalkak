import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MathfieldElement } from 'mathlive';
import '../styles.css';
import { FieldClip } from './FieldClip';
import { MathField } from './MathField';
import { contentOf } from '../editor/internals';

/**
 * 선택 범위 양끝 드래그 핸들(`SelectionHandles.tsx`)의 동작 핀.
 *
 * 계약:
 *   ① 선택이 있으면 양끝에 핸들이 서고, 그 x가 **실제 원자 경계**와 맞는다
 *   ② 끝 핸들을 끌면 선택이 그쪽으로 자라고, **원자 경계로 스냅**된다
 *   ③ 양끝은 서로를 넘지 못한다 (최소 원자 하나가 남는다)
 *   ④ 가로 스크롤(패닝)이 지나가면 핸들이 **새 위치로 따라간다**
 *      (`atomBoundsCache` 를 안 비우면 옛 좌표에 멈춘다, 실측)
 *   ⑤ 선택 끝이 보이는 범위 밖이면 **숨기지 않고 그 경계에 고정**한다
 *   ⑥ 핸들을 컨테이너 밖으로 끌어도 그 자리에서 못 나가고, 대신 자동 스크롤한다
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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 320px 셀에 확실히 안 들어가는 식. */
const LONG = String.raw`x^{10}+9x^{9}+8x^{8}+7x^{7}+6x^{6}+5x^{5}+4x^{4}+3x^{3}+2x^{2}+x+123456`;

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

const DRAG_OPTS = {
  pointerId: 7,
  isPrimary: true,
  pointerType: 'touch' as const,
  bubbles: true,
  cancelable: true,
};

/** 핸들을 잡는다. `move`/`end` 로 계속 이어가거나 사이에 기다릴 수 있다(오토스크롤 테스트용). */
function beginDrag(handle: HTMLElement): { move: (x: number, y: number) => void; end: (x: number, y: number) => void } {
  handle.setPointerCapture = () => {};
  handle.releasePointerCapture = () => {};
  const from = handle.getBoundingClientRect();
  handle.dispatchEvent(
    new PointerEvent('pointerdown', { ...DRAG_OPTS, clientX: from.left + from.width / 2, clientY: from.top }),
  );
  return {
    move: (x, y) => handle.dispatchEvent(new PointerEvent('pointermove', { ...DRAG_OPTS, clientX: x, clientY: y })),
    end: (x, y) => handle.dispatchEvent(new PointerEvent('pointerup', { ...DRAG_OPTS, clientX: x, clientY: y })),
  };
}

/** 핸들을 잡고 `x` 까지 끌었다 놓는다. */
function dragHandle(handle: HTMLElement, x: number, y: number): void {
  const drag = beginDrag(handle);
  drag.move(x, y);
  drag.end(x, y);
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

  it('문서 맨 앞이 고정 캐럿이면 더 끌어도 원자 하나는 남는다', async () => {
    // 교차는 허용하지만(아래 테스트), 넘어갈 **자리가 없으면** 겹칠 뿐이라
    // 선택이 사라진다 — 그때만 반대로 한 칸 물려 최소 하나를 남긴다.
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

  it('끝 핸들을 시작 캐럿 너머로 끌면 역할이 뒤바뀐다', async () => {
    pretendMobile(true);
    const { mf, host } = await mount('1+xy');
    mf.focus();
    // `xy` (오프셋 2..4) — 시작 캐럿이 2라 왼쪽으로 넘어갈 자리가 있다.
    mf.selection = { ranges: [[2, 4]], direction: 'forward' };
    await settle();
    expect(selectedLatex(mf)).toBe('xy');

    // 끝 핸들을 잡아 `1` 위(오프셋 0쪽)까지 끈다 — 고정 캐럿 2를 넘어간다.
    const one = mf.getElementInfo(1)!.bounds!;
    dragHandle(handles(host).end!, one.left + one.width / 2, one.top + one.height / 2);
    await settle();
    // 넘어간 쪽이 새 시작이 되어, 고정 캐럿(2) 왼쪽 구간이 잡힌다.
    expect(selectedLatex(mf)).toBe('1+');

    // 넘어간 뒤에도 쥔 핸들은 **손가락 쪽**(이제 왼쪽 끝)에 있다 — 렌더가 정체와
    // 화면상 위치를 갈라 놓지 않으면 여기서 반대편으로 순간이동한다.
    const box = (host.querySelector('.mf') as HTMLElement).getBoundingClientRect();
    const startX = mf.getElementInfo(1)!.bounds!.left;
    expect(handles(host).start!.offsetLeft).toBeCloseTo(startX - box.left, 0);
  });

  it('데스크톱에서는 핸들을 그리지 않는다', async () => {
    pretendMobile(false);
    const { mf, host } = await mount('1+xy');
    mf.focus();
    mf.selection = { ranges: [[2, 4]], direction: 'forward' };
    await settle();
    expect(handles(host).start).toBeNull();
  });

  it('가로로 스크롤하면(패닝) 핸들이 새 위치로 따라간다', async () => {
    // 회귀 핀 — MathLive는 원자 상자를 뷰포트 좌표로 캐싱하고(`atomBoundsCache`),
    // 그 캐시를 비우는 곳은 렌더 전후와 자기 pointerdown뿐이다(실측). 패닝은
    // `scrollLeft` 만 옮기고 렌더도 pointerdown도 없어서, `clearAtomBoundsCache`
    // 를 안 부르면 핸들이 스크롤 이전 좌표에 멈춰 있는다.
    pretendMobile(true);
    const { mf, host } = await mount(LONG);
    mf.focus();
    // `9` 하나만(둘째 항) — 화면 왼쪽 끝에 거의 붙은 원자(`x`)를 고르면 40px만
    // 스크롤해도 곧장 화면 밖(=핀 처리)으로 나가버려 "따라가는지" 자체를 못 잰다.
    // 지수(`^{10}`, subsup 원자)는 자기 offset에서 `getElementInfo` 가 bounds를
    // 안 주는 경우가 있어(실측) 그것도 피한다.
    mf.selection = { ranges: [[6, 7]], direction: 'forward' };
    await settle();
    const content = contentOf(mf)!;
    // `mf.focus()`/`mf.position` 만으로는 스크롤이 언제 맞춰질지 보장이 안 된다
    // (MathLive의 캐럿 추적 스크롤은 rAF에 걸린다) — 기준선을 직접 못박는다.
    content.scrollLeft = 0;
    content.dispatchEvent(new Event('scroll'));
    await settle();
    const before = handles(host).start!.offsetLeft;

    // 패닝이 하는 것과 똑같은 동작 — scrollLeft만 옮기고 MathLive 렌더는 안 돈다.
    content.scrollLeft += 40;
    content.dispatchEvent(new Event('scroll'));
    await settle();

    const after = handles(host).start!.offsetLeft;
    // 40px 스크롤했으니 컨테이너 기준 x도 그만큼(반대 방향으로) 옮겨야 한다.
    // 캐시를 못 비우면 `before` 와 그대로 같게 나온다(고쳐지기 전 증상).
    expect(after).toBeCloseTo(before - 40, 0);
  });

  it('스크롤로 선택 끝이 보이는 범위 밖으로 나가면, 숨기지 않고 경계에 고정한다', async () => {
    pretendMobile(true);
    const { mf, host } = await mount(LONG);
    mf.focus();
    // 맨 앞쪽의 좁은 범위 — 지금은 보인다.
    mf.selection = { ranges: [[0, 1]], direction: 'forward' };
    await settle();
    const content = contentOf(mf)!;
    content.scrollLeft = 0;
    content.dispatchEvent(new Event('scroll'));
    await settle();
    expect(handles(host).start).not.toBeNull();
    expect(handles(host).start!.className).not.toContain('sel-handle-pinned');

    // 끝까지 스크롤 — 방금 고른 범위가 왼쪽 밖으로 완전히 밀려난다.
    content.scrollLeft = content.scrollWidth;
    content.dispatchEvent(new Event('scroll'));
    await settle();

    const { start, end } = handles(host);
    // 사라지지 않는다 — 경계에 선다.
    expect(start).not.toBeNull();
    expect(end).not.toBeNull();
    expect(start!.className).toContain('sel-handle-pinned');

    const box = (host.querySelector('.mf') as HTMLElement).getBoundingClientRect();
    const contentBox = content.getBoundingClientRect();
    expect(start!.offsetLeft).toBeCloseTo(contentBox.left - box.left, 0);
  });

  it('핸들을 컨테이너 밖으로 끌면 자동 스크롤하며 경계 안에 머문다', async () => {
    pretendMobile(true);
    const { mf, host } = await mount(LONG);
    mf.focus();
    // `x` 하나만 — 지수(`^{10}`, subsup 원자)는 자기 offset에서 `getElementInfo`
    // 가 bounds를 안 주는 경우가 있어(실측) 걸치지 않는 안전한 범위로 고른다.
    mf.selection = { ranges: [[0, 1]], direction: 'forward' };
    await settle();
    const content = contentOf(mf)!;
    content.scrollLeft = 0;
    content.dispatchEvent(new Event('scroll'));
    await settle();
    const { end } = handles(host);
    const beforeScroll = content.scrollLeft;
    const contentBox = content.getBoundingClientRect();
    const box = (host.querySelector('.mf') as HTMLElement).getBoundingClientRect();

    const drag = beginDrag(end!);
    // 컨테이너 오른쪽 훨씬 밖 — 자동 스크롤을 걸어야 한다(32ms/16px, 실측).
    const farX = contentBox.right + 200;
    drag.move(farX, contentBox.top + 10);
    await wait(140); // 여러 틱이 지나가게
    drag.end(farX, contentBox.top + 10);
    await settle();

    expect(content.scrollLeft).toBeGreaterThan(beforeScroll);
    // 핸들 자체는 컨테이너 폭을 벗어나지 않는다.
    const finalLeft = handles(host).end!.offsetLeft;
    expect(finalLeft).toBeLessThanOrEqual(Math.round(contentBox.right - box.left) + 1);
  });
});
