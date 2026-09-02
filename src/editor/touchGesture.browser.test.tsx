import { afterEach, describe, expect, it } from 'vitest';
import { createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MathfieldElement } from 'mathlive';
import '../styles.css';
import { FieldClip } from '../components/FieldClip';
import { MathField } from '../components/MathField';
import { contentOf } from './internals';
import { MOBILE_QUERY } from '../mobile';

/**
 * 모바일 터치 제스처 층(`touchGesture.ts`)의 동작 핀.
 *
 * 여기서 지키는 계약은 넷이다:
 *   ① 짧은 터치 후 가로 드래그 = **스크롤**이지 선택이 아니다
 *   ② 홀드 = 손가락 밑 **항** 선택 (몇 칸 올라가는지가 조작감의 손잡이)
 *   ③ 홀드 후 드래그 = 그 항을 **품은 채** 넓어진다
 *   ④ 데스크톱(뷰포트가 넓거나 마우스 포인터)에서는 **아무 것도 가로채지 않는다**
 *
 * 좌표는 실측한 렌더 위치를 쓴다 — `mf.getElementInfo(offset).bounds` 가 **뷰포트
 * 좌표**의 DOMRect를 준다(실측). 그래서 "이 원자 위" 라는 좌표를 폰트 메트릭에
 * 기대지 않고 직접 잰다.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  window.matchMedia = REAL_MATCH_MEDIA;
});

const REAL_MATCH_MEDIA = window.matchMedia.bind(window);

/**
 * 러너의 실제 입력 장치는 못 바꾸니(포인터 종류는 브라우저 컨텍스트 몫) 모바일
 * 판정만 갈아끼운다. `isMobileDevice()` 는 호출 시점마다 `window.matchMedia` 를
 * 물으므로 이걸로 충분하다. 다른 질의(prefers-color-scheme 등, MathLive가 쓴다)는
 * 그대로 넘긴다.
 *
 * ⚠ **`MOBILE_QUERY` 와 정확히 비교한다** — 예전엔 `'640px'` 부분 문자열로 갈랐는데,
 * 그러면 판정 기준이 바뀌는 순간 이 스텁이 아무 것도 안 가로채는 **무성 no-op** 이
 * 되고 테스트는 "스텁이 안 먹었다" 가 아니라 엉뚱한 동작 실패로 터진다.
 */
