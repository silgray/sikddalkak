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
  onMoveGroup: (delta: -1 | 1) => void;
  onDuplicate: (position: 'above' | 'below') => void;
};

async function mount(initial = 'x'): Promise<{ mf: MathfieldElement; handlers: Handlers; root: Root }> {
  const host = document.createElement('div');
  document.body.append(host);
  const handlers: Handlers = {
    onEnter: vi.fn<(latex: string) => void>(),
    onInsertCell: vi.fn<(position: 'above' | 'below') => void>(),
    onMoveGroup: vi.fn<(delta: -1 | 1) => void>(),
    onDuplicate: vi.fn<(position: 'above' | 'below') => void>(),
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
    expect(handlers.onMoveGroup).toHaveBeenCalledWith(-1);
    expect(handlers.onDuplicate).not.toHaveBeenCalled();
  });

  it('Alt+↓ 는 onMoveGroup(1)', async () => {
    const { mf, handlers } = await mount();
    press(mf, 'ArrowDown', { altKey: true });
    await settle();
    expect(handlers.onMoveGroup).toHaveBeenCalledWith(1);
  });

  it('Shift+Alt+↑ 는 onDuplicate("below") — 방향이 반대다(명세)', async () => {
    const { mf, handlers } = await mount();
    press(mf, 'ArrowUp', { altKey: true, shiftKey: true });
    await settle();
    expect(handlers.onDuplicate).toHaveBeenCalledWith('below');
    expect(handlers.onMoveGroup).not.toHaveBeenCalled();
  });

  it('Shift+Alt+↓ 는 onDuplicate("above")', async () => {
    const { mf, handlers } = await mount();
    press(mf, 'ArrowDown', { altKey: true, shiftKey: true });
    await settle();
    expect(handlers.onDuplicate).toHaveBeenCalledWith('above');
  });
});
