import { useRef, useState } from 'react';
import type { FormulaObject, CellMode, EvalResult } from '../types';
import { MathField, type MathFieldHandle } from './MathField';
import { transformSelection, type TransformOp } from '../engine/transform';

type Props = {
  object: FormulaObject;
  result: EvalResult;
  focusToken: number | null;
  syncKey: number;
  onFlush: (latex: string) => void;
  onEnter: (latex: string) => void;
  onModeChange: (mode: CellMode) => void;
  onRemove: () => void;
  /** 결과 행을 편집해 독립 식으로 분리할 때 (편집된 latex 전달). */
  onDetachResult: (latex: string) => void;
  /** 선택 변환처럼 앞뒤 편집과 합쳐지면 안 되는 확정 (독립 실행취소 단계). */
  onCommitDistinct: (latex: string) => void;
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
  onDetach: (latex: string) => void;
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
  // 결과도 일반 식처럼 편집할 수 있다. 실제로 내용이 바뀌었을 때만
  // (MathField의 dirty 판정 + 정규화 비교) 독립 식으로 분리한다.
  const detachIfChanged = (latex: string) => {
    if (norm(latex) !== norm(result.latex)) onDetach(latex);
  };
  return (
    <div className={result.definitionName !== null ? 'result result-def' : 'result'}>
      <span className="result-arrow">=</span>
      <MathField
        ref={fieldRef}
        value={result.latex}
        syncKey={syncKey}
        onFlush={detachIfChanged}
        onEnter={detachIfChanged}
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
  focusToken,
  syncKey,
  onFlush,
  onEnter,
  onModeChange,
  onRemove,
  onDetachResult,
  onCommitDistinct,
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
    const newValue = handle?.replaceSelection(replacement) ?? null;
    if (newValue === null) return;
    if (transforms.field === 'input') {
      // 명시적 조작이므로 앞뒤 타이핑과 합쳐지지 않는 독립 실행취소 단계로 확정.
      onCommitDistinct(newValue);
    } else if (result.kind === 'ok' && norm(newValue) !== norm(result.latex)) {
      // 결과 필드의 변환은 곧 결과 편집 — 분리 규칙을 그대로 따른다.
      onDetachResult(newValue);
    }
    setTransforms(null);
  };

  return (
    <div className="cell">
      <div className="cell-input">
        <MathField
          ref={inputRef}
          value={object.latex}
          focusToken={focusToken}
          syncKey={syncKey}
          onFlush={onFlush}
          onEnter={onEnter}
          onSelectionChange={trackSelection('input')}
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
