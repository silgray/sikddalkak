import { useEffect, useRef, useState, type Dispatch } from 'react';
import type { SelectionInfo, SelectionOp } from '../cellSelection';
import { groupResultTargetId, pickGroupDisplay } from '../cellGroup';
import type { Action, Tab } from '../state/workspace';
import type { EvalResult, FormulaObject } from '../types';
import { readSelectionAsync } from '../worker/client';
import { Cell } from './Cell';
import { MathField, type MathFieldHandle } from './MathField';
import { TransformButtons } from './TransformButtons';

/** 공백 차이는 MathLive 재직렬화 재량이라 "달라졌다" 판정에서 뺀다. */
const norm = (s: string) => s.replace(/\s+/g, '');

/** 선택 변경 디바운스 — `Cell.tsx` 와 같은 이유(워커 CE 호출 억제). */
const SELECTION_DEBOUNCE_MS = 120;

type Props = {
  /** 이 그룹의 셀들, 문서 순서대로. 최소 하나. */
  objects: readonly FormulaObject[];
  /** tab.objects 안에서 이 그룹이 시작하는 절대 인덱스 (onMoveOut/onDeleteEmpty용). */
  startIndex: number;
  results: ReadonlyMap<string, EvalResult>;
  dragging: boolean;
  focus: Tab['focus'];
  syncKey: number;
  dispatch: Dispatch<Action>;
  onDragStart: (e: React.PointerEvent) => void;
  onDragMove: (e: React.PointerEvent) => void;
  onDragEnd: () => void;
  onMoveOut: (index: number, direction: 'forward' | 'backward' | 'upward' | 'downward') => void;
  onDeleteEmpty: (index: number) => void;
};

/**
 * 셀 그룹 하나 — 입력 행 여러 개(각자 `Cell`) + result 필드 하나(그룹 맨 아래).
 *
 * 표시 규칙(`CLAUDE.md`, 워크스페이스 그룹 규칙 참고):
 * - Enter로 확정(`entered`)한 셀이 있으면 그 결과를 무조건 보여준다(오류라도).
 * - 없으면 그룹이 셀 하나뿐이고 그 결과가 입력과 구조적으로 달라졌을 때만(`unchanged`
 *   아닐 때만) 조용히 보여준다 — 계산이 아무것도 안 바꿨는데 줄이 느는 걸 막는다.
 * - 그 밖(둘 이상 셀인데 아무도 확정 안 함)엔 아무것도 안 보여준다.
 */
export function CellGroup({
  objects,
  startIndex,
  results,
  dragging,
  focus,
  syncKey,
  dispatch,
  onDragStart,
  onDragMove,
  onDragEnd,
  onMoveOut,
  onDeleteEmpty,
}: Props) {
  const resultRef = useRef<MathFieldHandle>(null);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  // 워커 요청은 비동기라 응답 순서가 요청 순서와 다를 수 있다 — 번호를 올려 최신
  // 요청의 응답만 반영한다(`CellStack.tsx` 의 `latestRequest` 와 같은 패턴).
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
      readSelectionAsync('result', selected).then((info) => {
        if (selectionRequestRef.current === requestId) setSelection(info);
      });
    }, SELECTION_DEBOUNCE_MS);
  };

  const display = pickGroupDisplay(objects, results);
  // 결과를 편집하면 이 그룹의 새 셀이 된다 — 확정한 셀이 있으면 그 셀 뒤에, 없으면
  // (상시 표시 중인 단일 셀 그룹) 그 유일한 셀 뒤에.
  const editResultTargetId = groupResultTargetId(objects);

  const applyTransform = (op: SelectionOp) => {
    if (selection === null) return;
    const replacement = selection.replacements[op];
    if (replacement === undefined) return;
    const applied = resultRef.current?.replaceSelection(replacement) ?? null;
    if (applied === null) return;
    if (display.kind === 'ok' && norm(applied.value) !== norm(display.latex)) {
      dispatch({ type: 'editResult', id: editResultTargetId, latex: applied.value, cursor: applied.caret });
    }
  };

  // 결과도 일반 식처럼 편집할 수 있다. 실제로 내용이 바뀌는 첫 키 입력 순간
  // 그룹의 새 셀로 갈라지고, 캐럿은 새 오브젝트의 같은 자리로 이어진다.
  const detachIfChanged = (latex: string, caret?: number) => {
    if (display.kind === 'ok' && norm(latex) === norm(display.latex)) return;
    dispatch({ type: 'editResult', id: editResultTargetId, latex, cursor: caret });
  };

  return (
    <div className={['cell-group', dragging && 'cell-group-dragging'].filter(Boolean).join(' ')}>
      {objects.map((object, i) => {
        const index = startIndex + i;
        return (
          <Cell
            key={object.id}
            object={object}
            result={results.get(object.id) ?? { kind: 'pending' }}
            isGroupTop={i === 0}
            dragging={dragging}
            focusToken={focus?.id === object.id ? focus.token : null}
            focusOffset={focus?.id === object.id ? (focus.offset ?? null) : null}
            focusSelection={focus?.id === object.id ? (focus.selection ?? null) : null}
            syncKey={syncKey}
            onEdit={(latex, caret) => dispatch({ type: 'editInput', id: object.id, latex, cursor: caret })}
            onEnter={(latex) => dispatch({ type: 'enter', id: object.id, latex })}
            onRemove={() =>
              dispatch(
                i === 0 ? { type: 'removeGroup', id: object.id } : { type: 'remove', id: object.id },
              )
            }
            onToggleEnabled={() => dispatch({ type: 'setEnabled', id: object.id, enabled: !object.enabled })}
            onSetSolveFor={(symbol) => dispatch({ type: 'setSolveFor', id: object.id, symbol })}
            onCommitDistinct={(latex, caret, selectionBefore) =>
              dispatch({ type: 'commitInput', id: object.id, latex, cursor: caret, selectionBefore })
            }
            onDragStart={i === 0 ? onDragStart : undefined}
            onDragMove={i === 0 ? onDragMove : undefined}
            onDragEnd={i === 0 ? onDragEnd : undefined}
            onMoveOut={(direction) => onMoveOut(index, direction)}
            onDeleteEmpty={() => onDeleteEmpty(index)}
          />
        );
      })}
      {display.kind !== 'empty' && display.kind !== 'pending' && (
        <ResultRow
          result={display}
          syncKey={syncKey}
          fieldRef={resultRef}
          selection={selection}
          onApply={applyTransform}
          onDetach={detachIfChanged}
          onSelectionChange={trackSelection}
          onTransformShortcut={applyTransform}
        />
      )}
    </div>
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
  result: Extract<EvalResult, { kind: 'error' | 'boolean' | 'ok' }>;
  syncKey: number;
  fieldRef: React.Ref<MathFieldHandle>;
  selection: SelectionInfo | null;
  onApply: (op: SelectionOp) => void;
  onDetach: (latex: string, caret?: number) => void;
  onSelectionChange: (selectedLatex: string | null) => void;
  onTransformShortcut: (op: SelectionOp) => void;
}) {
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
      <MathField
        ref={fieldRef}
        value={result.latex}
        syncKey={syncKey}
        onEdit={onDetach}
        onEnter={(latex) => onDetach(latex)}
        onSelectionChange={onSelectionChange}
        onTransformShortcut={onTransformShortcut}
      />
      {selection !== null && (
        <div className="result-actions">
          <TransformButtons selection={selection} onApply={onApply} />
        </div>
      )}
    </div>
  );
}
