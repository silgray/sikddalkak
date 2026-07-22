import { useEffect, useMemo, useReducer } from 'react';
import { cellsReducer, initialState, type CellsState } from '../state/cellsReducer';
import { loadDocument, saveDocument } from '../state/persist';
import { evaluateGraph } from '../engine/evaluate';
import { Cell } from './Cell';

/** 저장된 문서가 있으면 거기서, 없으면 빈 문서로 시작한다. */
function init(): CellsState {
  const loaded = loadDocument();
  // 저장된 문서가 비어 있어도 편집할 셀 하나는 있어야 한다.
  if (loaded !== null && loaded.length > 0) return { objects: loaded, focus: null };
  return initialState;
}

const SAVE_DEBOUNCE_MS = 500;

export function CellStack() {
  const [state, dispatch] = useReducer(cellsReducer, null, init);

  // 결과는 상태가 아니라 파생값이다. 오브젝트가 하나라도 바뀌면 그래프를 다시
  // 평가하지만, 엔진이 캐시로 바뀐 노드와 그 후손만 실제로 재계산한다.
  const results = useMemo(
    () =>
      evaluateGraph(
        state.objects.map((o) => ({ id: o.id, latex: o.latex, mode: o.mode })),
      ),
    [state.objects],
  );

  // 편집이 잦으므로 저장을 디바운스한다. objects가 바뀔 때마다 타이머를 다시 건다.
  useEffect(() => {
    const timer = setTimeout(() => saveDocument(state.objects), SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [state.objects]);

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
