import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MathfieldElement } from 'mathlive';
import '../styles.css';
import { FieldClip } from './FieldClip';
import { MathField } from './MathField';
import { contentOf, resolveOffsetAt } from '../editor/internals';
import { rawSelection } from '../editor/rawSelection';
import { HANDLE_CROSSING } from '../features';

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

/**
 * 손가락이 **어디를 쥐었는지**까지 정하는 드래그 — 물방울은 선택 줄 아래에
 * 매달려 있어서 실제 손가락 y는 줄 밖이다(`editor/touchAim.ts`).
 * `grabY` 를 줘서 그 상황을 그대로 재현한다.
 */
function dragHandleFrom(handle: HTMLElement, grabY: number, toX: number, dy = 0): void {
  handle.setPointerCapture = () => {};
  handle.releasePointerCapture = () => {};
  const from = handle.getBoundingClientRect();
  const grabX = from.left + from.width / 2;
  const opts = DRAG_OPTS;
  handle.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: grabX, clientY: grabY }));
  handle.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: toX, clientY: grabY + dy }));
  handle.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: toX, clientY: grabY + dy }));
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

  it('핸들 위치는 그 자리를 탭했을 때와 같다 (중앙선 기준)', async () => {
    // 원시 캐럿은 `bias 0` 으로 잡는다 — 네이티브 탭과 **같은 규칙**이라, 원자의
    // 어느 쪽 절반을 짚었느냐로 경계가 갈린다. 예전엔 ±1 로 "손가락 밑 원자를
    // 무조건 포함" 시켜서 탭 위치와 한 경계씩 어긋났다(사용자 보고).
    pretendMobile(true);
    const { mf, host } = await mount('1+xy');
    mf.focus();
    const one = mf.getElementInfo(1)!.bounds!;
    const y = one.top + one.height / 2;

    // ① `1` 의 **왼쪽 절반** → 그 앞 경계 → `1` 이 들어온다.
    mf.selection = { ranges: [[2, 4]], direction: 'forward' };
    await settle();
    dragHandle(handles(host).start!, one.left + one.width * 0.25, y);
    await settle();
    expect(selectedLatex(mf)).toBe('1+xy');

    // ② `1` 의 **오른쪽 절반** → 그 뒤 경계 → `1` 은 빠진다.
    mf.selection = { ranges: [[2, 4]], direction: 'forward' };
    await settle();
    dragHandle(handles(host).start!, one.left + one.width * 0.75, y);
    await settle();
    expect(selectedLatex(mf)).toBe('+xy');
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

  // 교차는 `features.ts` 의 `HANDLE_CROSSING` 으로 켜고 끈다 — 조작감을 견줘보려고
  // 남긴 스위치라, 두 동작을 각각 자기 플래그일 때만 검사한다.
  it.skipIf(!HANDLE_CROSSING)('끝 핸들을 시작 캐럿 너머로 끌면 역할이 뒤바뀐다', async () => {
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

  it.skipIf(HANDLE_CROSSING)('교차를 끄면 끝 핸들이 시작 캐럿을 못 넘는다', async () => {
    pretendMobile(true);
    const { mf, host } = await mount('1+xy');
    mf.focus();
    // `xy` (오프셋 2..4) — 시작 캐럿 2 왼쪽으로 넘어갈 자리가 있는데도 안 넘어간다.
    mf.selection = { ranges: [[2, 4]], direction: 'forward' };
    await settle();
    expect(selectedLatex(mf)).toBe('xy');

    const one = mf.getElementInfo(1)!.bounds!;
    dragHandle(handles(host).end!, one.left + one.width / 2, one.top + one.height / 2);
    await settle();
    // 고정 캐럿(2) 바로 오른쪽에서 멈춘다 — 원자 하나가 남는다.
    expect(selectedLatex(mf)).toBe('x');
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

/**
 * 사용자 보고 회귀 — **자식이 셋 이상**인 선택에서 핸들을 끌면 커서가 엉뚱한 데로
 * 튀었다(화면 녹화 확인).
 *
 * 원인(실측): `first` 센티넬 원자의 화면 상자를 재면 자기 자신이 아니라 **부모
 * 컨테이너 전체**가 나온다 — `getNodeBounds` 가 높이 0인 노드에서 부모로 올라가기
 * 때문이다. `x-\left(a+b\right)` 에서 root 센티넬 상자는 식 전체, 괄호 본문
 * 센티넬은 본문 전체다. MathLive의 `distance()` 는 점이 상자 **안**이면 0을 주므로,
 * 원자 사이 **빈 자리**(연산자 둘레 여백)에서는 그 센티넬만이 점을 품어 이긴다.
 * 게다가 이긴 센티넬이 **더 바깥 branch** 것일 수 있어, 괄호 안을 짚었는데 root
 * 센티넬이 나와 선택이 괄호 밖으로 옮겨간다.
 *
 * ⚠ 이 함정은 **실제 `MathField` 렌더에서만** 재현된다 — 민짜 `math-field`
 * 하네스(`editor/harness.ts`)는 줄 높이가 달라 센티넬 span이 높이 0이 안 되고,
 * 그러면 부모로 안 올라가 상자가 작게 나온다(실측). 그래서 이 스위트에 있다.
 */
describe('히트테스트 — 원자 사이 빈 자리에서 오프셋이 튀지 않는다', () => {
  const NESTED = String.raw`x-\left(a+b\right)`;

  /** 오프셋 3=본문 첫자리, 4=`a`, 5=`+`, 6=`b`, 7=괄호 전체 (실측). */
  const setup = async () => {
    const { mf, host } = await mount(NESTED);
    mf.focus();
    await settle();
    return { mf, host };
  };

  it('손가락이 오른쪽으로 갈 때 오프셋은 절대 뒤로 가지 않는다', async () => {
    pretendMobile(true);
    const { mf } = await setup();
    const field = mf.shadowRoot!.querySelector('.ML__latex')!.getBoundingClientRect();

    let prev = -1;
    let kept = 0;
    let dropped = 0;
    for (let x = Math.round(field.left) - 4; x <= Math.round(field.right) + 4; x += 1) {
      const o = resolveOffsetAt(mf, x, midYOf(mf), 1);
      if (o === null) {
        dropped += 1;
        continue;
      }
      expect(o, `x=${x} 에서 뒤로 튐 (${prev} → ${o})`).toBeGreaterThanOrEqual(prev);
      prev = o;
      kept += 1;
    }
    expect(kept).toBeGreaterThan(20);
    // 고쳐서 돌려주므로 버리는 표본은 거의 없어야 한다 — 핸들이 멈추면 안 된다.
    expect(dropped).toBeLessThan(3);
  });

  it('빈 자리를 짚어도 그 branch 안의 가장 가까운 경계로 고쳐준다', async () => {
    pretendMobile(true);
    const { mf } = await setup();
    const a = mf.getElementInfo(4)!.bounds!;
    const plus = mf.getElementInfo(5)!.bounds!;
    // 본문 첫 원자 `a` 의 왼쪽 = 본문 맨 앞. 여기선 센티넬이 정답이라 받아야 한다.
    expect(resolveOffsetAt(mf, a.left, midYOf(mf), -1)).not.toBeNull();
    // `a` 와 `+` 사이 **빈 자리**도 버리지 않는다 — 그 branch 안에서 가장 가까운
    // 경계(=`a` 뒤, 오프셋 4)로 고쳐 돌려준다.
    const gapX = (a.right + plus.left) / 2;
    expect(gapX).toBeGreaterThan(a.right); // 진짜 빈 자리인지 먼저 확인
    expect(resolveOffsetAt(mf, gapX, midYOf(mf), 1)).toBe(4);
  });

  it('괄호 **안**을 짚었는데 root 레벨 오프셋이 나오는 일은 없다', async () => {
    // 가장 고약한 경우 — `b` 와 닫는 괄호 사이 빈 자리는 원시 표본으로 **root**
    // 센티넬(오프셋 0)을 준다. 그대로 쓰면 선택이 `x-` 로, 즉 괄호 **밖**으로
    // 옮겨간다. 원시 표본이 언제 그렇게 나오는지는 레이아웃 타이밍을 타므로,
    // 여기서는 "괄호 안에서는 root 오프셋이 절대 안 나온다" 는 결과만 못박는다.
    pretendMobile(true);
    const { mf } = await setup();
    const fence = mf.getElementInfo(7)!.bounds!;

    let inside = 0;
    for (let x = Math.ceil(fence.left) + 1; x < Math.floor(fence.right); x += 1) {
      for (const bias of [-1, 0, 1] as const) {
        const o = resolveOffsetAt(mf, x, midYOf(mf), bias);
        // 0 = root `first` 센티넬. 괄호 안을 짚고 이게 나오면 선택이 식 밖으로 튄다.
        expect(o, `괄호 안 x=${x} (bias ${bias}) 에서 root 오프셋`).not.toBe(0);
      }
      inside += 1;
    }
    expect(inside).toBeGreaterThan(20);
  });
});

describe('선택 핸들 — 자기 상자가 없는 원자로 끝나거나 시작해도 안 사라진다', () => {
  // MathLive 실측: `subsup`/`box`(`\boxed`)/`enclose`(`\cancel`) 는 자기 몫 DOM이
  // 없어 `id` 가 안 생기고, `accent`(`\vec`) 는 `captureSelection` 이라 안쪽
  // 자손의 `id` 가 안 생긴다 — 그래서 `getElementInfo` 가 `bounds: undefined` 를
  // 준다. `measure()` 의 `boundsInRange` 가 선택 범위 안에서 상자가 있는 가장
  // 가까운 자리로 대신 재는지를 확인한다 (`SelectionHandles.tsx` 참고).
  it.each([
    ['x^{2}', 'x^2'],
    ['x_{2}', 'x_2'],
    ['x_{a}^{b}', 'x_{a}^{b}'],
    [String.raw`\vec{a}`, String.raw`\vec{a}`],
    [String.raw`\boxed{a}`, String.raw`\boxed{a}`],
    [String.raw`\cancel{a}`, String.raw`\cancel{a}`],
  ])('선택이 `%s` 로 끝나면 양끝 핸들이 선다', async (tail, expectedLatex) => {
    pretendMobile(true);
    const { mf, host } = await mount(String.raw`1+${tail}`);
    mf.focus();
    mf.selection = { ranges: [[2, mf.lastOffset]], direction: 'forward' };
    await settle();

    expect(selectedLatex(mf)).toBe(expectedLatex);
    const { start, end } = handles(host);
    expect(start, '시작 핸들').not.toBeNull();
    expect(end, '끝 핸들').not.toBeNull();
  });
});

describe('선택 핸들 — 쥔 자리 보정 (`editor/touchAim.ts`)', () => {
  // 물방울 손잡이는 선택 줄 **아래**에 매달려 있다(`styles.css`). 그래서 손가락
  // y는 정작 짚고 싶은 글자보다 한참 밑이고, 그대로 판정하면 줄 밖으로 나간다.
  // 쥔 순간의 손가락↔줄 한가운데 거리를 재두고 그만큼 올려 판정한다(`gripAim`).

  it('줄 아래(물방울)를 쥐어도 줄 한가운데를 쥔 것과 같은 결과가 나온다', async () => {
    // ⚠ **줄이 높은 식을 써야 이 테스트에 이빨이 생긴다.** 한 줄짜리 식은
    // 콘텐츠 상자가 줄에 딱 붙어 있어서, 보정이 없어도 `resolveOffsetAt` 의
    // 클램프가 y를 도로 줄 안으로 끌어와 우연히 같은 답이 나온다. 분수처럼
    // 상자가 높으면 클램프가 분모 줄에 떨어져 답이 갈린다.
    pretendMobile(true);
    const latex = String.raw`d+\frac{a}{bc}`;
    const sel: [number, number] = [2, 8]; // 분수 통째 — 선택 줄이 분수만큼 높다

    const dragAt = async (grabFromBelow: boolean): Promise<readonly [number, number]> => {
      const { mf, host } = await mount(latex);
      mf.focus();
      mf.selection = { ranges: [sel], direction: 'forward' };
      await settle();
      const handle = handles(host).start!;
      const line = handle.getBoundingClientRect();
      const numer = mf.getElementInfo(4)!.bounds!; // 분자 `a`
      const grabY = grabFromBelow ? line.bottom + 14 : line.top + line.height / 2;
      dragHandleFrom(handle, grabY, numer.left + numer.width / 2);
      await settle();
      return rawSelection(mf)!;
    };

    const atLine = await dragAt(false); // 줄 한가운데를 쥔 이상적인 경우
    const atKnob = await dragAt(true); // 실제로 손가락이 가는 물방울 자리
    expect(atKnob, '물방울을 쥐면 판정이 달라진다').toEqual(atLine);
  });

  it('세로 이동은 죽이지 않는다 — 손가락을 내리면 판정도 내려간다', async () => {
    // 보정이 "y를 줄 한가운데로 못박는" 것이었다면 손잡이로는 분자/분모를
    // 갈라 짚을 수 없다. 쥔 자리를 기준으로 **상대 이동이 보존**되는지 본다.
    //
    // ⚠ 여기서 보는 건 **원시 캐럿**이다. 화면에 보이는 선택으로는 확인이 안 된다 —
    // `caretRunRange` 가 "끝 캐럿이 자식 안이면 그 자식을 뺀다" 라서, 분모로
    // 내려가면 분수가 통째로 빠져 위/아래 결과가 똑같이 `d+` 로 보인다
    // (`editor/selection.ts` 참고). 보정이 사는 층은 그 앞이다.
    pretendMobile(true);
    const { mf, host } = await mount(String.raw`d+\frac{a}{bc}`);
    mf.focus();

    const readRawAfterDrag = async (dy: number): Promise<readonly [number, number]> => {
      mf.selection = { ranges: [[0, 2]], direction: 'forward' };
      await settle();
      const handle = handles(host).end!;
      const line = handle.getBoundingClientRect();
      const target = mf.getElementInfo(6)!.bounds!; // 분모 `bc` 의 `b`
      dragHandleFrom(handle, line.bottom + 14, target.left + target.width / 2, dy);
      await settle();
      return rawSelection(mf)!;
    };

    // 분모는 줄 한가운데보다 아래에 있다 — 그 거리만큼 손가락을 내린다.
    const line = handles(host).end!.getBoundingClientRect();
    const denom = mf.getElementInfo(6)!.bounds!;
    const denomDy = denom.top + denom.height / 2 - (line.top + line.height / 2);
    expect(denomDy, '분모가 줄 한가운데보다 아래인지').toBeGreaterThan(2);

    const level = await readRawAfterDrag(0);
    const down = await readRawAfterDrag(denomDy);
    expect(down[0], '내려도 판정이 그대로다 — 세로 입력이 뭉개졌다').not.toBe(level[0]);
  });
});

/** 선택 줄의 세로 한가운데 — 핸들 드래그가 히트테스트에 쓰는 그 y. */
function midYOf(mf: MathfieldElement): number {
  const b = mf.getElementInfo(1)!.bounds!;
  return b.top + b.height / 2;
}
