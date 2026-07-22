import type { CellMode, FormulaObject } from '../types';

export type CellsState = {
  objects: FormulaObject[];
  /** 포커스를 옮길 오브젝트. token은 같은 곳에 다시 포커스를 줄 때 구분용. */
  focus: { id: string; token: number } | null;
};

export type Action =
  /** draft를 확정 값으로 flush한다 (디바운스/blur). 제자리에 머문다. */
  | { type: 'commitInput'; id: string; latex: string }
  /** flush하고 다음 오브젝트로 이동한다 (Enter). 없으면 새로 만든다. */
  | { type: 'enter'; id: string; latex: string }
  | { type: 'setMode'; id: string; mode: CellMode }
  | { type: 'remove'; id: string }
  | { type: 'focus'; id: string };

export function makeObject(): FormulaObject {
  return { id: crypto.randomUUID(), latex: '', mode: 'scoped' };
}

export const initialState: CellsState = { objects: [makeObject()], focus: null };

function patch(objects: FormulaObject[], id: string, change: Partial<FormulaObject>): FormulaObject[] {
  return objects.map((o) => (o.id === id ? { ...o, ...change } : o));
}

function nextToken(state: CellsState): number {
  return state.focus ? state.focus.token + 1 : 1;
}

export function cellsReducer(state: CellsState, action: Action): CellsState {
  switch (action.type) {
    case 'commitInput': {
      const target = state.objects.find((o) => o.id === action.id);
      // 값이 그대로면 새 상태를 만들지 않는다 — 불필요한 재평가/리렌더를 막는다.
      if (target === undefined || target.latex === action.latex) return state;
      return { ...state, objects: patch(state.objects, action.id, { latex: action.latex }) };
    }

    case 'setMode':
      return { ...state, objects: patch(state.objects, action.id, { mode: action.mode }) };

    case 'enter': {
      const objects = patch(state.objects, action.id, { latex: action.latex });
      const index = objects.findIndex((o) => o.id === action.id);
      const next = objects[index + 1];
      if (next !== undefined) {
        // 이미 아래 오브젝트가 있으면 새로 만들지 않고 거기로 이동한다.
        return { objects, focus: { id: next.id, token: nextToken(state) } };
      }
      const created = makeObject();
      return { objects: [...objects, created], focus: { id: created.id, token: nextToken(state) } };
    }

    case 'remove': {
      const objects = state.objects.filter((o) => o.id !== action.id);
      // 스택이 비지 않도록 항상 최소 한 개는 남긴다.
      return { ...state, objects: objects.length > 0 ? objects : [makeObject()] };
    }

    case 'focus':
      return { ...state, focus: { id: action.id, token: nextToken(state) } };
  }
}
