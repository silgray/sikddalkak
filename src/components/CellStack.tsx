import { useMemo, useReducer } from 'react';
import { cellsReducer, initialState } from '../state/cellsReducer';
import { evaluateCells } from '../engine/evaluate';
import { Cell } from './Cell';

export function CellStack() {
  const [state, dispatch] = useReducer(cellsReducer, initialState);

  // 결과는 상태가 아니라 파생값이다. 셀이 하나라도 바뀌면 전체를 다시 계산한다.
  const results = useMemo(() => evaluateCells(state.cells), [state.cells]);

  return (
    <div className="stack">
      {state.cells.map((cell, i) => (
        <Cell
          key={cell.id}
          cell={cell}
          result={results[i]}
          focusToken={state.focus?.id === cell.id ? state.focus.token : null}
          onInput={(input) => dispatch({ type: 'setInput', id: cell.id, input })}
          onCommit={(input) => dispatch({ type: 'commit', id: cell.id, input })}
          onModeChange={(mode) => dispatch({ type: 'setMode', id: cell.id, mode })}
          onRemove={() => dispatch({ type: 'remove', id: cell.id })}
        />
      ))}
    </div>
  );
}
