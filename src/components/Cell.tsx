import { useRef, useState } from 'react';
import type { FormulaObject, CellMode, EvalResult } from '../types';
import { MathField, type MathFieldHandle } from './MathField';
import { transformSelection, type TransformOp } from '../engine/transform';

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
  onModeChange: (mode: CellMode) => void;
  onRemove: () => void;
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
};

/** 공백 차이는 MathLive 재직렬화 재량이라 "달라졌다" 판정에서 뺀다. */
const norm = (s: string) => s.replace(/\s+/g, '');

const TRANSFORM_OPS: readonly TransformOp[] = ['expand', 'simplify', 'factor'];

/** 어느 필드에 어떤 변환이 가능한지. 실질 변화가 있는 것만 값이 있다. */
type SelectionTransforms = {
  field: 'input' | 'result';
  replacements: Partial<Record<TransformOp, string>>;
};

function availableTransforms(
  field: 'input' | 'result',
  selected: string,
): SelectionTransforms | null {
  const replacements: Partial<Record<TransformOp, string>> = {};
  for (const op of TRANSFORM_OPS) {
    const out = transformSelection(selected, op);
    if (out !== null) replacements[op] = out;
  }
  return Object.keys(replacements).length > 0 ? { field, replacements } : null;
}

/**
 * 변환 버튼 묶음. 선택이 있는 필드 바로 옆에 렌더한다.
 * mousedown preventDefault로 포커스(=선택)를 뺏지 않는다.
 */
function TransformButtons({
  transforms,
  onApply,
}: {
  transforms: SelectionTransforms;
  onApply: (op: TransformOp) => void;
}) {
  return (
    <>
      {TRANSFORM_OPS.filter((op) => transforms.replacements[op] !== undefined).map((op) => (
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
  transforms,
  onApply,
  onDetach,
  onSelectionChange,
}: {
  result: EvalResult;
  syncKey: number;
  fieldRef: React.Ref<MathFieldHandle>;
  transforms: SelectionTransforms | null;
  onApply: (op: TransformOp) => void;
  onDetach: (latex: string, caret?: number) => void;
  onSelectionChange: (selectedLatex: string | null) => void;
}) {
  if (result.kind === 'empty') return null;
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
      />
      {/* 결과 필드의 선택 변환 버튼은 결과 행에 뜬다 — 조작 대상 옆에. */}
      {transforms !== null && transforms.field === 'result' && (
        <div className="result-actions">
          <TransformButtons transforms={transforms} onApply={onApply} />
        </div>
      )}
    </div>
  );
}

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
  onModeChange,
  onRemove,
  onDetachResult,
  onCommitDistinct,
  onDragStart,
  onDragMove,
  onDragEnd,
  onMoveOut,
}: Props) {
  const isDefinition = result.kind === 'ok' && result.definitionName !== null;

  const inputRef = useRef<MathFieldHandle>(null);
  const resultRef = useRef<MathFieldHandle>(null);
  const [transforms, setTransforms] = useState<SelectionTransforms | null>(null);

  const trackSelection = (field: 'input' | 'result') => (selected: string | null) => {
    setTransforms((current) => {
      const next = selected === null ? null : availableTransforms(field, selected);
      // 다른 필드의 선택 상태를 지우지 않도록, null 갱신은 같은 필드일 때만.
      if (next === null && current !== null && current.field !== field) return current;
      return next;
    });
  };

  const applyTransform = (op: TransformOp) => {
    if (transforms === null) return;
    const replacement = transforms.replacements[op];
    if (replacement === undefined) return;
    const handle = transforms.field === 'input' ? inputRef.current : resultRef.current;
    const applied = handle?.replaceSelection(replacement) ?? null;
    if (applied === null) return;
    if (transforms.field === 'input') {
      // 명시적 조작 — structural 편집으로 즉시 평가된다.
      // 조작 직전 선택을 함께 넘겨 undo가 선택 범위까지 복구하게 한다.
      onCommitDistinct(applied.value, applied.caret, applied.selectionBefore);
    } else if (result.kind === 'ok' && norm(applied.value) !== norm(result.latex)) {
      // 결과 필드의 변환은 곧 결과 편집 — 분리 규칙을 그대로 따른다.
      onDetachResult(applied.value, applied.caret);
    }
    // setTransforms(null)를 부르지 않는다 — replaceSelection이 삽입물의 새 선택을
    // 재보고해서 상태가 이미 갱신됐다 (expand 직후 factor로 되돌리기 등).
  };

  return (
    <div className={dragging ? 'cell cell-dragging' : 'cell'}>
      <div className="cell-input">
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
        />
        <div className="cell-actions">
          {/* 입력 필드의 선택 변환 버튼 — 조작 대상 옆에. */}
          {transforms !== null && transforms.field === 'input' && (
            <TransformButtons transforms={transforms} onApply={applyTransform} />
          )}
          {/* 정의 오브젝트는 항상 바인딩을 만들므로 모드 토글이 의미가 없다. */}
          {!isDefinition && (
            <button
              type="button"
              className="mode-toggle"
              title={
                object.mode === 'scoped'
                  ? 'Substitutes variables defined elsewhere'
                  : 'Leaves variables as unknowns'
              }
              onClick={() => onModeChange(object.mode === 'scoped' ? 'symbolic' : 'scoped')}
            >
              {object.mode === 'scoped' ? 'scoped' : 'symbolic'}
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
        transforms={transforms}
        onApply={applyTransform}
        onDetach={onDetachResult}
        onSelectionChange={trackSelection('result')}
      />
    </div>
  );
}
