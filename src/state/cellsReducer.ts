import type { Cell, CellMode } from '../types';

export type CellsState = {
  cells: Cell[];
  /** 포커스를 옮길 셀. token은 같은 셀에 다시 포커스를 줄 때 구분용. */
  focus: { id: string; token: number } | null;
};

export type Action =
  | { type: 'setInput'; id: string; input: string }
  | { type: 'setMode'; id: string; mode: CellMode }
  | { type: 'commit'; id: string; input: string }
  | { type: 'remove'; id: string }
  | { type: 'focus'; id: string };

let nextId = 0;
export function makeCell(): Cell {
  nextId += 1;
  return { id: `c${nextId}`, input: '', mode: 'scoped', committed: false };
}

export const initialState: CellsState = { cells: [makeCell()], focus: null };

function patch(cells: Cell[], id: string, change: Partial<Cell>): Cell[] {
  return cells.map((c) => (c.id === id ? { ...c, ...change } : c));
}

export function cellsReducer(state: CellsState, action: Action): CellsState {
  switch (action.type) {
    case 'setInput':
      return { ...state, cells: patch(state.cells, action.id, { input: action.input }) };

    case 'setMode':
      return { ...state, cells: patch(state.cells, action.id, { mode: action.mode }) };

    case 'commit': {
      const cells = patch(state.cells, action.id, { input: action.input, committed: true });
      const index = cells.findIndex((c) => c.id === action.id);
      const next = cells[index + 1];
      if (next !== undefined) {
        // 이미 아래 셀이 있으면 새로 만들지 않고 거기로 이동한다.
        return { cells, focus: { id: next.id, token: state.focus ? state.focus.token + 1 : 1 } };
      }
      const created = makeCell();
      return {
        cells: [...cells, created],
        focus: { id: created.id, token: state.focus ? state.focus.token + 1 : 1 },
      };
    }

    case 'remove': {
      const cells = state.cells.filter((c) => c.id !== action.id);
      // 스택이 비지 않도록 항상 최소 한 개는 남긴다.
      return { ...state, cells: cells.length > 0 ? cells : [makeCell()] };
    }

    case 'focus':
      return { ...state, focus: { id: action.id, token: state.focus ? state.focus.token + 1 : 1 } };
  }
}
