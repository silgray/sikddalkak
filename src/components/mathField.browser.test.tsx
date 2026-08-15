import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import type { MathfieldElement } from 'mathlive';
import { MathField } from './MathField';

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

  it('그룹 밖을 클릭하면(포커스 이동이 없어도) 선택이 풀린다', async () => {
    // 스택 배경 같은 빈 여백을 누르면 포커스가 어디로도 안 옮겨가 focusout 이
    // 아예 안 난다 — 그래서 document pointerdown 경로가 따로 있다.
    const { mfA, onSelA, outside } = await mountGroup();
    mfA.focus();
    await settle();
    mfA.selection = { ranges: [[0, 3]], direction: 'forward' };
    await settle();
    onSelA.mockClear();
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    await settle();
    expect(mfA.selectionIsCollapsed).toBe(true);
    expect(onSelA).toHaveBeenCalledWith(null);
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
