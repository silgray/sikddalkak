import { useEffect, useRef, useState } from 'react';
import type { FormulaObject, EvalResult } from '../types';
import { FieldClip } from './FieldClip';
import { MathField, type MathFieldHandle } from './MathField';
import { splitRelation } from '../cellEnv';
import { SOLVE_ENABLED } from '../features';
import { SelectionToolbar } from './SelectionToolbar';
import { readSelectionAsync } from '../worker/client';
import { TransformButtons } from './TransformButtons';
import type { SelectionInfo, SelectionOp } from '../cellSelection';

type Props = {
  object: FormulaObject;
  /** 이 셀 자신의 계산 결과 — 변환 버튼 게이트(`transformsBlocked`)·solve 버튼 판정용.
   * 그룹의 표시용 결과 행은 여기 없다 — `CellGroup` 이 그룹 맨 아래에 하나만 그린다. */
  result: EvalResult;
  /** 이 셀이 그룹의 첫 셀인가 — 드래그 핸들과 큰 × 는 여기만 둔다(그룹 규칙). */
  isGroupTop: boolean;
  /** 이 셀의 그룹이 드래그 중인지 (반투명 표시). */
  dragging: boolean;
  focusToken: number | null;
  focusOffset: number | null;
  focusSelection: readonly [number, number] | null;
  syncKey: number;
  /** 입력 필드의 키 입력 1회 (latex 전체값 + 캐럿). */
  onEdit: (latex: string, caret: number) => void;
  onEnter: (latex: string) => void;
  onRemove: () => void;
  /** 위상정렬·평가 포함 여부 토글 (`FormulaObject.enabled`). */
  onToggleEnabled: () => void;
  /** 등식 셀의 solve 대상 지정. `null`이면 해제(결과가 빈다). */
  onSetSolveFor: (symbol: string | null) => void;
  /** 선택 변환처럼 즉시 평가돼야 하는 명시적 편집. selectionBefore = 조작 직전 선택. */
  onCommitDistinct: (
    latex: string,
    caret?: number,
    selectionBefore?: readonly [number, number],
  ) => void;
  /** 드래그 핸들 이벤트 (그룹 최상단에서만 쓴다 — 재정렬은 CellStack이 조율). */
  onDragStart?: (e: React.PointerEvent) => void;
  onDragMove?: (e: React.PointerEvent) => void;
  onDragEnd?: () => void;
  /** 캐럿이 셀 경계를 넘으려 할 때 (셀 간 이동은 CellStack이 조율). */
  onMoveOut?: (direction: 'forward' | 'backward' | 'upward' | 'downward') => void;
  /** 빈 셀에서 backspace (셀 삭제/위 셀 이동은 CellStack이 조율). */
  onDeleteEmpty?: () => void;
  /** Ctrl+Enter(아래)/Ctrl+Shift+Enter(위) — 그룹 밖에 새 빈 셀. */
  onInsertCell?: (position: 'above' | 'below') => void;
  /** Alt+↑/↓ — 이 셀이 속한 그룹 전체를 위/아래로. `caret` 은 누른 순간의 캐럿. */
  onMoveGroup?: (delta: -1 | 1, caret: number) => void;
  /** Shift+Alt+↑/↓ — 이 셀을 복제해 그룹 밖에 놓는다. `caret` 은 위와 같다. */
  onDuplicate?: (position: 'above' | 'below', caret: number) => void;
};

/** 선택 변경마다 워커로 CE를 네 번(expand/simplify/factor/substitute) 돌리므로, 타이핑처럼
 * 빠르게 연달아 오는 선택 변경을 걸러낸다. */
const SELECTION_DEBOUNCE_MS = 120;

/**
 * 입력 행 하나. 결과 행은 그룹의 몫이라 여기 없다 — 셀 그룹의 result 필드는 맨 아래에
 * 단 하나뿐이고 `CellGroup` 이 그린다(`src/state/workspace.ts` 의 그룹 규칙 참고).
 */
