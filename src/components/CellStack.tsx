import { useEffect, useMemo, useState, type Dispatch } from 'react';
import type { Action, Tab } from '../state/workspace';
import { evaluateGraph } from '../engine/evaluate';
import { Cell } from './Cell';

type Props = {
  tab: Tab;
  dispatch: Dispatch<Action>;
};

/** 타이핑이 멈춘 뒤 평가까지의 지연. 미완성 식의 에러 번쩍임을 막는다. */
const EVAL_DEBOUNCE_MS = 300;

export function CellStack({ tab, dispatch }: Props) {
  // 문서(tab.objects)는 키 입력마다 갱신되지만(실행취소 단위), 평가는 그보다
  // 게으르다: 타이핑(lastChange==='typing')이면 디바운스하고, 셀 추가/삭제/변환/
  // 실행취소 같은 structural 변경이면 즉시 반영한다.
  const [evalObjects, setEvalObjects] = useState(tab.objects);
  useEffect(() => {
    if (tab.lastChange === 'typing') {
      const timer = setTimeout(() => setEvalObjects(tab.objects), EVAL_DEBOUNCE_MS);
      return () => clearTimeout(timer);
    }
    setEvalObjects(tab.objects);
    return undefined;
  }, [tab.objects, tab.lastChange]);

  // 결과는 상태가 아니라 파생값이다. 엔진이 캐시로 바뀐 노드와 그 후손만
  // 실제로 재계산한다.
  const results = useMemo(
    () => evaluateGraph(evalObjects.map((o) => ({ id: o.id, latex: o.latex, mode: o.mode }))),
    [evalObjects],
  );

  return (
    <div className="stack">
      {tab.objects.map((object) => (
        <Cell
          key={object.id}
          object={object}
          result={object.resultDetached ? { kind: 'empty' } : (results.get(object.id) ?? { kind: 'empty' })}
          focusToken={tab.focus?.id === object.id ? tab.focus.token : null}
          focusOffset={tab.focus?.id === object.id ? (tab.focus.offset ?? null) : null}
          syncKey={tab.syncNonce}
          onEdit={(latex, caret) => dispatch({ type: 'editInput', id: object.id, latex, cursor: caret })}
          onEnter={(latex) => dispatch({ type: 'enter', id: object.id, latex })}
          onModeChange={(mode) => dispatch({ type: 'setMode', id: object.id, mode })}
          onRemove={() => dispatch({ type: 'remove', id: object.id })}
          onDetachResult={(latex, caret) =>
            dispatch({ type: 'detachResult', id: object.id, latex, cursor: caret })
          }
          onCommitDistinct={(latex, caret) =>
            dispatch({ type: 'commitInput', id: object.id, latex, cursor: caret })
          }
        />
      ))}
    </div>
  );
}
