import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import type { MathfieldElement } from 'mathlive';
import { MathField } from './MathField';
import {
  getActiveMathField,
  getFocusedMathField,
  isFieldFocused,
  subscribeFieldFocus,
} from '../editor/activeField';

/**
 * `MathField` 의 셀 조작 단축키(Enter 계열, Alt+화살표) 회귀 테스트.
 * `editor/editor.browser.test.tsx` 의 `mountMathField` 와 같은 규율 —
 * `mf.dispatchEvent(new KeyboardEvent(...))` 로 실제 이벤트 경로를 그대로 탄다.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const settle = () => new Promise((r) => setTimeout(r, 60));

type Handlers = {
  onEnter: (latex: string) => void;
  onInsertCell: (position: 'above' | 'below') => void;
  onMoveGroup: (delta: -1 | 1, caret: number) => void;
  onDuplicate: (position: 'above' | 'below', caret: number) => void;
};

async function mount(initial = 'x'): Promise<{ mf: MathfieldElement; handlers: Handlers; root: Root }> {
  const host = document.createElement('div');
  document.body.append(host);
  const handlers: Handlers = {
    onEnter: vi.fn<(latex: string) => void>(),
    onInsertCell: vi.fn<(position: 'above' | 'below') => void>(),
    onMoveGroup: vi.fn<(delta: -1 | 1, caret: number) => void>(),
    onDuplicate: vi.fn<(position: 'above' | 'below', caret: number) => void>(),
  };
  const root = createRoot(host);
  root.render(createElement(MathField, { value: initial, ...handlers }));
  await new Promise((r) => setTimeout(r, 30));
  const mf = host.querySelector('math-field') as MathfieldElement;
  cleanups.push(() => {
    root.unmount();
    host.remove();
  });
  mf.focus();
  await settle();
  return { mf, handlers, root };
}

function press(mf: MathfieldElement, key: string, mods: Partial<KeyboardEventInit> = {}) {
  mf.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }));
}

describe('MathField — ☰ 메뉴 정리', () => {
  it('Insert 서브메뉴는 없고 Insert matrix는 남는다', async () => {
    const { mf } = await mount();
    type Item = { id?: string };
    const ids = (mf.menuItems as Item[]).map((item) => item.id);
    expect(ids).not.toContain('insert');
    expect(ids).toContain('insert-matrix');
  });
});

describe('MathField — Enter 계열 단축키', () => {
  it('맨 Enter는 onEnter만 부른다', async () => {
    const { mf, handlers } = await mount();
    press(mf, 'Enter');
    await settle();
    expect(handlers.onEnter).toHaveBeenCalledWith('x');
    expect(handlers.onInsertCell).not.toHaveBeenCalled();
  });

  it('Ctrl+Enter는 onInsertCell("below")만 부른다', async () => {
    const { mf, handlers } = await mount();
    press(mf, 'Enter', { ctrlKey: true });
    await settle();
    expect(handlers.onInsertCell).toHaveBeenCalledWith('below');
    expect(handlers.onEnter).not.toHaveBeenCalled();
  });

  it('Ctrl+Shift+Enter는 onInsertCell("above")만 부른다', async () => {
    const { mf, handlers } = await mount();
    press(mf, 'Enter', { ctrlKey: true, shiftKey: true });
    await settle();
    expect(handlers.onInsertCell).toHaveBeenCalledWith('above');
    expect(handlers.onEnter).not.toHaveBeenCalled();
  });

  it('Alt+Enter/Shift+Enter(정의 안 된 조합)는 아무 핸들러도 안 부른다', async () => {
    const { mf, handlers } = await mount();
    press(mf, 'Enter', { altKey: true });
    press(mf, 'Enter', { shiftKey: true });
    await settle();
    expect(handlers.onEnter).not.toHaveBeenCalled();
    expect(handlers.onInsertCell).not.toHaveBeenCalled();
  });
});

describe('MathField — Alt+↑/↓ (그룹 이동·복제)', () => {
  it('Alt+↑ 는 onMoveGroup(-1)', async () => {
    const { mf, handlers } = await mount();
    press(mf, 'ArrowUp', { altKey: true });
    await settle();
    expect(handlers.onMoveGroup).toHaveBeenCalledWith(-1, expect.any(Number));
    expect(handlers.onDuplicate).not.toHaveBeenCalled();
  });

  it('Alt+↓ 는 onMoveGroup(1)', async () => {
    const { mf, handlers } = await mount();
    press(mf, 'ArrowDown', { altKey: true });
    await settle();
    expect(handlers.onMoveGroup).toHaveBeenCalledWith(1, expect.any(Number));
  });

  it('Shift+Alt+↑ 는 onDuplicate("below") — 방향이 반대다(명세)', async () => {
    const { mf, handlers } = await mount();
    press(mf, 'ArrowUp', { altKey: true, shiftKey: true });
    await settle();
    expect(handlers.onDuplicate).toHaveBeenCalledWith('below', expect.any(Number));
    expect(handlers.onMoveGroup).not.toHaveBeenCalled();
  });

  it('Shift+Alt+↓ 는 onDuplicate("above")', async () => {
    const { mf, handlers } = await mount();
    press(mf, 'ArrowDown', { altKey: true, shiftKey: true });
    await settle();
    expect(handlers.onDuplicate).toHaveBeenCalledWith('above', expect.any(Number));
  });

  // 사용자 보고의 핵심: 옮기고 나서 캐럿이 있던 자리에 그대로 있어야 한다. 그러려면
  // 누르는 **그 순간의** 캐럿을 실어 보내야 한다 — 문서에는 마우스·화살표로 옮긴
  // 캐럿이 안 남기 때문이다(`workspace.ts` 의 `moveGroup.refocus` 참고).
  it('누른 순간의 캐럿 오프셋을 같이 올려보낸다', async () => {
    const { mf, handlers } = await mount('x+y+z');
    mf.position = 3;
    await settle();
    press(mf, 'ArrowDown', { altKey: true });
    await settle();
    expect(handlers.onMoveGroup).toHaveBeenCalledWith(1, 3);

    mf.position = 1;
    await settle();
    press(mf, 'ArrowUp', { altKey: true, shiftKey: true });
    await settle();
    expect(handlers.onDuplicate).toHaveBeenCalledWith('below', 1);
  });
});

describe('MathField — 셀 그룹 밖으로 나가면 선택을 해제한다', () => {
  async function mountGroup() {
    const group = document.createElement('div');
    group.className = 'cell-group';
    document.body.append(group);
    const hostA = document.createElement('div');
    const hostB = document.createElement('div');
    group.append(hostA, hostB);
    const outside = document.createElement('button');
    document.body.append(outside);

    const onSelA = vi.fn<(latex: string | null) => void>();
    const onSelB = vi.fn<(latex: string | null) => void>();
    const rootA = createRoot(hostA);
    const rootB = createRoot(hostB);
    rootA.render(createElement(MathField, { value: 'x+y', onSelectionChange: onSelA }));
    rootB.render(createElement(MathField, { value: 'a+b', onSelectionChange: onSelB }));
    await new Promise((r) => setTimeout(r, 30));

    cleanups.push(() => {
      rootA.unmount();
      rootB.unmount();
      group.remove();
      outside.remove();
    });

    return {
      mfA: hostA.querySelector('math-field') as MathfieldElement,
      mfB: hostB.querySelector('math-field') as MathfieldElement,
      onSelA,
      outside,
    };
  }

  // 실제 MathLive는 blur만으로도 자기 선택을 collapse하고 'selection-change'로
  // null을 보고할 때가 있다(실측, 포커스 이동 대상과 무관하게) — 그 경로와 여기서
  // 검증하려는 "relatedTarget 컨테인먼트" 로직이 섞이지 않도록, 진짜 `.focus()`
  // 대신 합성 `focusout` 이벤트로 relatedTarget만 직접 주입해 이 로직만 딱 잰다.
  it('그룹 밖 요소로 포커스가 옮겨가면 선택을 접고 onSelectionChange(null)을 부른다', async () => {
    const { mfA, onSelA, outside } = await mountGroup();
    mfA.focus();
    await settle();
    mfA.selection = { ranges: [[0, 3]], direction: 'forward' };
    await settle();
    expect(onSelA).toHaveBeenLastCalledWith(expect.any(String));
    onSelA.mockClear();
    mfA.dispatchEvent(new FocusEvent('focusout', { relatedTarget: outside }));
    await settle();
    expect(onSelA).toHaveBeenCalledWith(null);
    // 버튼만 숨기는 게 아니라 **모델의 선택까지** 푼다 — 안 그러면 다시 포커스했을 때
    // 선택이 되살아나 "해제했는데 안 풀린" 상태가 된다.
    expect(mfA.selectionIsCollapsed).toBe(true);
  });

  /** 바깥을 눌렀다 뗀다. 떼는 지점이 누른 지점과 멀면 그건 탭이 아니라 스크롤이다. */
  function tapOutside(el: Element, x0: number, y0: number, x1: number, y1: number): void {
    const base = { bubbles: true, composed: true, pointerId: 3, isPrimary: true, pointerType: 'touch' };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: x0, clientY: y0 }));
    document.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: x1, clientY: y1 }));
  }

  it('그룹 밖을 탭하면(포커스 이동이 없어도) 선택이 풀린다', async () => {
    // 스택 배경 같은 빈 여백을 누르면 포커스가 어디로도 안 옮겨가 focusout 이
    // 아예 안 난다 — 그래서 document pointerdown 경로가 따로 있다.
    const { mfA, onSelA, outside } = await mountGroup();
    mfA.focus();
    await settle();
    mfA.selection = { ranges: [[0, 3]], direction: 'forward' };
    await settle();
    onSelA.mockClear();
    tapOutside(outside, 100, 100, 100, 100);
    await settle();
    expect(mfA.selectionIsCollapsed).toBe(true);
    expect(onSelA).toHaveBeenCalledWith(null);
  });

  it('그룹 밖에서 시작한 **스크롤**로는 선택이 안 풀린다', async () => {
    // 모바일에서 바깥을 짚는 손짓의 대부분은 페이지 스크롤이다 — 누른 즉시 풀면
    // 선택을 잡아둔 채 아래로 훑어보는 게 불가능해진다(사용자 보고). 그래서 손을
    // 뗄 때까지 기다렸다가 거의 안 움직였을 때만(=탭) 푼다.
    const { mfA, outside } = await mountGroup();
    mfA.focus();
    await settle();
    mfA.selection = { ranges: [[0, 3]], direction: 'forward' };
    await settle();
    tapOutside(outside, 100, 100, 104, 180);
    await settle();
    expect(mfA.selectionIsCollapsed).toBe(false);
  });

  it('같은 그룹 안을 클릭하면 선택이 살아 있다 (변환 버튼 클릭)', async () => {
    // TransformButtons/SelectionToolbar 는 그룹 DOM 안에 있다 — 그 클릭으로 선택이
    // 날아가면 변환 자체가 불가능해진다.
    const { mfA, mfB } = await mountGroup();
    mfA.focus();
    await settle();
    mfA.selection = { ranges: [[0, 3]], direction: 'forward' };
    await settle();
    mfB.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    await settle();
    expect(mfA.selectionIsCollapsed).toBe(false);
  });

  it('같은 그룹 안 다른 셀로 포커스가 옮겨가면 지우지 않는다', async () => {
    const { mfA, mfB, onSelA } = await mountGroup();
    mfA.focus();
    await settle();
    mfA.selection = { ranges: [[0, 3]], direction: 'forward' };
    await settle();
    expect(onSelA).toHaveBeenLastCalledWith(expect.any(String));
    onSelA.mockClear();
    mfA.dispatchEvent(new FocusEvent('focusout', { relatedTarget: mfB }));
    await settle();
    expect(onSelA).not.toHaveBeenCalledWith(null);
  });

  it('relatedTarget이 없는 blur(창 포커스 전환 등)는 지우지 않는다', async () => {
    const { mfA, onSelA } = await mountGroup();
    mfA.focus();
    await settle();
    mfA.selection = { ranges: [[0, 3]], direction: 'forward' };
    await settle();
    expect(onSelA).toHaveBeenLastCalledWith(expect.any(String));
    onSelA.mockClear();
    mfA.dispatchEvent(new FocusEvent('focusout', { relatedTarget: null }));
    await settle();
    expect(onSelA).not.toHaveBeenCalledWith(null);
  });
});

