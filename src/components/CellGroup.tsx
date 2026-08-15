import { useEffect, useRef, useState, type Dispatch } from 'react';
import type { SelectionInfo, SelectionOp } from '../cellSelection';
import { groupResultTargetId, pickGroupDisplay } from '../cellGroup';
import type { Action, Tab } from '../state/workspace';
import type { EvalResult, FormulaObject } from '../types';
import { approximateAsync, readSelectionAsync } from '../worker/client';
import { Cell } from './Cell';
import { FieldClip } from './FieldClip';
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
  /** Alt+↑/↓ — 그룹 전체를 위/아래로. 어느 셀에서 눌러도 같은 그룹 이동이라 CellStack이
   * 그룹 하나당 하나만 만들어 그대로 내려준다(onMoveOut/onDeleteEmpty와 달리 셀별로
   * 안 갈린다).
   *
   * `refocus` 만 셀별로 갈린다 — 이동 후 어느 필드의 어느 자리로 돌아갈지는 누른
   * 곳마다 다르므로, 그건 이 컴포넌트가 채워서 올린다. */
  onMoveGroup: (delta: -1 | 1, refocus: Refocus) => void;
};

/** 그룹을 옮긴 뒤 되돌아갈 자리. `workspace.ts` 의 `Tab['focus']` 와 같은 규약이다. */
export type Refocus = {
  /** 입력 행이면 오브젝트 id, 결과 행이면 그룹 id (`field: 'result'`). */
  id: string;
  offset: number;
  field?: 'input' | 'result';
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
  onMoveGroup,
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
  const displayShown = display.kind !== 'empty' && display.kind !== 'pending';

  // 결과 행의 표시 모드. `symbolic` 이 정본이고 `numeric` 은 그 위에 얹는 **보기**다 —
  // 문서(`FormulaObject.latex`)는 어느 쪽에서도 안 바뀐다. 그래서 상태가 여기(로컬)에
  // 있고 영속되지 않는다. 그룹은 `groupId` 로 키잉돼 있어 재정렬·재계산에는 살아남는다.
  const [numericMode, setNumericMode] = useState(false);
  const [numericLatex, setNumericLatex] = useState<string | null>(null);
  const numericRequestRef = useRef(0);

  const symbolicLatex = display.kind === 'ok' ? display.latex : null;

  useEffect(() => {
    if (!numericMode || symbolicLatex === null) {
      setNumericLatex(null);
      return;
    }
    // 응답 순서가 요청 순서와 다를 수 있다 — 최신 요청만 반영한다(`trackSelection` 과
    // 같은 패턴).
    const requestId = ++numericRequestRef.current;
    approximateAsync(symbolicLatex).then((latex) => {
      if (numericRequestRef.current === requestId) setNumericLatex(latex);
    });
  }, [numericMode, symbolicLatex]);

  // 결과를 편집하면 이 그룹의 새 셀이 된다 — 확정한 셀이 있으면 그 셀 뒤에, 없으면
  // (상시 표시 중인 단일 셀 그룹) 그 유일한 셀 뒤에.
  const editResultTargetId = groupResultTargetId(objects);
  const groupId = objects[0].groupId;
  const resultFocus = focus !== null && focus.id === groupId && focus.field === 'result' ? focus : null;

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
        const isLast = i === objects.length - 1;
        // focus.id는 'result' 타깃일 땐 groupId를 가리키므로, 우연히 groupId가
        // 이 셀 자신의 id와 같아도(단일 셀 그룹 등) 여기서 섞이지 않게 가른다.
        const cellFocused = focus !== null && focus.id === object.id && focus.field !== 'result';
        return (
          <Cell
            key={object.id}
            object={object}
            result={results.get(object.id) ?? { kind: 'pending' }}
            isGroupTop={i === 0}
            dragging={dragging}
            focusToken={cellFocused ? focus.token : null}
            focusOffset={cellFocused ? (focus.offset ?? null) : null}
            focusSelection={cellFocused ? (focus.selection ?? null) : null}
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
            onMoveOut={(direction) => {
              // 그룹 맨 아래 셀에서 ↓ 를 누르면, 보이는 결과가 있는 한 그 결과
              // 필드로 들어간다 — 화면상 바로 아래에 있는 그 줄이 다음 정지점이다.
              if (isLast && direction === 'downward' && displayShown) {
                // 위아래 이동은 셀 끝에 선다 (`CellStack` 의 `onMoveOut` 과 같은 규약).
                dispatch({
                  type: 'focus',
                  id: groupId,
                  field: 'result',
                  offset: Number.MAX_SAFE_INTEGER,
                });
                return;
              }
              onMoveOut(index, direction);
            }}
            onDeleteEmpty={() => onDeleteEmpty(index)}
            onInsertCell={(position) => dispatch({ type: 'insertCell', id: object.id, position })}
            onMoveGroup={(delta, caret) => onMoveGroup(delta, { id: object.id, offset: caret })}
            onDuplicate={(position, caret) =>
              dispatch({ type: 'duplicateCell', id: object.id, position, cursor: caret })
            }
          />
        );
      })}
      {displayShown && (
        <ResultRow
          result={display}
          numericLatex={numericMode ? numericLatex : null}
          syncKey={syncKey}
          fieldRef={resultRef}
          selection={selection}
          focusToken={resultFocus?.token ?? null}
          focusOffset={resultFocus?.offset ?? null}
          numericMode={numericMode}
          onNumericModeChange={setNumericMode}
          onApply={applyTransform}
          onDetach={detachIfChanged}
          onSelectionChange={trackSelection}
          onTransformShortcut={applyTransform}
          focusSelection={resultFocus?.selection ?? null}
          // 결과 행도 입력 행과 **똑같이** 셀을 조작할 수 있어야 한다. 안 넘기면
          // `MathField` 의 capture 리스너가 키를 `preventDefault` 로 먹어치우고
          // 핸들러가 undefined 라 아무 일도 안 일어난다(= 키가 죽는다).
          onMoveGroup={(delta, caret) =>
            onMoveGroup(delta, { id: groupId, offset: caret, field: 'result' })
          }
          // Shift+Alt+↑/↓ — 결과 행은 그룹 전체를 대표하는 자리라 그룹째 복제한다
          // (입력 행의 셀 하나 복제와 갈린다).
          onDuplicate={(position, caret) =>
            dispatch({ type: 'duplicateGroup', id: objects[0].id, position, cursor: caret })
          }
          // Ctrl+(Shift+)Enter — 그룹 밖 새 빈 셀. `insertCell` 이 `groupAt` 으로
          // 경계를 잡으므로 그룹의 아무 셀 id 나 넘기면 된다.
          onInsertCell={(position) =>
            dispatch({ type: 'insertCell', id: objects[objects.length - 1].id, position })
          }
          onMoveOut={(direction) => {
            const goingUp = direction === 'upward';
            if (goingUp) {
              const last = objects[objects.length - 1];
              dispatch({ type: 'focus', id: last.id, offset: Number.MAX_SAFE_INTEGER });
              return;
            }
            if (direction === 'downward') {
              // 마치 그룹 맨 아래 셀에서 나가는 것처럼 다음 그룹으로 이어간다.
              onMoveOut(startIndex + objects.length - 1, direction);
            }
          }}
        />
      )}
    </div>
  );
}

