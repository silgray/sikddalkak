import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
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
 * 뷰포트 폭을 실제로 줄일 수는 없으니(헤드리스 창 크기는 러너 몫) 모바일 판정만
 * 갈아끼운다. `isMobileViewport()` 는 호출 시점마다 `window.matchMedia` 를 물으므로
 * 이걸로 충분하다. 다른 질의(prefers-color-scheme 등, MathLive가 쓴다)는 그대로 넘긴다.
 */
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

  it('선택을 잡은 채로 스크롤해도 선택이 남는다', async () => {
    pretendMobile(true);
    const { mf, content } = await mount(LONG);
    mf.focus();
    mf.selection = { ranges: [[0, 3]], direction: 'forward' };
    await settle();
    const selected = selectedLatex(mf);
    expect(selected).not.toBeNull();
    // MathLive는 pointerdown 하나로 선택을 접어버린다 — 손짓이 스크롤로 판명되면
    // 되돌려야 한다. 안 그러면 잡아둔 선택을 보러 스크롤하는 것 자체가 불가능하다.
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

  it('세로로 20px(MathLive 히스테리시스)를 넘게 끌어도 선택이 안 생긴다', async () => {
    pretendMobile(true);
    const { mf, content } = await mount(LONG);
    mf.focus();
    mf.position = 0;
    await settle();
    const start = center(content);
    // pointerdown 자체는 MathLive가 정상 처리한다(캐럿 배치) — 그 처리의 일부로
    // MathLive 스스로 `preventDefault()` 를 거는 것도 정상이라 여기선 안 잰다.
    send(content, 'pointerdown', start);
    const move = send(content, 'pointermove', { x: start.x + 3, y: start.y + 30 });
    expect(mf.selectionIsCollapsed).toBe(true);
    // 우리가 막는 건 MathLive가 이 이벤트를 보는 것(`stopPropagation`)뿐이다 —
    // `preventDefault` 는 걸지 않는다, 그러면 브라우저의 세로 패닝까지 죽는다.
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
