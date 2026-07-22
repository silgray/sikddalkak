import { useMemo, type Dispatch } from 'react';
import type { Action, Tab } from '../state/workspace';
import { evaluateGraph } from '../engine/evaluate';
import { Cell } from './Cell';

type Props = {
  tab: Tab;
  dispatch: Dispatch<Action>;
};

export function CellStack({ tab, dispatch }: Props) {
  // 결과는 상태가 아니라 파생값이다. 활성 탭의 objects가 바뀌면 그래프를 다시
  // 평가하지만, 엔진이 캐시로 바뀐 노드와 그 후손만 실제로 재계산한다.
  const results = useMemo(
    () => evaluateGraph(tab.objects.map((o) => ({ id: o.id, latex: o.latex, mode: o.mode }))),
    [tab.objects],
  );

  return (
    <div className="stack">
      {tab.objects.map((object) => (
        <Cell
          key={object.id}
          object={object}
          result={object.resultDetached ? { kind: 'empty' } : (results.get(object.id) ?? { kind: 'empty' })}
          focusToken={tab.focus?.id === object.id ? tab.focus.token : null}
          syncKey={tab.syncNonce}
          onFlush={(latex) => dispatch({ type: 'commitInput', id: object.id, latex })}
          onEnter={(latex) => dispatch({ type: 'enter', id: object.id, latex })}
          onModeChange={(mode) => dispatch({ type: 'setMode', id: object.id, mode })}
          onRemove={() => dispatch({ type: 'remove', id: object.id })}
          onDetachResult={(latex) => dispatch({ type: 'detachResult', id: object.id, latex })}
        />
      ))}
    </div>
  );
}
