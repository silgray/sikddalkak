import type { Cell as CellData, CellMode, EvalResult } from '../types';
import { MathField } from './MathField';

type Props = {
  cell: CellData;
  result: EvalResult;
  focusToken: number | null;
  onInput: (input: string) => void;
  onCommit: (input: string) => void;
  onModeChange: (mode: CellMode) => void;
  onRemove: () => void;
};

function ResultRow({ result }: { result: EvalResult }) {
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
  return (
    <div className={result.definitionName !== null ? 'result result-def' : 'result'}>
      <span className="result-arrow">=</span>
      <MathField value={result.latex} readOnly />
    </div>
  );
}

export function Cell({ cell, result, focusToken, onInput, onCommit, onModeChange, onRemove }: Props) {
  const isDefinition = result.kind === 'ok' && result.definitionName !== null;

  return (
    <div className="cell">
      <div className="cell-input">
        <MathField
          value={cell.input}
          focusToken={focusToken}
          onInput={onInput}
          onCommit={onCommit}
        />
        <div className="cell-actions">
          {/* 정의 셀은 항상 바인딩을 만들므로 모드 토글이 의미가 없다. */}
          {!isDefinition && (
            <button
              type="button"
              className="mode-toggle"
              title={
                cell.mode === 'scoped'
                  ? 'Substitutes variables defined in the cells above'
                  : 'Leaves variables as unknowns'
              }
              onClick={() => onModeChange(cell.mode === 'scoped' ? 'symbolic' : 'scoped')}
            >
              {cell.mode === 'scoped' ? 'scoped' : 'symbolic'}
            </button>
          )}
          <button type="button" className="remove" title="Delete cell" onClick={onRemove}>
            ×
          </button>
        </div>
      </div>
      <ResultRow result={result} />
    </div>
  );
}
