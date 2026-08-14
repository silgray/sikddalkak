import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import type { MathfieldElement } from 'mathlive';
import { CellGroup } from './CellGroup';
import { makeObject } from '../state/workspace';
import type { EvalResult, FormulaObject } from '../types';

/**
 * `CellGroup` 이 입력 필드와 결과 필드를 올바르게 갈라 배선하는지 — 실제
 * MathfieldElement 둘을 같은 그룹에 띄워 결과 필드 편집이 입력 셀을 안 건드리고
 * `editResult` 로 새 셀을 만드는지 확인한다 (마우스 시뮬레이션이 아니라
 * `editor/harness.ts` 와 같은 규율로 `executeCommand`를 직접 몬다 — 클릭 기반
 * 포커스 이전은 헤드리스 환경에서 신뢰성이 떨어진다, 실측).
 */

const settle = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 10));
  });

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function mount(
  objects: FormulaObject[],
  results: Map<string, EvalResult>,
  dispatch: (a: unknown) => void,
) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  root.render(
    createElement(CellGroup, {
      objects,
      startIndex: 0,
      results,
      dragging: false,
      focus: null,
      syncKey: 0,
      dispatch: dispatch as never,
      onDragStart: () => {},
      onDragMove: () => {},
      onDragEnd: () => {},
      onMoveOut: () => {},
      onDeleteEmpty: () => {},
    }),
  );
  cleanups.push(() => {
    root.unmount();
    container.remove();
  });
  return container;
}

describe('CellGroup — 결과 필드 편집', () => {
  it('결과를 편집하면 editResult가 디스패치된다 (입력 셀 자신은 안 건드린다)', async () => {
    const cell = { ...makeObject(), latex: '3', entered: true };
    const results = new Map<string, EvalResult>([
      [cell.id, { kind: 'ok', latex: '3', definitionName: null, unchanged: true }],
    ]);
    const dispatch = vi.fn();
    const container = mount([cell], results, dispatch);
    await settle();

    const fields = [...container.querySelectorAll('math-field')] as MathfieldElement[];
    expect(fields).toHaveLength(2); // 입력 하나 + 결과 하나
    const resultField = fields[1];
    resultField.focus();
    await settle();
    resultField.executeCommand(['typedText', '1', { simulateKeystroke: true }]);
    await settle();

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'editResult', id: cell.id }));
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'editInput' }));

    // 입력 필드 자신은 그대로다 — 결과 편집이 새지 않는다.
    const inputField = fields[0];
    expect(inputField.value).toBe('3');
  });

  it('입력 필드를 직접 편집하면 editInput이 디스패치된다', async () => {
    const cell = { ...makeObject(), latex: '3', entered: true };
    const results = new Map<string, EvalResult>([
      [cell.id, { kind: 'ok', latex: '3', definitionName: null, unchanged: true }],
    ]);
    const dispatch = vi.fn();
    const container = mount([cell], results, dispatch);
    await settle();

    const fields = [...container.querySelectorAll('math-field')] as MathfieldElement[];
    const inputField = fields[0];
    inputField.focus();
    await settle();
    inputField.executeCommand(['typedText', '1', { simulateKeystroke: true }]);
    await settle();

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'editInput', id: cell.id }));
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'editResult' }));
  });
});
