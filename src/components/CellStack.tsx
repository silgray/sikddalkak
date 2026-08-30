import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type Dispatch } from 'react';
import { groupsOf, type Group } from '../cellGroup';
import type { Action, Tab } from '../state/workspace';
import type { EvalResult } from '../types';
import { evaluateCellsAsync } from '../worker/client';
import { CellGroup, type Refocus } from './CellGroup';

type Props = {
  tab: Tab;
  dispatch: Dispatch<Action>;
};

/** 타이핑이 멈춘 뒤 평가까지의 지연. 미완성 식의 에러 번쩍임을 막는다. */
const EVAL_DEBOUNCE_MS = 300;

type DragState = { groupId: string; insertAt: number };

/** 포인터 Y가 어느 삽입 지점(그룹 사이)에 해당하는지 — 각 그룹의 세로 중점 기준.
 * `container` 만 읽는 순수 함수라 훅 바깥에 둬도 안전하다(참조 안정성이 필요 없다 —
 * 호출부의 `useCallback` 이 이 함수를 매번 최신으로 볼 필요가 없다, 컨테이너 DOM은
 * ref로 늘 최신이다). */
function insertionAt(container: HTMLDivElement | null, clientY: number): number {
  if (container === null) return 0;
  const els = [...container.querySelectorAll<HTMLElement>(':scope > .cell-group')];
  for (let i = 0; i < els.length; i += 1) {
    const rect = els[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return i;
  }
  return els.length;
}

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

  // 타이핑 중엔 tab.objects가 매 키 입력마다 새 배열이 된다 — 그룹 무관 공용
  // 핸들러(아래)가 이 값을 deps로 물고 있으면 매번 재생성돼 모든 CellGroup이
  // 리렌더된다. `MathField.tsx` 의 `handlers.current` 와 같은 이유로 ref에 담아
  // 렌더 중 즉시 최신화하고, 핸들러는 호출 시점에 ref를 통해 읽는다.
  const objectsRef = useRef(tab.objects);
  objectsRef.current = tab.objects;

  // groupsOf는 순수 함수지만 매 렌더 다시 부르면 tab.objects가 안 바뀐 렌더
  // (포커스만 바뀌는 액션 등)에서도 새 배열을 만든다 — tab.objects가 같으면 이전
  // 결과를 그대로 재사용한다.
  const groups = useMemo(() => groupsOf(tab.objects), [tab.objects]);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  // --- 드래그 재정렬 (그룹 단위, 라이브러리 없이 pointer 이벤트로) ---
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  /** 경계에서 화살표가 막히면 인접 셀로. 그룹 무관 — 어느 그룹에서 불러도 같다.
   *
   * **↑/↓ 는 어느 쪽이든 셀 끝에 선다.** 위아래 이동은 "그 셀로 자리를 옮긴다" 는
   * 뜻이지 "글의 처음부터 읽는다" 가 아니라서, 바로 이어 쓰려면 끝이 맞다. 반면
   * ←/→ 는 글자 단위 이동의 연장이라 방향을 지킨다 — →로 넘어갔는데 캐럿이 끝에
   * 서면 왔던 방향으로 되돌아간 꼴이 된다. (끝 = 큰 오프셋을 주면 필드가 알아서 클램프) */
  const handleMoveOut = useCallback(
    (index: number, direction: 'forward' | 'backward' | 'upward' | 'downward') => {
      const delta = direction === 'forward' || direction === 'downward' ? 1 : -1;
      const target = objectsRef.current[index + delta];
      if (target === undefined) return;
      const vertical = direction === 'upward' || direction === 'downward';
      dispatch({
        type: 'focus',
        id: target.id,
        offset: vertical || delta === -1 ? Number.MAX_SAFE_INTEGER : 0,
      });
    },
    [dispatch],
  );

  /** 빈 셀 backspace: 셀을 지우고 바로 위 셀 끝으로. 맨 아래 상시 빈 셀은 지워도
   * 불변식이 재추가하므로(히스토리 노이즈) 이동만 한다. 그룹 무관. */
  const handleDeleteEmpty = useCallback(
    (index: number) => {
      if (index === 0) return;
      const objects = objectsRef.current;
      const prev = objects[index - 1];
      if (index !== objects.length - 1) {
        dispatch({ type: 'remove', id: objects[index].id });
      }
      dispatch({ type: 'focus', id: prev.id, offset: Number.MAX_SAFE_INTEGER });
    },
    [dispatch],
  );

  /** Alt+↑/↓ — 그룹 전체를 위/아래로. `moveGroup`의 toIndex는 "제거 이후" 그룹 열
   * 기준(reducer 클램프가 범위 밖 값을 알아서 정리한다) — 드래그(아래 `handleDragEnd`)
   * 와 달리 `refocus` 를 싣는다 — 키로 옮길 땐 캐럿이 있던 자리로 돌아와야 이어서
   * 편집할 수 있다.
   *
   * `groupIndex`/`groupStart` 를 인자로 받아 그룹 무관 함수로 둔다 — 그룹마다 다른
   * 클로저를 만들면 `CellGroup` 에 매 렌더 새 함수가 내려가 `memo` 비교가 항상
   * 실패한다. */
  const handleMoveGroup = useCallback(
    (groupIndex: number, groupStart: number, delta: -1 | 1, refocus: Refocus) => {
      const sourceId = objectsRef.current[groupStart]?.id;
      if (sourceId === undefined) return;
      dispatch({ type: 'moveGroup', id: sourceId, toIndex: groupIndex + delta, refocus });
    },
    [dispatch],
  );

  const handleDragStart = useCallback((groupId: string, e: React.PointerEvent) => {
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // 캡처 실패해도 드래그 자체는 계속한다 (move/up이 핸들에 오는 한 동작).
    }
    setDrag({ groupId, insertAt: insertionAt(containerRef.current, e.clientY) });
  }, []);

  // setDrag의 함수형 업데이터로 `drag` 를 deps에서 뺀다 — 참조가 절대 안 바뀌어야
  // `CellGroup` 의 memo 비교가 이 두 콜백 때문에 실패하지 않는다.
  const handleDragMove = useCallback((e: React.PointerEvent) => {
    setDrag((prev) => {
      if (prev === null) return prev;
      const insertAt = insertionAt(containerRef.current, e.clientY);
      return insertAt !== prev.insertAt ? { ...prev, insertAt } : prev;
    });
  }, []);

  const handleDragEnd = useCallback(() => {
    setDrag((prev) => {
      if (prev !== null) {
        const groups = groupsRef.current;
        const fromGroupIdx = groups.findIndex((g) => g.groupId === prev.groupId);
        if (fromGroupIdx !== -1) {
          // moveGroup의 toIndex는 "제거 이후" 그룹 열 기준이다 — 원본 셀 단위 드래그와
          // 같은 규약(`objects.splice(from,1)` 뒤 `splice(to,0,moved)`).
          const toIndex = prev.insertAt > fromGroupIdx ? prev.insertAt - 1 : prev.insertAt;
          const sourceId = objectsRef.current[groups[fromGroupIdx].start].id;
          dispatch({ type: 'moveGroup', id: sourceId, toIndex });
        }
      }
      return null;
    });
  }, [dispatch]);

  return (
    <div className="stack" ref={containerRef}>
      {groups.map((group: Group, gi: number) => (
        <Fragment key={group.groupId}>
          {drag !== null && drag.insertAt === gi && <div className="drop-line" />}
          <CellGroup
            objects={tab.objects.slice(group.start, group.end)}
            startIndex={group.start}
            groupIndex={gi}
            results={results}
            dragging={drag?.groupId === group.groupId}
            focus={tab.focus}
            syncKey={tab.syncNonce}
            dispatch={dispatch}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
            onMoveOut={handleMoveOut}
            onDeleteEmpty={handleDeleteEmpty}
            onMoveGroup={handleMoveGroup}
          />
        </Fragment>
      ))}
      {drag !== null && drag.insertAt === groups.length && <div className="drop-line" />}
    </div>
  );
}
