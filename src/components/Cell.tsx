import { useRef, useState } from 'react';
import type { FormulaObject, EvalResult } from '../types';
import { MathField, type MathFieldHandle } from './MathField';
import { expand, factor, parse, render, simplify, type Env } from '../algebra';
import { repairLatex } from '../editor/wellformed';
import { SelectionToolbar } from './SelectionToolbar';

type Props = {
  object: FormulaObject;
  result: EvalResult;
  /** 심볼 모양 환경 — 변환이 `A` 가 행렬인지 스칼라인지 알려면 필요하다. */
  env: Env;
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
 * 선택 위에서 제공하는 변환. algebra의 `TransformOp` 은 `substitute` 까지 포함하지만
 * 버튼으로 내보내는 건 이 셋뿐이다.
 */
type SelectionOp = 'expand' | 'simplify' | 'factor';

const TRANSFORM_OPS: readonly SelectionOp[] = ['expand', 'simplify', 'factor'];

const OPS: Record<SelectionOp, typeof simplify> = { expand, simplify, factor };

/** 현재 선택 상태: 어느 필드에서, 무엇이 선택됐고, 어떤 변환이 가능한지. */
type SelectionInfo = {
  field: 'input' | 'result';
  latex: string;
  replacements: Partial<Record<SelectionOp, string>>;
  /**
   * algebra가 이 선택을 아예 못 읽었을 때의 이유 (모양 불일치·모호한 순서·미지원).
   * 버튼 대신 이걸 보여준다 — 무엇을 아직 못 하는지가 보여야 다음에 뭘 깎을지 안다.
   */
  error: string | null;
};

/**
 * 변환 결과를 주변 LaTeX에 끼워 넣을 수 있는 꼴로 만든다.
 *
 * `x^3+3x^2+3x+1` 에서 `+3x^2+3x` 를 선택해 변환하면 결과가 `3x(x+1)` 처럼 연산자 없이
 * 시작할 수 있다. 그대로 넣으면 앞의 `x^3` 과 붙어 곱셈이 돼버리므로, 선택이 부호로
 * 시작했다면 치환도 부호로 시작하게 한다. (선행 `-` 의 의미는 이미 파싱된 식에
 * 들어 있어서, 결과가 `-` 로 시작하지 않으면 `+` 합류가 수학적으로 옳다.)
 *
 * **끼워 넣기는 앱의 문제라 algebra가 아니라 여기 있다** — 그 모듈은 주변 문맥을 모른다.
 */
function joinSign(source: string, out: string): string {
  const needsJoin = source.startsWith('+') || source.startsWith('-');
  const startsWithSign = out.startsWith('+') || out.startsWith('-');
  return needsJoin && !startsWithSign ? `+${out}` : out;
}

/**
 * 선택 조각을 **한 번만** 파싱하고, 그 Typed IR 위에서 세 변환을 각각 돌린다.
 * (구 엔진 경로는 op마다 CE 왕복을 따로 했다.)
 *
 * op 하나가 실패해도 나머지는 살린다 — factor는 못 해도 expand는 되는 식이 흔하다.
 */
function readSelection(field: 'input' | 'result', selected: string, env: Env): SelectionInfo {
  const replacements: Partial<Record<SelectionOp, string>> = {};
  // 방어선 2: 선택 조각에 파손된 구조가 섞여 있어도 파싱은 되게.
  const raw = repairLatex(selected.trim()).latex;
  if (raw === '') return { field, latex: selected, replacements, error: null };

  const parsed = parse(raw, env);
  if (!parsed.ok) {
    return { field, latex: selected, replacements, error: parsed.errors[0].message };
  }

  for (const op of TRANSFORM_OPS) {
    const out = OPS[op](parsed.value, env);
    if (!out.ok) continue;
    replacements[op] = joinSign(raw, render(out.value));
  }
  return { field, latex: selected, replacements, error: null };
}

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
  env,
  dragging,
  focusToken,
  focusOffset,
  focusSelection,
  syncKey,
  onEdit,
  onEnter,
  onRemove,
  onToggleEnabled,
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
      const next = selected === null ? null : readSelection(field, selected, env);
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