export function Cell({
  object,
  result,
  isGroupTop,
  dragging,
  focusToken,
  focusOffset,
  focusSelection,
  syncKey,
  onEdit,
  onEnter,
  onRemove,
  onToggleEnabled,
  onSetSolveFor,
  onCommitDistinct,
  onDragStart,
  onDragMove,
  onDragEnd,
  onMoveOut,
  onDeleteEmpty,
  onInsertCell,
  onMoveGroup,
  onDuplicate,
}: Props) {
  const inputRef = useRef<MathFieldHandle>(null);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  // 워커 요청은 비동기라 응답이 도착하는 순서가 요청한 순서와 다를 수 있다 — 번호를
  // 올려서 최신 요청의 응답만 반영한다(`CellStack.tsx` 의 `latestRequest` 와 같은 패턴).
  const selectionRequestRef = useRef(0);
  const selectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (selectionTimerRef.current !== null) clearTimeout(selectionTimerRef.current);
    };
  }, []);

  const trackSelection = (selected: string | null) => {
    if (selectionTimerRef.current !== null) clearTimeout(selectionTimerRef.current);
    if (selected === null) {
      setSelection(null);
      return;
    }
    const requestId = ++selectionRequestRef.current;
    selectionTimerRef.current = setTimeout(() => {
      readSelectionAsync('input', selected).then((info) => {
        if (selectionRequestRef.current === requestId) setSelection(info);
      });
    }, SELECTION_DEBOUNCE_MS);
  };

  /** 선택을 replacement로 치환하고 커밋한다 (변환·구분 기호 공용). */
  const replaceCurrentSelection = (replacement: string) => {
    const applied = inputRef.current?.replaceSelection(replacement) ?? null;
    if (applied === null) return;
    // 명시적 조작 — structural 편집으로 즉시 평가되고, undo가 선택까지 복구한다.
    onCommitDistinct(applied.value, applied.caret, applied.selectionBefore);
    // setSelection(null)을 부르지 않는다 — replaceSelection이 삽입물의 새 선택을
    // 재보고해서 상태가 이미 갱신됐다 (expand 직후 factor로 되돌리기 등).
  };

  /**
   * 셀에 오류가 있으면 계산성 변환(expand/simplify/factor)을 정지한다.
   * 깨진 식 위에서 변환한 결과는 신뢰할 수 없기 때문.
   * (구분 기호 툴바는 계산이 아니라 표기 변경이므로 막지 않는다.)
   */
  const transformsBlocked = result.kind === 'error';

  const applyTransform = (op: SelectionOp) => {
    if (selection === null || transformsBlocked) return;
    const replacement = selection.replacements[op];
    if (replacement === undefined) return;
    replaceCurrentSelection(replacement);
  };

  // 이 셀이 등식(`2x+1=7`)인가 — solve 버튼 노출 판정에만 쓴다. 실제 그래프 진입 판정은
  // `cellGraph.ts` 가 같은 함수로 따로 한다(판정이 두 벌이면 어긋난다).
  const isRelation = splitRelation(object.latex) !== null;
  // ⚠ `transformsBlocked` 를 타면 안 된다 — solve가 "근 없음" 오류를 내면 결과가
  // `kind:'error'` 가 되는데, 그 게이트를 쓰면 버튼이 사라져 토글을 끌 수가 없다.
  const showSolveButton = SOLVE_ENABLED && isRelation && selection !== null && selection.solveSymbol !== null;

  const cellClassName = ['cell', dragging && 'cell-dragging', !object.enabled && 'cell-disabled']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cellClassName}>
      <div className="cell-input">
        {/* 임시 위치 — 셀 제일 왼쪽. 위상정렬·평가에서 이 셀을 뺄지 토글한다. */}
        <button
          type="button"
          className="cell-toggle"
          title={object.enabled ? 'Exclude from calculation' : 'Include in calculation'}
          onClick={onToggleEnabled}
        >
          {object.enabled ? '●' : '○'}
        </button>
        {/* 드래그 핸들은 그룹 최상단에만 — 그룹 전체가 한 단위로 움직인다. */}
        {isGroupTop ? (
          <div
            className="drag-handle"
            title="Drag to reorder"
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
          >
            ⠿
          </div>
        ) : (
          <div className="drag-handle-spacer" />
        )}
        {/* 선택 위 플로팅 툴바 (행렬 구분 기호). */}
        {selection !== null && (
          <SelectionToolbar
            selectedLatex={selection.latex}
            onReplace={(latex) => replaceCurrentSelection(latex)}
          />
        )}
        {/* 변환 버튼(expand/simplify/factor)의 모바일용 플로팅 사본 — `.cell-actions`
            가 좁은 화면에서 통째로 숨으므로, 선택 위로 뜨는 이 사본이 대신 보인다.
            데스크톱에서는 `.transform-popup` 기본 규칙(styles.css)이 숨겨서 아래
            `.cell-actions` 안의 인라인 버튼만 보인다. */}
        {selection !== null && !transformsBlocked && (
          <div className="transform-popup">
            <TransformButtons selection={selection} onApply={applyTransform} />
          </div>
        )}
        <FieldClip watch={object.latex}>
          <MathField
            ref={inputRef}
            value={object.latex}
            focusToken={focusToken}
            focusOffset={focusOffset}
            focusSelection={focusSelection}
            syncKey={syncKey}
            onEdit={onEdit}
            onEnter={onEnter}
            onSelectionChange={trackSelection}
            onMoveOut={onMoveOut}
            onTransformShortcut={applyTransform}
            onDeleteEmpty={onDeleteEmpty}
            onInsertCell={onInsertCell}
            onMoveGroup={onMoveGroup}
            onDuplicate={onDuplicate}
          />
        </FieldClip>
        <div className="cell-actions">
          {/* 선택 변환 버튼 — 조작 대상 옆에. 오류 셀에서는 숨긴다. */}
          {selection !== null && !transformsBlocked && (
            <TransformButtons selection={selection} onApply={applyTransform} />
          )}
          {/* 등식 셀에서 변수 하나를 선택하면 뜨는 solve 토글. 이미 그 변수로 풀고
              있으면 눌러서 해제한다. `transformsBlocked` 밖에 있다 — 근이 없어 결과가
              오류가 돼도 토글을 끌 수 있어야 한다. */}
          {showSolveButton && selection !== null && selection.solveSymbol !== null && (
            <button
              type="button"
              className={
                object.solveFor === selection.solveSymbol
                  ? 'transform-btn solve-btn solve-btn-active'
                  : 'transform-btn solve-btn'
              }
              title={`Solve the equation for ${selection.solveSymbol}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                onSetSolveFor(
                  object.solveFor === selection.solveSymbol ? null : selection.solveSymbol,
                )
              }
            >
              solve for {selection.solveSymbol}
            </button>
          )}
          {/* 그룹 최상단은 그룹 전체 삭제(큰 ×), 하위 셀은 자기 자신만(작은 ×). */}
          <button
            type="button"
            className={isGroupTop ? 'remove' : 'remove remove-sub'}
            title={isGroupTop ? 'Delete group' : 'Delete cell'}
            onClick={onRemove}
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
}
