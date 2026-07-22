import { useMemo, useReducer } from 'react';
import { cellsReducer, initialState } from '../state/cellsReducer';
import { evaluateGraph } from '../engine/evaluate';
import { Cell } from './Cell';

export function CellStack() {
  const [state, dispatch] = useReducer(cellsReducer, initialState);

  // 결과는 상태가 아니라 파생값이다. 오브젝트가 하나라도 바뀌면 그래프를 다시
  // 평가하지만, 엔진이 캐시로 바뀐 노드와 그 후손만 실제로 재계산한다.
  const results = useMemo(
    () =>
      evaluateGraph(
        state.objects.map((o) => ({ id: o.id, latex: o.latex, mode: o.mode })),
      ),
    [state.objects],
  );

  return (
    <div className="stack">
      {state.objects.map((object) => (
        <Cell
          key={object.id}
          object={object}
          result={results.get(object.id) ?? { kind: 'empty' }}
          focusToken={state.focus?.id === object.id ? state.focus.token : null}
          onFlush={(latex) => dispatch({ type: 'commitInput', id: object.id, latex })}
          onEnter={(latex) => dispatch({ type: 'enter', id: object.id, latex })}
          onModeChange={(mode) => dispatch({ type: 'setMode', id: object.id, mode })}
          onRemove={() => dispatch({ type: 'remove', id: object.id })}
        />
      ))}
    </div>
  );
}
