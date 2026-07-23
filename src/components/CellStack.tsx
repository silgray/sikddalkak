import { Fragment, useEffect, useMemo, useRef, useState, type Dispatch } from 'react';
import type { Action, Tab } from '../state/workspace';
import { evaluateGraph } from '../engine/evaluate';
import { Cell } from './Cell';

type Props = {
  tab: Tab;
  dispatch: Dispatch<Action>;
};

/** 타이핑이 멈춘 뒤 평가까지의 지연. 미완성 식의 에러 번쩍임을 막는다. */
const EVAL_DEBOUNCE_MS = 300;

type DragState = { id: string; insertAt: number };

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

  // --- 드래그 재정렬 (라이브러리 없이 pointer 이벤트로) ---
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  /** 포인터 Y가 어느 삽입 지점(셀 사이)에 해당하는지 — 각 셀의 세로 중점 기준. */
  const insertionAt = (clientY: number): number => {
    const container = containerRef.current;
    if (container === null) return 0;
    const cells = [...container.querySelectorAll<HTMLElement>(':scope > .cell')];
    for (let i = 0; i < cells.length; i += 1) {
      const rect = cells[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return cells.length;
  };

  const dragStart = (id: string) => (e: React.PointerEvent) => {
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // 캡처 실패해도 드래그 자체는 계속한다 (move/up이 핸들에 오는 한 동작).
    }
    setDrag({ id, insertAt: insertionAt(e.clientY) });
  };
  const dragMove = (e: React.PointerEvent) => {
    if (drag === null) return;
    const insertAt = insertionAt(e.clientY);
    if (insertAt !== drag.insertAt) setDrag({ ...drag, insertAt });
  };
  const dragEnd = () => {
    if (drag === null) return;
    const from = tab.objects.findIndex((o) => o.id === drag.id);
    let to = drag.insertAt > from ? drag.insertAt - 1 : drag.insertAt;
    // 상시 빈 셀(맨 아래) 아래로는 내리지 않는다 — 빈 셀이 중간에 남지 않게.
    to = Math.max(0, Math.min(to, Math.max(0, tab.objects.length - 2)));
    if (from !== -1 && to !== from) dispatch({ type: 'moveObject', id: drag.id, toIndex: to });
    setDrag(null);
  };

  return (
    <div className="stack" ref={containerRef}>
      {tab.objects.map((object, index) => (
        <Fragment key={object.id}>
          {drag !== null && drag.insertAt === index && <div className="drop-line" />}
          <Cell
            object={object}
            dragging={drag?.id === object.id}
            result={object.resultDetached ? { kind: 'empty' } : (results.get(object.id) ?? { kind: 'empty' })}
            focusToken={tab.focus?.id === object.id ? tab.focus.token : null}
            focusOffset={tab.focus?.id === object.id ? (tab.focus.offset ?? null) : null}
            focusSelection={tab.focus?.id === object.id ? (tab.focus.selection ?? null) : null}
            syncKey={tab.syncNonce}
            onEdit={(latex, caret) => dispatch({ type: 'editInput', id: object.id, latex, cursor: caret })}
            onEnter={(latex) => dispatch({ type: 'enter', id: object.id, latex })}
            onModeChange={(mode) => dispatch({ type: 'setMode', id: object.id, mode })}
            onRemove={() => dispatch({ type: 'remove', id: object.id })}
            onDetachResult={(latex, caret) =>
              dispatch({ type: 'detachResult', id: object.id, latex, cursor: caret })
            }
            onCommitDistinct={(latex, caret, selectionBefore) =>
              dispatch({ type: 'commitInput', id: object.id, latex, cursor: caret, selectionBefore })
            }
            onDragStart={dragStart(object.id)}
            onDragMove={dragMove}
            onDragEnd={dragEnd}
            onMoveOut={(direction) => {
              // 경계에서 화살표가 막히면 인접 셀로 — 아래/앞이면 다음 셀 처음,
              // 위/뒤면 이전 셀 끝. (끝 = 큰 오프셋을 주면 필드가 알아서 클램프)
              const delta = direction === 'forward' || direction === 'downward' ? 1 : -1;
              const target = tab.objects[index + delta];
              if (target === undefined) return;
              dispatch({
                type: 'focus',
                id: target.id,
                offset: delta === 1 ? 0 : Number.MAX_SAFE_INTEGER,
              });
            }}
          />
        </Fragment>
      ))}
      {drag !== null && drag.insertAt === tab.objects.length && <div className="drop-line" />}
    </div>
  );
}
