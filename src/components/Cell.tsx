import { useRef, useState } from 'react';
import type { FormulaObject, EvalResult } from '../types';
import { MathField, type MathFieldHandle } from './MathField';
import { transformSelection, type TransformOp } from '../engine/transform';
import { SelectionToolbar } from './SelectionToolbar';

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

const TRANSFORM_OPS: readonly TransformOp[] = ['expand', 'simplify', 'factor'];

/** 현재 선택 상태: 어느 필드에서, 무엇이 선택됐고, 어떤 변환이 가능한지. */
type SelectionInfo = {
  field: 'input' | 'result';
  latex: string;
  replacements: Partial<Record<TransformOp, string>>;
};

function readSelection(field: 'input' | 'result', selected: string): SelectionInfo {
  const replacements: Partial<Record<TransformOp, string>> = {};
  for (const op of TRANSFORM_OPS) {
    const out = transformSelection(selected, op);
    if (out !== null) replacements[op] = out;
  }
  return { field, latex: selected, replacements };
}

/**
 * 변환 버튼 묶음. 선택이 있는 필드 바로 옆에 렌더한다.
 * mousedown preventDefault로 포커스(=선택)를 뺏지 않는다.
 */
function TransformButtons({
  selection,
  onApply,
}: {
  selection: SelectionInfo;
  onApply: (op: TransformOp) => void;
}) {
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
  onApply: (op: TransformOp) => void;
  onDetach: (latex: string, caret?: number) => void;
  onSelectionChange: (selectedLatex: string | null) => void;
  onTransformShortcut: (op: TransformOp) => void;
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

  const trackSelection = (field: 'input' | 'result') => (selected: string | null) => {
    setSelection((current) => {
      const next = selected === null ? null : readSelection(field, selected);
      // 다른 필드의 선택 상태를 지우지 않도록, null 갱신은 같은 필드일 때만.
      if (next === null && current !== null && current.field !== field) return current;
      return next;
    });
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

  const applyTransform = (op: TransformOp) => {
    if (selection === null) return;
    const replacement = selection.replacements[op];
    if (replacement === undefined) return;
    replaceCurrentSelection(selection.field, replacement);
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
          {/* 입력 필드의 선택 변환 버튼 — 조작 대상 옆에. */}
          {selection !== null && selection.field === 'input' && (
            <TransformButtons selection={selection} onApply={applyTransform} />
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
