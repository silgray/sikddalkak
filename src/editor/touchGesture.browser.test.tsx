import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MathfieldElement } from 'mathlive';
import '../styles.css';
import { FieldClip } from '../components/FieldClip';
import { MathField } from '../components/MathField';
import { contentOf } from './internals';

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

type Mounted = { mf: MathfieldElement; content: HTMLElement };

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
  return { mf, content };
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
    // ⚠ `focus()` 는 내용을 통째로 선택한다(실측) — 캐럿만 있는 상태로 시작한다.
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

  it('홀드 시 컨텍스트 메뉴는 막힌다', async () => {
    pretendMobile(true);
    const { mf } = await mount('1+xy');
    await settle();
    // MathLive가 길게 누름에 쏘는 것과 같은 모양 (`acceptContextMenu`, bubbles:false).
    const ev = new Event('contextmenu', { cancelable: true });
    mf.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
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
