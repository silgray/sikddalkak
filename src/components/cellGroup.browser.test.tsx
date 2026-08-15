import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import type { MathfieldElement } from 'mathlive';
import { CellGroup } from './CellGroup';
import { makeObject, type Tab } from '../state/workspace';
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
  extra: { focus?: Tab['focus']; onMoveOut?: (index: number, direction: string) => void } = {},
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
      focus: extra.focus ?? null,
      syncKey: 0,
      dispatch: dispatch as never,
      onDragStart: () => {},
      onDragMove: () => {},
      onDragEnd: () => {},
      onMoveOut: extra.onMoveOut ?? (() => {}),
      onDeleteEmpty: () => {},
      onMoveGroup: () => {},
    }),
  );
  cleanups.push(() => {
    root.unmount();
    container.remove();
  });
  return container;
}

/** MathField.tsx의 move-out 리스너를 직접 몬다 — 실제 경계 넘침 조건을 갖추지
 * 않고도 신뢰성 있게 신호를 보낸다(이 파일 다른 테스트의 `executeCommand` 규율과
 * 같은 이유). */
function moveOut(mf: MathfieldElement, direction: 'forward' | 'backward' | 'upward' | 'downward') {
  mf.dispatchEvent(new CustomEvent('move-out', { detail: { direction } }));
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

describe('CellGroup — 위/아래 화살표로 결과 필드 오가기', () => {
  it('결과가 보이면, 맨 아래 셀에서 ↓ 는 결과 필드로 포커스 지시를 보낸다', async () => {
    const top = { ...makeObject(), latex: '2x+3x' };
    const bottom = { ...makeObject(), latex: '5x+1', entered: true, groupId: top.groupId };
    const results = new Map<string, EvalResult>([
      [top.id, { kind: 'ok', latex: '5x', definitionName: null, unchanged: true }],
      [bottom.id, { kind: 'ok', latex: '5x+1', definitionName: null, unchanged: false }],
    ]);
    const dispatch = vi.fn();
    const container = mount([top, bottom], results, dispatch);
    await settle();

    const fields = [...container.querySelectorAll('math-field')] as MathfieldElement[];
    expect(fields).toHaveLength(3); // 입력 둘 + 결과 하나
    moveOut(fields[1], 'downward'); // 맨 아래(2번째) 셀
    await settle();

    expect(dispatch).toHaveBeenCalledWith({
      type: 'focus',
      id: top.groupId,
      field: 'result',
      offset: 0,
    });
  });

  it('결과가 안 보이면(단일 셀, unchanged), ↓ 는 평범하게 다음 셀로 위임한다', async () => {
    const cell = { ...makeObject(), latex: '3' };
    const results = new Map<string, EvalResult>([
      [cell.id, { kind: 'ok', latex: '3', definitionName: null, unchanged: true }],
    ]);
    const dispatch = vi.fn();
    const onMoveOut = vi.fn();
    const container = mount([cell], results, dispatch, { onMoveOut });
    await settle();

    const fields = [...container.querySelectorAll('math-field')] as MathfieldElement[];
    expect(fields).toHaveLength(1); // 결과 행이 없다
    moveOut(fields[0], 'downward');
    await settle();

    expect(onMoveOut).toHaveBeenCalledWith(0, 'downward');
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'focus', field: 'result' }));
  });

  it('결과 필드에서 ↑ 는 그룹의 마지막 셀로 포커스 지시를 보낸다', async () => {
    const top = { ...makeObject(), latex: '2x+3x' };
    const bottom = { ...makeObject(), latex: '5x+1', entered: true, groupId: top.groupId };
    const results = new Map<string, EvalResult>([
      [top.id, { kind: 'ok', latex: '5x', definitionName: null, unchanged: true }],
      [bottom.id, { kind: 'ok', latex: '5x+1', definitionName: null, unchanged: false }],
    ]);
    const dispatch = vi.fn();
    const container = mount([top, bottom], results, dispatch);
    await settle();

    const fields = [...container.querySelectorAll('math-field')] as MathfieldElement[];
    moveOut(fields[2], 'upward'); // 결과 필드
    await settle();

    expect(dispatch).toHaveBeenCalledWith({
      type: 'focus',
      id: bottom.id,
      offset: Number.MAX_SAFE_INTEGER,
    });
  });

  it('결과 필드에서 ↓ 는 그룹 맨 아래 셀에서 나가는 것처럼 다음 그룹으로 위임한다', async () => {
    const top = { ...makeObject(), latex: '2x+3x' };
    const bottom = { ...makeObject(), latex: '5x+1', entered: true, groupId: top.groupId };
    const results = new Map<string, EvalResult>([
      [top.id, { kind: 'ok', latex: '5x', definitionName: null, unchanged: true }],
      [bottom.id, { kind: 'ok', latex: '5x+1', definitionName: null, unchanged: false }],
    ]);
    const dispatch = vi.fn();
    const onMoveOut = vi.fn();
    const container = mount([top, bottom], results, dispatch, { onMoveOut });
    await settle();

    const fields = [...container.querySelectorAll('math-field')] as MathfieldElement[];
    moveOut(fields[2], 'downward'); // 결과 필드
    await settle();

    expect(onMoveOut).toHaveBeenCalledWith(1, 'downward'); // startIndex(0) + objects.length-1(1)
  });
});
