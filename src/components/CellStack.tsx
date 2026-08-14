import { Fragment, useEffect, useMemo, useRef, useState, type Dispatch } from 'react';
import { groupsOf } from '../cellGroup';
import type { Action, Tab } from '../state/workspace';
import type { EvalResult } from '../types';
import { evaluateCellsAsync } from '../worker/client';
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

  // 계산은 워커에서 비동기로 돈다(`worker/client.ts`) — CE 예산이 못 끊는 입력이
  // 있어도(`ce/budget.ts` 서두 참고) 이 탭이 얼어붙지 않게 하려는 조치다. `env`(심볼
  // 환경)는 이제 워커가 소유한다 — 선택 변환도 같은 워커에 요청을 보내 같은 env를
  // 쓰므로("결과는 A를 행렬로 알고 계산했는데 변환 버튼은 A를 모른다" 어긋남 방지),
  // `Cell` 은 더 이상 env를 받을 필요가 없다.
  //
  // 새 요청을 보낼 때마다 요청 번호를 올려, 먼저 보낸 stale 요청의 응답이 늦게 와도
  // 최신 상태를 덮어쓰지 않게 한다.
  const [results, setResults] = useState<Map<string, EvalResult>>(new Map());
  const latestRequest = useRef(0);
  useEffect(() => {
    const requestId = ++latestRequest.current;
    evaluateCellsAsync(evalObjects).then(({ results: r }) => {
      if (latestRequest.current === requestId) setResults(r);
    });
  }, [evalObjects]);

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
    // TODO(2단계): 지금은 개별 셀(.cell) 기준 삽입 지점을 그룹 인덱스로 대충 눌러
    // 담는다 — 그룹 중간으로 드롭하는 기하는 `.cell-group` 기반 드래그로 다시 짜야
    // 한다(2단계, CellGroup 도입과 함께). 지금은 그룹이 아직 렌더에 안 붙어 있어
    // 대부분의 경우(셀 하나 = 그룹 하나) 그대로 맞는다.
    const groups = groupsOf(tab.objects);
    const toGroupIdx = groups.findIndex((g) => g.start <= to && to < g.end);
    const toIndex = toGroupIdx === -1 ? groups.length - 1 : toGroupIdx;
    if (from !== -1) dispatch({ type: 'moveGroup', id: drag.id, toIndex });
    setDrag(null);
  };

  // 그룹의 마지막 셀만 자기 결과를 보여준다 — 앞선 셀들은 그룹의 파생 과정일 뿐이다.
  // (셀 그룹의 진짜 표시 규칙 — entered 우선·상시표시 숨김 조건 — 은 `CellGroup`
  // 컴포넌트가 맡는다. 지금은 그룹 존재 자체가 자연스럽게 동작하게 하는 임시 배선이다.)
  const groupTails = useMemo(
    () => new Set(groupsOf(tab.objects).map((g) => tab.objects[g.end - 1].id)),
    [tab.objects],
  );

  return (
    <div className="stack" ref={containerRef}>
      {tab.objects.map((object, index) => (
        <Fragment key={object.id}>
          {drag !== null && drag.insertAt === index && <div className="drop-line" />}
          <Cell
            object={object}
            dragging={drag?.id === object.id}
            result={groupTails.has(object.id) ? (results.get(object.id) ?? { kind: 'pending' }) : { kind: 'empty' }}
            focusToken={tab.focus?.id === object.id ? tab.focus.token : null}
            focusOffset={tab.focus?.id === object.id ? (tab.focus.offset ?? null) : null}
            focusSelection={tab.focus?.id === object.id ? (tab.focus.selection ?? null) : null}
            syncKey={tab.syncNonce}
            onEdit={(latex, caret) => dispatch({ type: 'editInput', id: object.id, latex, cursor: caret })}
            onEnter={(latex) => dispatch({ type: 'enter', id: object.id, latex })}
            onRemove={() => dispatch({ type: 'remove', id: object.id })}
            onToggleEnabled={() =>
              dispatch({ type: 'setEnabled', id: object.id, enabled: !object.enabled })
            }
            onSetSolveFor={(symbol) => dispatch({ type: 'setSolveFor', id: object.id, symbol })}
            onDeleteEmpty={() => {
              // 빈 셀 backspace: 셀을 지우고 바로 위 셀 끝으로. 맨 아래 상시 빈
              // 셀은 지워도 불변식이 재추가하므로(히스토리 노이즈) 이동만 한다.
              if (index === 0) return;
              const prev = tab.objects[index - 1];
              if (index !== tab.objects.length - 1) {
                dispatch({ type: 'remove', id: object.id });
              }
              dispatch({ type: 'focus', id: prev.id, offset: Number.MAX_SAFE_INTEGER });
            }}
            onDetachResult={(latex, caret) =>
              dispatch({ type: 'editResult', id: object.id, latex, cursor: caret })
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
