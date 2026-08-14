import { useEffect, useRef, useState } from 'react';
import type { FormulaObject, EvalResult } from '../types';
import { MathField, type MathFieldHandle } from './MathField';
import { splitRelation } from '../cellEnv';
import { SOLVE_ENABLED } from '../features';
import { SelectionToolbar } from './SelectionToolbar';
import { readSelectionAsync } from '../worker/client';
import { TRANSFORM_OPS, type SelectionInfo, type SelectionOp } from '../cellSelection';

type Props = {
  object: FormulaObject;
  result: EvalResult;
  /** 이 셀이 드래그 중인지 (반투명 표시). */
  dragging: boolean;
  focusToken: number | null;
  focusOffset: number | null;
  focusSelection: readonly [number, number] | null;
  syncKey: number;
  /** 입력 필드의 키 입력 1회 (latex 전체값 + 캐럿). */
  onEdit: (latex: string, caret: number) => void;
  onEnter: (latex: string) => void;
  onRemove: () => void;
  /** 위상정렬·평가 포함 여부 토글 (`object.enabled`). */
  onToggleEnabled: () => void;
  /** 등식 셀의 solve 대상 지정. `null`이면 해제(결과가 빈다). */
  onSetSolveFor: (symbol: string | null) => void;
  /** 결과 행을 편집해 독립 식으로 분리할 때 (편집된 latex + 캐럿). */
  onDetachResult: (latex: string, caret?: number) => void;
  /** 선택 변환처럼 즉시 평가돼야 하는 명시적 편집. selectionBefore = 조작 직전 선택. */
  onCommitDistinct: (
    latex: string,
    caret?: number,
    selectionBefore?: readonly [number, number],
  ) => void;
  /** 드래그 핸들 이벤트 (재정렬은 CellStack이 조율). */
  onDragStart: (e: React.PointerEvent) => void;
  onDragMove: (e: React.PointerEvent) => void;
  onDragEnd: () => void;
  /** 캐럿이 셀 경계를 넘으려 할 때 (셀 간 이동은 CellStack이 조율). */
  onMoveOut?: (direction: 'forward' | 'backward' | 'upward' | 'downward') => void;
  /** 빈 셀에서 backspace (셀 삭제/위 셀 이동은 CellStack이 조율). */
  onDeleteEmpty?: () => void;
};

/** 공백 차이는 MathLive 재직렬화 재량이라 "달라졌다" 판정에서 뺀다. */
const norm = (s: string) => s.replace(/\s+/g, '');

/**
 * 변환 버튼 묶음. 선택이 있는 필드 바로 옆에 렌더한다.
 * mousedown preventDefault로 포커스(=선택)를 뺏지 않는다.
 *
 * algebra가 선택을 못 읽었으면 버튼 대신 그 이유를 같은 자리에 보여준다. 조용히
 * 사라지면 "안 바뀐 것"과 "못 읽은 것"을 구분할 수 없다 — 지금은 후자를 봐야 하는
 * 시기다. 메시지는 algebra가 영어로 낸 것을 그대로 쓴다.
 */
function TransformButtons({
  selection,
  onApply,
}: {
  selection: SelectionInfo;
  onApply: (op: SelectionOp) => void;
}) {
  if (selection.error !== null) {
    return <span className="result-error">⚠ {selection.error}</span>;
  }
  return (
    <>
      {TRANSFORM_OPS.filter((op) => selection.replacements[op] !== undefined).map((op) => (
        <button
          key={op}
          type="button"
          className="transform-btn"
          title={`Apply ${op} to the selection`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onApply(op)}
        >
          {op}
        </button>
      ))}
    </>
  );
}

