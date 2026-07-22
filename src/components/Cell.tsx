import type { FormulaObject, CellMode, EvalResult } from '../types';
import { MathField } from './MathField';

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
};

/** 공백 차이는 MathLive 재직렬화 재량이라 "편집됨" 판정에서 뺀다. */
const norm = (s: string) => s.replace(/\s+/g, '');

function ResultRow({
  result,
  syncKey,
  onDetach,
}: {
  result: EvalResult;
  syncKey: number;
  onDetach: (latex: string) => void;
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
        value={result.latex}
        syncKey={syncKey}
        onFlush={detachIfChanged}
        onEnter={detachIfChanged}
      />
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
}: Props) {
  const isDefinition = result.kind === 'ok' && result.definitionName !== null;

  return (
    <div className="cell">
      <div className="cell-input">
        <MathField
          value={object.latex}
          focusToken={focusToken}
          syncKey={syncKey}
          onFlush={onFlush}
          onEnter={onEnter}
        />
        <div className="cell-actions">
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
      <ResultRow result={result} syncKey={syncKey} onDetach={onDetachResult} />
    </div>
  );
}
