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
  extra: {
    focus?: Tab['focus'];
    onMoveOut?: (index: number, direction: string) => void;
    onMoveGroup?: (delta: -1 | 1, refocus: unknown) => void;
  } = {},
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
      onMoveGroup: extra.onMoveGroup ?? (() => {}),
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

describe('CellGroup — 결과 필드에서도 셀 조작 단축키가 먹는다', () => {
  /** 입력 셀 둘 + 결과 하나인 그룹. `fields[2]` 가 결과 필드다. */
  async function twoCellGroup(extra: Parameters<typeof mount>[3] = {}) {
    const top = { ...makeObject(), latex: '2x+3x' };
    const bottom = { ...makeObject(), latex: '5x+1', entered: true, groupId: top.groupId };
    const results = new Map<string, EvalResult>([
      [top.id, { kind: 'ok', latex: '5x', definitionName: null, unchanged: true }],
      [bottom.id, { kind: 'ok', latex: '5x+1', definitionName: null, unchanged: false }],
    ]);
    const dispatch = vi.fn();
    const container = mount([top, bottom], results, dispatch, extra);
    await settle();
    const fields = [...container.querySelectorAll('math-field')] as MathfieldElement[];
    return { top, bottom, dispatch, fields, result: fields[2] };
  }

  const press = (mf: MathfieldElement, key: string, mods: Partial<KeyboardEventInit> = {}) =>
    mf.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }));

  // 예전엔 `ResultRow` 가 이 핸들러들을 안 넘겨서, `MathField` 의 capture 리스너가
  // 키를 preventDefault 로 먹어치우고는 아무 일도 안 했다(= 키가 죽었다).
  it('Alt+↓ 는 그룹 이동을 올려보낸다 — 되돌아갈 자리는 result 필드', async () => {
    const onMoveGroup = vi.fn();
    const { top, result } = await twoCellGroup({ onMoveGroup });
    result.focus();
    await settle();
    press(result, 'ArrowDown', { altKey: true });
    await settle();
    expect(onMoveGroup).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ id: top.groupId, field: 'result' }),
    );
  });

  it('Shift+Alt+↑ 는 그룹 **전체**를 복제한다 (셀 하나가 아니라)', async () => {
    const { top, dispatch, result } = await twoCellGroup();
    result.focus();
    await settle();
    press(result, 'ArrowUp', { altKey: true, shiftKey: true });
    await settle();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'duplicateGroup', id: top.id, position: 'below' }),
    );
    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'duplicateCell' }),
    );
  });

  it('Ctrl+Enter 는 그룹 밖에 새 빈 셀을 만든다', async () => {
    const { bottom, dispatch, result } = await twoCellGroup();
    result.focus();
    await settle();
    press(result, 'Enter', { ctrlKey: true });
    await settle();
    expect(dispatch).toHaveBeenCalledWith({
      type: 'insertCell',
      id: bottom.id, // 그룹의 아무 셀이면 되지만 배선상 마지막 셀이 온다
      position: 'below',
    });
  });

  it('Ctrl+Shift+Enter 는 위쪽에 만든다', async () => {
    const { dispatch, result } = await twoCellGroup();
    result.focus();
    await settle();
    press(result, 'Enter', { ctrlKey: true, shiftKey: true });
    await settle();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'insertCell', position: 'above' }),
    );
  });
});

describe('CellGroup — 결과 표시 모드 스위치 (정확값 / 근삿값)', () => {
  /** 결과가 정확값으로 남는 셀 하나 — 수치 모드로 바뀌는 게 눈에 보이는 값. */
  const EXACT = String.raw`\frac{1}{3}`;

  async function exactResult() {
    const cell = { ...makeObject(), latex: EXACT, entered: true };
    const results = new Map<string, EvalResult>([
      [cell.id, { kind: 'ok', latex: EXACT, definitionName: null, unchanged: false }],
    ]);
    const container = mount([cell], results, vi.fn());
    await settle();
    return { container, cell };
  }

  /**
   * 조건이 참이 될 때까지 기다린다.
   *
   * ⚠ 고정 sleep 을 쓰면 안 된다 — 워커 첫 요청은 1.9MB 번들을 받아오느라 ~1초가
   * 걸리고(실측) 그 뒤로는 수십 ms 다. 고정값은 어느 쪽이든 아슬아슬해진다.
   */
  async function waitFor(done: () => boolean, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!done()) {
      if (Date.now() > deadline) throw new Error('waitFor timed out');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const resultField = (c: HTMLElement) =>
    ([...c.querySelectorAll('math-field')] as MathfieldElement[])[1];

  const toggleOf = (c: HTMLElement) => c.querySelector('.result-mode') as HTMLButtonElement;

  it('스위치는 결과 행에만 있다 (입력 행엔 없다)', async () => {
    const { container } = await exactResult();
    expect(container.querySelectorAll('.result-mode')).toHaveLength(1);
    expect(container.querySelector('.result .result-mode')).not.toBeNull();
  });

  it('고른 모드를 낱말로 보여준다 (기호가 아니라)', async () => {
    const { container } = await exactResult();
    const label = () => container.querySelector('.result-mode-label')?.textContent;
    expect(label()).toBe('symbolic');
    toggleOf(container).click();
    await settle();
    expect(label()).toBe('numeric');
  });

  it('기본은 정확값 — 화살표가 `=` 이고 결과가 그대로다', async () => {
    const { container } = await exactResult();
    expect(toggleOf(container).getAttribute('aria-checked')).toBe('false');
    expect(container.querySelector('.result-arrow')?.textContent).toBe('=');
    const fields = [...container.querySelectorAll('math-field')] as MathfieldElement[];
    expect(fields[1].value).toBe(EXACT);
  });

  it('누르면 근삿값으로 바뀐다 — 화살표가 `≈` 이고 결과가 소수다', async () => {
    const { container } = await exactResult();
    toggleOf(container).click();
    await settle();
    // 모드는 즉시 바뀌고, 값은 워커가 돌아오면 바뀐다.
    expect(toggleOf(container).getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('.result-arrow')?.textContent).toBe('≈');
    await waitFor(() => resultField(container).value !== EXACT);
    expect(resultField(container).value.startsWith('0.333')).toBe(true);
  });

  it('다시 누르면 정확값으로 돌아온다 (문서는 안 바뀐다)', async () => {
    const { container, cell } = await exactResult();
    toggleOf(container).click();
    await settle();
    await waitFor(() => resultField(container).value !== EXACT); // 근삿값이 실제로 왔다
    toggleOf(container).click();
    await settle();
    const fields = [...container.querySelectorAll('math-field')] as MathfieldElement[];
    expect(fields[1].value).toBe(EXACT);
    // 입력 셀(=문서)은 어느 쪽에서도 안 건드려진다 — 표시 모드일 뿐이다.
    expect(fields[0].value).toBe(EXACT);
    expect(cell.latex).toBe(EXACT);
  });
});