function ResultRow({
  result,
  syncKey,
  fieldRef,
  selection,
  onApply,
  onDetach,
  onSelectionChange,
  onTransformShortcut,
}: {
  result: EvalResult;
  syncKey: number;
  fieldRef: React.Ref<MathFieldHandle>;
  selection: SelectionInfo | null;
  onApply: (op: SelectionOp) => void;
  onDetach: (latex: string, caret?: number) => void;
  onSelectionChange: (selectedLatex: string | null) => void;
  onTransformShortcut: (op: SelectionOp) => void;
}) {
  // `pending` 은 아직 응답 못 받은 새 셀 — 이전 값이 없으니 흐릴 것도 없이 조용히 있는다
  // (`types.ts` 의 `EvalResult` 문서 참고). 이미 결과가 있던 셀은 새 계산이 도는 동안
  // `CellStack.tsx` 의 `results` 맵이 마지막 값을 그대로 들고 있어 깜빡이지 않는다.
  if (result.kind === 'empty' || result.kind === 'pending') return null;
  if (result.kind === 'error') {
    return <div className="result result-error">⚠ {result.message}</div>;
  }
  if (result.kind === 'boolean') {
    return (
      <div className="result">
        <span className="result-arrow">=</span>
        <span className={result.value ? 'verdict verdict-true' : 'verdict verdict-false'}>
          {result.value ? 'True' : 'False'}
        </span>
      </div>
    );
  }
  // 결과도 일반 식처럼 편집할 수 있다. 실제로 내용이 바뀌는 첫 키 입력 순간
  // 독립 식으로 분리되고, 캐럿은 새 오브젝트의 같은 자리로 이어진다.
  const detachIfChanged = (latex: string, caret?: number) => {
    if (norm(latex) !== norm(result.latex)) onDetach(latex, caret);
  };
  return (
    <div className={result.definitionName !== null ? 'result result-def' : 'result'}>
      <span className="result-arrow">=</span>
      <MathField
        ref={fieldRef}
        value={result.latex}
        syncKey={syncKey}
        onEdit={detachIfChanged}
        onEnter={(latex) => detachIfChanged(latex)}
        onSelectionChange={onSelectionChange}
        onTransformShortcut={onTransformShortcut}
      />
      {/* 결과 필드의 선택 변환 버튼은 결과 행에 뜬다 — 조작 대상 옆에. */}
      {selection !== null && selection.field === 'result' && (
        <div className="result-actions">
          <TransformButtons selection={selection} onApply={onApply} />
        </div>
      )}
    </div>
  );
}

/** 선택 변경마다 워커로 CE를 네 번(expand/simplify/factor/substitute) 돌리므로, 타이핑처럼
 * 빠르게 연달아 오는 선택 변경을 걸러낸다. */
const SELECTION_DEBOUNCE_MS = 120;