function pretendMobile(on: boolean): void {
  window.matchMedia = ((query: string) => {
    if (query === MOBILE_QUERY) {
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

type Mounted = { mf: MathfieldElement; content: HTMLElement; host: HTMLElement };

async function mount(initial: string, width = 320): Promise<Mounted> {
  const host = document.createElement('div');
  host.style.width = `${width}px`;
  host.style.display = 'flex';
  document.body.append(host);
  const root: Root = createRoot(host);
  // `FieldClip` 으로 감싸야 셀과 같은 폭 제약(`flex:1; min-width:0`)이 걸려
  // `.ML__content` 가 실제로 넘친다 — 넘치지 않으면 패닝할 것도 없다.
  root.render(
    createElement(FieldClip, {
      watch: initial,
      children: createElement(MathField, { value: initial }),
    }),
  );
  await settle();
  const mf = host.querySelector('math-field') as MathfieldElement;
  const content = contentOf(mf) as HTMLElement;
  cleanups.push(() => {
    root.unmount();
    host.remove();
  });
  return { mf, content, host };
}

type MountedTwo = { mfA: MathfieldElement; contentA: HTMLElement; mfB: MathfieldElement; contentB: HTMLElement };

/** 필드 두 개를 나란히 띄운다 — "다른(포커스 없던) 셀"을 재현하는 데 쓴다. */
async function mountTwo(a: string, b: string, width = 320): Promise<MountedTwo> {
  const host = document.createElement('div');
  document.body.append(host);
  const root: Root = createRoot(host);
  root.render(
    createElement(
      Fragment,
      null,
      createElement(
        'div',
        { style: { width: `${width}px`, display: 'flex' } },
        createElement(FieldClip, { watch: a, children: createElement(MathField, { value: a }) }),
      ),
      createElement(
        'div',
        { style: { width: `${width}px`, display: 'flex' } },
        createElement(FieldClip, { watch: b, children: createElement(MathField, { value: b }) }),
      ),
    ),
  );
  await settle();
  const fields = host.querySelectorAll('math-field');
  const mfA = fields[0] as MathfieldElement;
  const mfB = fields[1] as MathfieldElement;
  cleanups.push(() => {
    root.unmount();
    host.remove();
  });
  return { mfA, contentA: contentOf(mfA) as HTMLElement, mfB, contentB: contentOf(mfB) as HTMLElement };
}

type Pt = { x: number; y: number };

/** 오프셋 `q` 의 원자 한가운데 (뷰포트 좌표). */
function pointAt(mf: MathfieldElement, q: number): Pt {
  const b = mf.getElementInfo(q)?.bounds;
  if (b === undefined) throw new Error(`오프셋 ${q} 의 위치를 못 잰다`);
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
}

/** 요소 한가운데 (뷰포트 좌표). 스크롤 위치와 무관하게 늘 보이는 점이다. */
function center(el: Element): Pt {
  const b = el.getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
}

function send(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  pt: Pt,
  pointerType: 'touch' | 'mouse' = 'touch',
): PointerEvent {
  const ev = new PointerEvent(type, {
    pointerId: 1,
    isPrimary: true,
    pointerType,
    clientX: pt.x,
    clientY: pt.y,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  target.dispatchEvent(ev);
  return ev;
}

const selectedLatex = (mf: MathfieldElement): string | null =>
  mf.selectionIsCollapsed ? null : mf.getValue(mf.selection, 'latex');

/** 320px 셀에 확실히 안 들어가는 식. */
const LONG = String.raw`x^{10}+9x^{9}+8x^{8}+7x^{7}+6x^{6}+5x^{5}+4x^{4}+3x^{3}+2x^{2}+x+123456`;

describe('터치 제스처 — 스크롤과 선택 가르기', () => {
  it('짧은 터치 후 가로 드래그는 스크롤한다 (선택이 안 생긴다)', async () => {
    pretendMobile(true);
    const { mf, content } = await mount(LONG);
    mf.focus();
    await settle();
    // 포커스는 캐럿을 식 끝에 두고 MathLive가 거기까지 스크롤해 둔다 — 그래서
    // 지금은 **뒤쪽**이 보이고, 앞을 보려면 손가락을 오른쪽으로 끌어야 한다.
    // 캐럿을 식 끝에 명시적으로 둔다 — 이 테스트가 보는 건 그 자리에서의 패닝이다.
    mf.position = mf.lastOffset;
    const before = content.scrollLeft;
    expect(before).toBeGreaterThan(0);
    const start = center(content);
    send(content, 'pointerdown', start);
    // 임계(8px) 를 넘는 가로 이동 — 홀드 타이머(450ms)보다 훨씬 빠르게.
    send(content, 'pointermove', { x: start.x + 20, y: start.y });
    send(content, 'pointermove', { x: start.x + 60, y: start.y });
    send(content, 'pointerup', { x: start.x + 60, y: start.y });
    await settle();
    expect(content.scrollLeft).toBe(before - 60);
    expect(mf.selectionIsCollapsed).toBe(true);
  });

  it('가로 드래그가 끝나도 캐럿 위치가 유지된다 (셀 끝으로 튀지 않는다)', async () => {
    // 위 테스트는 드래그 전에 캐럿을 이미 `lastOffset`에 놔둬서 "끝으로 튀는"
    // 버그와 정상 상태가 우연히 구별이 안 된다 — 여기서는 끝이 아닌 자리(3)에
    // 캐럿을 두고, 드래그가 끝난 뒤에도 그 자리 그대로인지를 직접 잰다.
    pretendMobile(true);
    const { mf, content } = await mount(LONG);
    mf.focus();
    await settle();
    // `mf.position = 3` 는 scrollLeft를 안 건드린다(실측) — focus()가 캐럿을
    // 식 끝에 두며 이미 밀어둔 scrollLeft(최댓값)가 그대로 남는다. 그래서
    // 오른쪽으로 끌어야(scrollLeft가 줄어드는 방향) 클램프에 안 걸리고 실제로
    // 움직인다.
    mf.position = 3;
    await settle();
    const before = content.scrollLeft;
    expect(before).toBeGreaterThan(0);
    const start = center(content);
    send(content, 'pointerdown', start);
    send(content, 'pointermove', { x: start.x + 20, y: start.y });
    send(content, 'pointermove', { x: start.x + 60, y: start.y });
    send(content, 'pointerup', { x: start.x + 60, y: start.y });
    await settle();
    // 패닝 자체는 여전히 된다.
    expect(content.scrollLeft).toBeLessThan(before);
    // 하지만 캐럿은 드래그 전 자리로 되돌아간다 — 끝(lastOffset)으로 안 튄다.
    expect(mf.position).toBe(3);
    expect(mf.selectionIsCollapsed).toBe(true);
  });

  it('선택을 잡은 채로 스크롤해도 선택이 남는다', async () => {
    pretendMobile(true);
    const { mf, content } = await mount(LONG);
    mf.focus();
    mf.selection = { ranges: [[0, 3]], direction: 'forward' };
    await settle();
    const selected = selectedLatex(mf);
    expect(selected).not.toBeNull();
    // pointerdown을 삼키므로 MathLive는 이 손짓을 아예 못 본다 — 선택을 접을
    // 기회 자체가 없다. 잡아둔 선택을 보러 스크롤하는 게 그래서 자연히 된다.
    const start = center(content);
    send(content, 'pointerdown', start);
    send(content, 'pointermove', { x: start.x + 20, y: start.y });
    send(content, 'pointermove', { x: start.x + 60, y: start.y });
    send(content, 'pointerup', { x: start.x + 60, y: start.y });
    await settle();
    expect(selectedLatex(mf)).toBe(selected);
  });

  it('세로 드래그로 페이지를 스크롤해도 선택이 남는다', async () => {
    pretendMobile(true);
    const { mf, content } = await mount(LONG);
    mf.focus();
    mf.selection = { ranges: [[0, 3]], direction: 'forward' };
    await settle();
    const selected = selectedLatex(mf);
    const start = center(content);
    send(content, 'pointerdown', start);
    send(content, 'pointermove', { x: start.x + 2, y: start.y + 40 });
    send(content, 'pointerup', { x: start.x + 2, y: start.y + 40 });
    await settle();
    expect(selectedLatex(mf)).toBe(selected);
  });

  it('세로 드래그는 가로 스크롤로 삼키지 않는다 (페이지 스크롤 몫)', async () => {
    pretendMobile(true);
    const { mf, content } = await mount(LONG);
    mf.focus();
    await settle();
    const before = content.scrollLeft;
    const start = pointAt(mf, 2);
    send(content, 'pointerdown', start);
    send(content, 'pointermove', { x: start.x - 3, y: start.y + 30 });
    send(content, 'pointermove', { x: start.x - 5, y: start.y + 80 });
    send(content, 'pointerup', { x: start.x - 5, y: start.y + 80 });
    await settle();
    expect(content.scrollLeft).toBe(before);
  });

  it('홀드하면 손가락 밑 항이 선택된다', async () => {
    pretendMobile(true);
    const { mf, content } = await mount('1+xy');
    mf.focus();
    await settle();
    const over = pointAt(mf, 4); // `y` 위
    send(content, 'pointerdown', over);
    await wait(600);
    // 원자(`y`) 가 아니라 곱셈 항(`xy`) 까지 올라간다 — HOLD_EXPAND_STEPS = 2.
    expect(selectedLatex(mf)).toBe('xy');
    send(content, 'pointerup', over);
  });

  it('홀드 후 드래그는 그 항을 품은 채 넓어진다', async () => {
    pretendMobile(true);
    const { mf, content } = await mount('1+xy');
    mf.focus();
    await settle();
    const over = pointAt(mf, 4); // `y`
    send(content, 'pointerdown', over);
    await wait(600);
    expect(selectedLatex(mf)).toBe('xy');
    // 왼쪽 끝(`1`)까지 끌면 시작 항을 품은 채 식 전체가 된다.
    const left = pointAt(mf, 1);
    send(content, 'pointermove', { x: left.x - 4, y: left.y });
    send(content, 'pointerup', { x: left.x - 4, y: left.y });
    await settle();
    expect(selectedLatex(mf)).toBe('1+xy');
  });

  it('홀드가 성립한 뒤에는 세로 손짓을 브라우저에 안 넘긴다 (touchmove 취소)', async () => {
    // `touch-action: pan-y` 로 세로를 브라우저에 넘겨 뒀지만(위 셰도우 CSS 핀),
    // 홀드 선택이 잡힌 뒤의 세로 드래그는 분자/분모를 갈라 짚는 우리 손짓이다.
    // `touch-action` 은 손짓 도중에 못 바꾸므로 아직 시작 안 된 패닝을 취소한다.
    pretendMobile(true);
    const { mf, content } = await mount('1+xy');
    mf.focus();
    await settle();
    const over = pointAt(mf, 4);
    send(content, 'pointerdown', over);
    // 아직 모드가 안 정해졌으면 브라우저 몫이다 — 건드리지 않는다.
    const early = new Event('touchmove', { bubbles: true, cancelable: true, composed: true });
    content.dispatchEvent(early);
    expect(early.defaultPrevented, '판정 전에는 스크롤을 뺏지 않는다').toBe(false);

    await wait(600); // 홀드 성립
    expect(selectedLatex(mf)).toBe('xy');
    const held = new Event('touchmove', { bubbles: true, cancelable: true, composed: true });
    content.dispatchEvent(held);
    expect(held.defaultPrevented, '홀드 중에는 세로 손짓도 우리 것이다').toBe(true);
    send(content, 'pointerup', over);
  });

  it('세로로 크게 끌어도 선택이 안 생기고, 세로 패닝은 안 막는다', async () => {
    pretendMobile(true);
    const { mf, content } = await mount(LONG);
    mf.focus();
    mf.position = 0;
    await settle();
    const start = center(content);
    // pointerdown은 우리가 삼킨다 — MathLive는 이 손짓을 아예 못 본다.
    send(content, 'pointerdown', start);
    const move = send(content, 'pointermove', { x: start.x + 3, y: start.y + 30 });
    expect(mf.selectionIsCollapsed).toBe(true);
    // vscroll 확정은 `stopPropagation` 만 한다 — `preventDefault` 는 안 건다,
    // 그러면 브라우저의 세로 패닝까지 죽는다.
    expect(move.defaultPrevented).toBe(false);
    send(content, 'pointerup', { x: start.x + 3, y: start.y + 30 });
  });

  it('홀드 드래그가 중첩 구조를 넘어 넓어진 뒤에도, 핸들로 다시 좁힐 수 있다', async () => {
    // 회귀 핀 — `editor/rawSelection.ts` 가 없던 시절엔 핸들이 "지금 보이는(이미
    // 넓어진) 선택"만 알아서, 한쪽 핸들을 아무리 안으로 끌어도 반대쪽이 escalate된
    // 경계(예: 문서 맨 앞)에 박혀 있어 절대 좁혀지지 않았다. 분수를 쓰는 이유:
    // 평평한 식(`1+xy`)은 원시 캐럿이 우연히 스냅된 값과 같아져 이 차이가 안 드러난다
    // — `\frac{a}{bc}+d` 에서 분모 안 'c'를 홀드하면(`HOLD_EXPAND_STEPS=2`가
    // 분모 branch 전체 'bc'까지만 오른다) 원시 시작 캐럿이 분모 **안**(라텍 상
    // 오프셋 3)에 남는데, 넓히는 동안 보이는 선택은 분수를 통째로 감싸야 해서
    // 훨씬 바깥(오프셋 0)으로 스냅된다 — 그 간극이 이 테스트의 핵심이다.
    pretendMobile(true);
    const { mf, content, host } = await mount(String.raw`\frac{a}{bc}+d`);
    mf.focus();
    await settle();
    const over = pointAt(mf, 5); // 'c' — 분모 안
    send(content, 'pointerdown', over);
    await wait(600);
    // 사다리 2칸: 원자('c') → 분모 branch 전체('bc'). 아직 분수 밖으로는 안 나갔다.
    expect(selectedLatex(mf)).toBe('bc');

    // 분수를 넘어 'd' 까지 끌면, 분수는 반쪽만 드러낼 수 없어 전체로 스냅된다.
    const dPos = pointAt(mf, 8);
    send(content, 'pointermove', dPos);
    send(content, 'pointerup', dPos);
    await settle();
    expect(selectedLatex(mf)).toBe(String.raw`\frac{a}{bc}+d`);

    // 손을 뗀 뒤 — **끝 핸들만** 따로 잡아 분모 안('c')으로 되돌린다.
    const endHandle = host.querySelector('.sel-handle-end') as HTMLElement;
    expect(endHandle).not.toBeNull();
    const cPos = pointAt(mf, 5);
    const opts = {
      pointerId: 11,
      isPrimary: true,
      pointerType: 'touch' as const,
      bubbles: true,
      cancelable: true,
    };
    const from = endHandle.getBoundingClientRect();
    endHandle.dispatchEvent(
      new PointerEvent('pointerdown', { ...opts, clientX: from.left + from.width / 2, clientY: from.top }),
    );
    endHandle.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: cPos.x, clientY: cPos.y }));
    endHandle.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: cPos.x, clientY: cPos.y }));
    await settle();
    // 정확히 어느 원자에서 스냅됐는지(`b`/`bc`)는 픽셀 바이어스에 달렸고 그건
    // `selectionHandles.browser.test.tsx` 가 이미 따로 잰다 — 여기서 잡는 계약은
    // "분수 밖(`+d`)까지 다시 끌려가지 않는다"는 **좁혀짐 자체**다. 고쳐지기
    // 전엔 반대쪽(시작) 핸들이 escalate된 오프셋 0에 박혀 있어 이 좁혀짐 자체가
    // 불가능했다.
    const shrunk = selectedLatex(mf);
    expect(shrunk).not.toBeNull();
    expect(shrunk).not.toContain('+');
    expect(shrunk).not.toContain('d');
  });

  it('홀드 시 컨텍스트 메뉴는 막힌다', async () => {
    pretendMobile(true);
    const { mf } = await mount('1+xy');
    await settle();
    // MathLive가 길게 누름에 쏘는 것과 같은 모양 (`acceptContextMenu`, bubbles:false).
    const ev = new Event('contextmenu', { cancelable: true });
    mf.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('셀 위의 세로 손짓은 브라우저에 남긴다 — 셰도우 안쪽 touch-action', async () => {
    // 회귀 핀 — 셀 안에서 시작한 손짓으로는 페이지가 아예 안 굴러갔다(사용자 보고).
    // MathLive가 `.ML__container` 에 `touch-action: none` 을 걸어, 호스트에 걸어둔
    // `pan-y`(`styles/selectionHandles.css`)를 교집합으로 무효화하기 때문이다.
    // 셰도우 DOM 안이라 전역 CSS로는 못 닿아 `MathField.tsx` 의 `SHADOW_CSS` 가 덮는다.
    // 실제 적용 여부는 러너 창 폭에 달려 있으므로(미디어쿼리는 진짜 뷰포트를 본다)
    // **규칙이 실려 있는지**와 **임계값이 `MOBILE_QUERY` 인지**를 본다.
    const { mf } = await mount('1+xy');
    const rules = mf
      .shadowRoot!.adoptedStyleSheets.flatMap((sheet) => [...sheet.cssRules])
      .filter((rule): rule is CSSMediaRule => rule instanceof CSSMediaRule);
    const mobile = rules.filter((rule) => rule.conditionText === MOBILE_QUERY);
    expect(mobile.length, `모바일 블록이 없다 (${MOBILE_QUERY})`).toBeGreaterThan(0);
    const text = mobile.flatMap((rule) => [...rule.cssRules]).map((rule) => rule.cssText);
    expect(text.some((css) => css.includes('.ML__container') && css.includes('pan-y'))).toBe(true);
  });

  it('포커스가 없는 다른 셀에서 가로 드래그를 시작해도 포커스·캐럿이 안 바뀐다', async () => {
    pretendMobile(true);
    const { mfA, mfB, contentB } = await mountTwo('x+y', LONG);
    mfA.focus();
    mfA.position = 1;
    await settle();
    expect(document.activeElement).toBe(mfA);

    const before = contentB.scrollLeft;
    const start = center(contentB);
    send(contentB, 'pointerdown', start);
    send(contentB, 'pointermove', { x: start.x - 20, y: start.y });
    send(contentB, 'pointermove', { x: start.x - 60, y: start.y });
    send(contentB, 'pointerup', { x: start.x - 60, y: start.y });
    await settle();

    // B는 실제로 스크롤됐다 — 드래그 자체는 여전히 동작한다.
    expect(contentB.scrollLeft).toBeGreaterThan(before);
    // 하지만 포커스와 캐럿은 A에 그대로 있다 — B로 안 넘어갔다.
    expect(document.activeElement).toBe(mfA);
    expect(document.activeElement).not.toBe(mfB);
    expect(mfA.position).toBe(1);
  });

  it('포커스가 없는 다른 셀에서 세로 드래그를 시작해도 포커스·캐럿이 안 바뀐다', async () => {
    pretendMobile(true);
    const { mfA, mfB, contentB } = await mountTwo('x+y', LONG);
    mfA.focus();
    mfA.position = 1;
    await settle();

    const start = center(contentB);
    send(contentB, 'pointerdown', start);
    send(contentB, 'pointermove', { x: start.x + 2, y: start.y + 40 });
    send(contentB, 'pointerup', { x: start.x + 2, y: start.y + 40 });
    await settle();

    expect(document.activeElement).toBe(mfA);
    expect(document.activeElement).not.toBe(mfB);
    expect(mfA.position).toBe(1);
  });

  it('포커스가 없는 다른 셀을 홀드하면 포커스가 그 셀로 넘어간다 (유지되는 동작)', async () => {
    // 대조군 — 위 두 테스트와 달리 홀드는 다른 셀을 골라 선택하는 손짓이라
    // 포커스가 넘어가는 게 맞는 동작이다. 이번 수정이 실수로 이걸 깨뜨리지
    // 않았는지 못 박아 둔다.
    pretendMobile(true);
    const { mfA, mfB, contentB } = await mountTwo('x+y', '1+xy');
    mfA.focus();
    await settle();
    expect(document.activeElement).toBe(mfA);

    const over = pointAt(mfB, 4); // 'y' 위 — HOLD_EXPAND_STEPS=2로 'xy'가 잡힌다.
    send(contentB, 'pointerdown', over);
    await wait(600);
    await settle();

    expect(document.activeElement).toBe(mfB);
    expect(selectedLatex(mfB)).toBe('xy');
    send(contentB, 'pointerup', over);
  });

  it('데스크톱(넓은 뷰포트)에서는 아무 것도 가로채지 않는다', async () => {
    pretendMobile(false);
    const { mf, content } = await mount(LONG);
    mf.focus();
    await settle();
    const before = content.scrollLeft;
    const start = pointAt(mf, 2);
    send(content, 'pointerdown', start, 'mouse');
    send(content, 'pointermove', { x: start.x - 60, y: start.y }, 'mouse');
    send(content, 'pointerup', { x: start.x - 60, y: start.y }, 'mouse');
    await settle();
    // 우리 패닝이 안 돈다.
    expect(content.scrollLeft).toBe(before);
    // 우클릭 메뉴도 그대로 열린다.
    const ev = new Event('contextmenu', { cancelable: true });
    mf.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe('터치 제스처 — 탭이 직접 캐럿을 놓는다 (pointerdown 원천 차단)', () => {
  // pointerdown을 삼킨 뒤로는 이 앱이 탭의 캐럿 배치를 전부 책임진다
  // (`placeCaretAt`) — 예전엔 MathLive에 맡겨서 여기 대응하는 핀이 하나도
  // 없었다.

  it('누르기만 해서는(pointerup 전) 아무 일도 안 일어난다', async () => {
    // 원천 차단의 핵심 계약 — 예전 사후 복구 방식에서는 이 시점에 이미 B로
    // 포커스가 넘어가 있었다. 지금은 판정(탭/드래그/홀드) 전까지 그 무엇도 안
    // 바뀐다.
    pretendMobile(true);
    const { mfA, mfB, contentB } = await mountTwo('x+y', '1+xy');
    mfA.focus();
    mfA.position = 1;
    await settle();

    send(contentB, 'pointerdown', pointAt(mfB, 2));
    await settle();

    expect(document.activeElement).toBe(mfA);
    expect(mfA.position).toBe(1);
    // B는 여전히 포커스도 캐럿도 없다 — MathLive가 아무 것도 못 받았다.
    expect(document.activeElement).not.toBe(mfB);
  });

  it('탭하면 그 자리에 캐럿이 선다', async () => {
    pretendMobile(true);
    const { mf, content } = await mount('1+xy');
    await settle();
    const at = pointAt(mf, 3); // 'x' 위
    send(content, 'pointerdown', at);
    send(content, 'pointerup', at);
    await settle();
    expect(document.activeElement).toBe(mf);
    expect(mf.position).toBe(3);
    expect(mf.selectionIsCollapsed).toBe(true);
  });

  it('포커스 없던 셀을 탭하면 포커스가 그리로 가고 캐럿도 그 자리에 선다', async () => {
    pretendMobile(true);
    const { mfA, mfB, contentB } = await mountTwo('x+y', '1+xy');
    mfA.focus();
    await settle();
    expect(document.activeElement).toBe(mfA);

    const at = pointAt(mfB, 3); // 'x' 위
    send(contentB, 'pointerdown', at);
    send(contentB, 'pointerup', at);
    await settle();

    expect(document.activeElement).toBe(mfB);
    expect(mfB.position).toBe(3);
    expect(mfB.selectionIsCollapsed).toBe(true);
  });

  it('placeholder를 탭하고 타이핑하면 그 자리가 치환된다', async () => {
    // 실측 확인: MathLive는 pointerdown에서 placeholder를 통째로 선택하는
    // 특례(collapsed=false)를 갖지만, `placeCaretAt`은 그걸 복제하지 않고
    // 접힌 캐럿만 놓는다. 그런데도 타이핑이 placeholder를 치환하는 건
    // MathLive의 **입력 경로** 자체가 "placeholder 앞 캐럿" 을 따로 인식해서
    // 하는 일이라(`MathField.tsx`의 input 핸들러, CLAUDE.md 참고), 탭이 선택을
    // 안 만들어도 그대로 된다 — 그래서 특례를 복제하지 않기로 했다.
    pretendMobile(true);
    const { mf, content } = await mount(String.raw`\sqrt{\placeholder{}}`);
    await settle();
    const at = pointAt(mf, 2); // placeholder 위
    send(content, 'pointerdown', at);
    send(content, 'pointerup', at);
    await settle();
    mf.executeCommand(['typedText', 'x', { simulateKeystroke: true }]);
    await settle();
    expect(mf.value).toBe(String.raw`\sqrt{x}`);
  });
});