describe('MathField — `\\` 명령어 검색 팝오버는 꺼져 있다', () => {
  it('`\\` 를 쳐도 제안 팝오버가 안 뜬다', async () => {
    // MathLive는 `\` 로 latex 모드에 들어가면 명령어 자동완성 창을 띄운다. 이 앱은
    // 인라인 숏컷·키바인딩으로 입력하므로 그 창이 캐럿 흐름만 끊는다.
    // 팝오버는 `document` 에 id 하나로 붙는다(mathlive.mjs 실측).
    const { mf } = await mount('');
    expect(mf.popoverPolicy).toBe('off');
    mf.executeCommand(['typedText', '\\', { simulateKeystroke: true }]);
    await settle();
    const panel = document.getElementById('mathlive-suggestion-popover');
    // 아예 안 만들어졌거나, 만들어졌어도 보이지 않아야 한다.
    expect(panel === null || panel.style.visibility === 'hidden').toBe(true);
  });
});

describe('MathField — 셰도우 DOM 스타일', () => {
  it(String.raw`\overline 앞뒤에 여백이 붙는다`, async () => {
    // MathLive는 `\overline` 렌더 박스를 `type: 'ignore'` 로 만들어 원자 간 자동
    // 간격이 아예 안 붙는다 — 앞뒤 글자에 딱 붙어 읽기 어렵다. 셰도우 루트가
    // `mode: 'open'` 이라 `adoptedStyleSheets` 로 직접 얹어 해결한다.
    // ⚠ 이 테스트가 깨지면 MathLive가 클래스 이름(`.overline`)을 바꾼 것이다.
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    root.render(createElement(MathField, { value: String.raw`x\overline{z}y` }));
    await settle();
    const mf = host.querySelector('math-field') as MathfieldElement;
    const overline = mf.shadowRoot?.querySelector('.overline') as HTMLElement | null;
    cleanups.push(() => {
      root.unmount();
      host.remove();
    });

    expect(overline).not.toBeNull();
    const style = getComputedStyle(overline!);
    expect(parseFloat(style.marginLeft)).toBeGreaterThan(0);
    expect(parseFloat(style.marginRight)).toBeGreaterThan(0);
  });

  it('☰ 메뉴 버튼이 필드 높이 가운데에 선다', async () => {
    // MathLive 기본은 `.ML__toggles` 에 `align-self: flex-start` 라 위에 붙는다 —
    // 행렬처럼 키가 큰 식에서는 버튼만 맨 위에 동떨어져 보인다.
    // ⚠ 깨지면 MathLive가 `.ML__toggles`/`.ML__container` 이름을 바꾼 것이다.
    const host = document.createElement('div');
    host.style.width = '400px';
    document.body.append(host);
    const root = createRoot(host);
    root.render(
      createElement(MathField, { value: String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}` }),
    );
    await settle();
    const mf = host.querySelector('math-field') as MathfieldElement;
    cleanups.push(() => {
      root.unmount();
      host.remove();
    });

    const container = mf.shadowRoot?.querySelector('.ML__container') as HTMLElement | null;
    const toggles = mf.shadowRoot?.querySelector('.ML__toggles') as HTMLElement | null;
    expect(container).not.toBeNull();
    expect(toggles).not.toBeNull();
    // 키 큰 식이어야 위/가운데 차이가 드러난다 — 전제를 같이 못 박는다.
    const cr = container!.getBoundingClientRect();
    const tr = toggles!.getBoundingClientRect();
    expect(cr.height).toBeGreaterThan(tr.height + 8);
    expect(Math.abs(cr.top + cr.height / 2 - (tr.top + tr.height / 2))).toBeLessThan(1);
  });

  it(String.raw`\overline 의 줄이 내용보다 길게 뻗는다 (안쪽 여백)`, async () => {
    // 내용이 줄 끝에 딱 닿으면 답답해 보인다. vlist의 **내용 줄에만** 좌우 패딩을 줘서
    // 줄(width:100%)이 그만큼 길어지게 한다.
    // ⚠ 깨지면 MathLive가 vlist 구조(.ML__vlist > 내용 줄, 줄 줄)를 바꾼 것이다.
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    root.render(createElement(MathField, { value: String.raw`x\overline{ab}y` }));
    await settle();
    const mf = host.querySelector('math-field') as MathfieldElement;
    cleanups.push(() => {
      root.unmount();
      host.remove();
    });

    const overline = mf.shadowRoot?.querySelector('.overline') as HTMLElement | null;
    expect(overline).not.toBeNull();
    const contentBox = overline!.querySelector(
      '.ML__vlist > span:first-child > span:not(.ML__pstrut)',
    ) as HTMLElement | null;
    expect(contentBox, 'vlist 내용 줄을 못 찾았다 — MathLive 구조가 바뀌었나?').not.toBeNull();
    expect(parseFloat(getComputedStyle(contentBox!).paddingLeft)).toBeGreaterThan(0);
    expect(parseFloat(getComputedStyle(contentBox!).paddingRight)).toBeGreaterThan(0);

    // 줄은 내용 칸 폭을 따라간다 — 패딩이 붙었으니 글자보다 길다.
    const line = mf.shadowRoot?.querySelector('.overline-line') as HTMLElement | null;
    const glyphs = [...contentBox!.querySelectorAll('.ML__mathit')];
    const glyphWidth = glyphs.reduce((sum, g) => sum + g.getBoundingClientRect().width, 0);
    expect(glyphs.length).toBeGreaterThan(0);
    expect(line!.getBoundingClientRect().width).toBeGreaterThan(glyphWidth);
  });
});

describe('MathField — 포커스 게이트 (editor/activeField.ts)', () => {
  /** 셀 그룹 하나에 필드 둘. 셀 간 이동을 진짜 `focus()` 로 재현하려면 둘이 필요하다. */
  async function mountPair() {
    const group = document.createElement('div');
    group.className = 'cell-group';
    document.body.append(group);
    const hostA = document.createElement('div');
    const hostB = document.createElement('div');
    group.append(hostA, hostB);

    const rootA = createRoot(hostA);
    const rootB = createRoot(hostB);
    rootA.render(createElement(MathField, { value: 'x+y' }));
    rootB.render(createElement(MathField, { value: 'a+b' }));
    await settle();

    cleanups.push(() => {
      rootA.unmount();
      rootB.unmount();
      group.remove();
    });
    return {
      mfA: hostA.querySelector('math-field') as MathfieldElement,
      mfB: hostB.querySelector('math-field') as MathfieldElement,
      rootA,
    };
  }

  it('포커스가 들어오면 "지금"과 "마지막"이 둘 다 그 필드다', async () => {
    const { mfA } = await mountPair();
    mfA.focus();
    await settle();
    expect(isFieldFocused()).toBe(true);
    expect(getFocusedMathField()).toBe(mfA);
    expect(getActiveMathField()).toBe(mfA);
  });

  it('포커스가 빠지면 "지금"은 비고 "마지막"은 남는다', async () => {
    // 이 비대칭이 이 모듈의 존재 이유다 — 팔레트는 포커스가 빠진 뒤에도 대상을
    // 알아야 하고(끈끈함), 가상 키보드는 빠졌다는 걸 알아야 한다(지금).
    const { mfA } = await mountPair();
    mfA.focus();
    await settle();
    mfA.blur();
    await settle();
    expect(isFieldFocused()).toBe(false);
    expect(getActiveMathField()).toBe(mfA);
  });

  it('셀에서 셀로 옮기는 동안 포커스가 한 번도 안 끊긴다', async () => {
    // 깜빡임 회귀 핀. focusout(A) → focusin(B) 사이에서 `false` 를 한 번이라도
    // 내보내면 팔레트가 접혔다 펴지고, `--palette-h` 로 묶인 `.app` 바닥 여백까지
    // 함께 움직여 내용이 통째로 튄다(`styles/base.css`).
    const { mfA, mfB } = await mountPair();
    mfA.focus();
    await settle();

    const seen: boolean[] = [];
    const unsubscribe = subscribeFieldFocus(() => seen.push(isFieldFocused()));
    cleanups.push(unsubscribe);

    mfB.focus();
    await settle();

    expect(getFocusedMathField()).toBe(mfB);
    expect(seen).not.toContain(false);
  });

  it('창 포커스 전환(relatedTarget 없는 focusout)으로는 안 놓는다', async () => {
    // alt-tab/앱 전환에서는 focusout 이 나지만 `document.activeElement` 는 그대로다 —
    // 돌아왔을 때 하던 자리가 살아 있어야 하므로 포커스를 놓지 않는다. 같은 필드가
    // 여전히 진짜로 포커스돼 있으니 합성 이벤트만 쏘면 그 상황이 그대로 재현된다.
    const { mfA } = await mountPair();
    mfA.focus();
    await settle();
    mfA.dispatchEvent(new FocusEvent('focusout', { relatedTarget: null }));
    await settle();
    expect(isFieldFocused()).toBe(true);
    expect(getFocusedMathField()).toBe(mfA);
  });

  it('포커스된 채 언마운트되면 게이트가 비고, 사라진 필드를 대상으로 안 남긴다', async () => {
    // `mf.remove()` 는 포커스된 필드에서도 focusout 을 안 쏜다 — 정리 경로가 직접
    // 알리지 않으면 이미 떨어져 나간 필드가 "포커스 중"으로 남고, 팔레트는 detached
    // 엘리먼트로 키를 흘린다.
    const { mfA, rootA } = await mountPair();
    mfA.focus();
    await settle();
    expect(getActiveMathField()).toBe(mfA);

    rootA.unmount();
    await settle();

    expect(isFieldFocused()).toBe(false);
    expect(getActiveMathField()).not.toBe(mfA);
  });
});