function ResultRow({
  result,
  numericLatex,
  numericMode,
  onNumericModeChange,
  syncKey,
  fieldRef,
  selection,
  focusToken,
  focusOffset,
  onApply,
  onDetach,
  onSelectionChange,
  onTransformShortcut,
  focusSelection,
  onMoveGroup,
  onDuplicate,
  onInsertCell,
  onMoveOut,
}: {
  result: Extract<EvalResult, { kind: 'error' | 'boolean' | 'ok' }>;
  /** numeric 모드에서 대신 보여줄 LaTeX. 아직 안 왔거나 symbolic 모드면 `null`. */
  numericLatex: string | null;
  numericMode: boolean;
  onNumericModeChange: (numeric: boolean) => void;
  syncKey: number;
  fieldRef: React.Ref<MathFieldHandle>;
  selection: SelectionInfo | null;
  focusToken: number | null;
  focusOffset: number | null;
  focusSelection: readonly [number, number] | null;
  onApply: (op: SelectionOp) => void;
  onDetach: (latex: string, caret?: number) => void;
  onSelectionChange: (selectedLatex: string | null) => void;
  onTransformShortcut: (op: SelectionOp) => void;
  onMoveGroup: (delta: -1 | 1, caret: number) => void;
  onDuplicate: (position: 'above' | 'below', caret: number) => void;
  onInsertCell: (position: 'above' | 'below') => void;
  onMoveOut: (direction: 'forward' | 'backward' | 'upward' | 'downward') => void;
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
  // 수치 결과가 아직 안 왔으면 정확값을 그대로 보여준다 — 토글 순간의 깜빡임 방지.
  const shownLatex = numericLatex ?? result.latex;
  return (
    <div className={result.definitionName !== null ? 'result result-def' : 'result'}>
      {/* `=` 는 정확값, `≈` 는 근삿값 — 화살표 자체가 지금 모드를 말한다. */}
      <span className="result-arrow">{numericMode ? '≈' : '='}</span>
      {/* 결과도 입력 행과 같이 셀 안에 가둔다 — 긴 결과가 카드 밖으로 삐져나오면
          안 된다. 넘치면 가려진 쪽에 말줄임표가 뜬다(`FieldClip`). */}
      <FieldClip watch={shownLatex}>
        <MathField
          ref={fieldRef}
          value={shownLatex}
          syncKey={syncKey}
          focusToken={focusToken}
          focusOffset={focusOffset}
          focusSelection={focusSelection}
          onEdit={onDetach}
          onEnter={(latex) => onDetach(latex)}
          onSelectionChange={onSelectionChange}
          onTransformShortcut={onTransformShortcut}
          onMoveGroup={onMoveGroup}
          onDuplicate={onDuplicate}
          onInsertCell={onInsertCell}
          onMoveOut={onMoveOut}
        />
      </FieldClip>
      <div className="result-actions">
        {selection !== null && <TransformButtons selection={selection} onApply={onApply} />}
        <ResultModeToggle numeric={numericMode} onChange={onNumericModeChange} />
      </div>
    </div>
  );
}

/**
 * 결과 표시 모드 스위치 — 정확값(symbolic) ↔ 근삿값(numeric).
 *
 * 이 앱의 결과는 일관되게 **정확값**이다(CE의 `.evaluate()` 가 정확값을 보존한다) —
 * `\frac{1}{3}`·`\sqrt{2}`·`\ln\left(2\right)` 는 그대로 남는다. 숫자가 보고 싶은
 * 순간에만 이 스위치로 `.N()` 을 얹는다(`algebra/transform/approximate.ts`).
 * **문서는 어느 쪽에서도 안 바뀐다** — 보기일 뿐이다.
 *
 * `mousedown` 에서 `preventDefault` 하는 이유는 `TransformButtons` 와 같다: 결과
 * 필드의 포커스·선택을 뺏지 않아야 토글 뒤에도 하던 조작을 이어갈 수 있다.
 */
function ResultModeToggle({
  numeric,
  onChange,
}: {
  numeric: boolean;
  onChange: (numeric: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={numeric}
      aria-label="Numeric result"
      className={numeric ? 'result-mode result-mode-numeric' : 'result-mode'}
      title={
        numeric
          ? 'Showing an approximation — switch to the exact value'
          : 'Showing the exact value — switch to an approximation'
      }
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onChange(!numeric)}
    >
      {/* 손잡이가 미끄러지고 지금 고른 쪽 이름이 그 옆에 뜬다. 이름은 늘 하나만
          보인다 — 두 낱말을 다 띄우면 어느 쪽이 켜진 건지 오히려 헷갈린다. */}
      <span className="result-mode-knob" />
      <span className="result-mode-label">{numeric ? 'decimal' : 'formula'}</span> {/* name changed */}
    </button>
  );
}