export function Cell({
  object,
  result,
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
  onDetachResult,
  onCommitDistinct,
  onDragStart,
  onDragMove,
  onDragEnd,
  onMoveOut,
  onDeleteEmpty,
}: Props) {
  const inputRef = useRef<MathFieldHandle>(null);
  const resultRef = useRef<MathFieldHandle>(null);
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

  const trackSelection = (field: 'input' | 'result') => (selected: string | null) => {
    if (selectionTimerRef.current !== null) clearTimeout(selectionTimerRef.current);
    if (selected === null) {
      setSelection((current) => {
        // 다른 필드의 선택 상태를 지우지 않도록, null 갱신은 같은 필드일 때만.
        if (current !== null && current.field !== field) return current;
        return null;
      });
      return;
    }
    const requestId = ++selectionRequestRef.current;
    selectionTimerRef.current = setTimeout(() => {
      readSelectionAsync(field, selected).then((info) => {
        if (selectionRequestRef.current === requestId) setSelection(info);
      });
    }, SELECTION_DEBOUNCE_MS);
  };

  /** 선택을 replacement로 치환하고 적절한 커밋 경로로 보낸다 (변환·구분 기호 공용). */
  const replaceCurrentSelection = (field: 'input' | 'result', replacement: string) => {
    const handle = field === 'input' ? inputRef.current : resultRef.current;
    const applied = handle?.replaceSelection(replacement) ?? null;
    if (applied === null) return;
    if (field === 'input') {
      // 명시적 조작 — structural 편집으로 즉시 평가되고, undo가 선택까지 복구한다.
      onCommitDistinct(applied.value, applied.caret, applied.selectionBefore);
    } else if (result.kind === 'ok' && norm(applied.value) !== norm(result.latex)) {
      // 결과 필드의 조작은 곧 결과 편집 — 분리 규칙을 그대로 따른다.
      onDetachResult(applied.value, applied.caret);
    }
    // setSelection(null)을 부르지 않는다 — replaceSelection이 삽입물의 새 선택을
    // 재보고해서 상태가 이미 갱신됐다 (expand 직후 factor로 되돌리기 등).
  };

  /**
   * 셀에 오류가 있으면 계산성 변환(expand/simplify/factor)을 정지한다.
   * 깨진 식 위에서 변환한 결과는 신뢰할 수 없기 때문. 결과 행은 이미 오류일 때
   * 통째로 대체되므로(ResultRow), 여기서 막는 건 입력 쪽 버튼과 단축키다.
   * (구분 기호 툴바는 계산이 아니라 표기 변경이므로 막지 않는다.)
   */
  const transformsBlocked = result.kind === 'error';

  const applyTransform = (op: SelectionOp) => {
    if (selection === null || transformsBlocked) return;
    const replacement = selection.replacements[op];
    if (replacement === undefined) return;
    replaceCurrentSelection(selection.field, replacement);
  };

  // 이 셀이 등식(`2x+1=7`)인가 — solve 버튼 노출 판정에만 쓴다. 실제 그래프 진입 판정은
  // `cellGraph.ts` 가 같은 함수로 따로 한다(판정이 두 벌이면 어긋난다).
  const isRelation = splitRelation(object.latex) !== null;
  // ⚠ `transformsBlocked` 를 타면 안 된다 — solve가 "근 없음" 오류를 내면 결과가
  // `kind:'error'` 가 되는데, 그 게이트를 쓰면 버튼이 사라져 토글을 끌 수가 없다.
  // `SOLVE_ENABLED` 는 CE 0.90이 초월식을 못 풀어서 잠시 꺼둔 기능 플래그다
  // (`src/features.ts` 참고) — 꺼져 있으면 버튼 자체를 안 낸다.
  const showSolveButton =
    SOLVE_ENABLED &&
    isRelation &&
    selection !== null &&
    selection.field === 'input' &&
    selection.solveSymbol !== null;

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
        {/* 선택 위 플로팅 툴바 (행렬 구분 기호). 입력 필드 선택에만. */}
        {selection !== null && selection.field === 'input' && (
          <SelectionToolbar
            selectedLatex={selection.latex}
            onReplace={(latex) => replaceCurrentSelection('input', latex)}
          />
        )}
        <MathField
          ref={inputRef}
          value={object.latex}
          focusToken={focusToken}
          focusOffset={focusOffset}
          focusSelection={focusSelection}
          syncKey={syncKey}
          onEdit={onEdit}
          onEnter={onEnter}
          onSelectionChange={trackSelection('input')}
          onMoveOut={onMoveOut}
          onTransformShortcut={applyTransform}
          onDeleteEmpty={onDeleteEmpty}
        />
        <div className="cell-actions">
          {/* 입력 필드의 선택 변환 버튼 — 조작 대상 옆에. 오류 셀에서는 숨긴다. */}
          {selection !== null && selection.field === 'input' && !transformsBlocked && (
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
          <button type="button" className="remove" title="Delete cell" onClick={onRemove}>
            ×
          </button>
        </div>
      </div>
      <ResultRow
        result={result}
        syncKey={syncKey}
        fieldRef={resultRef}
        selection={selection}
        onApply={applyTransform}
        onDetach={onDetachResult}
        onSelectionChange={trackSelection('result')}
        onTransformShortcut={applyTransform}
      />
    </div>
  );
}
