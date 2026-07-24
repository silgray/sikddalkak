import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from 'react';
import { MathfieldElement } from 'mathlive';
import { flushShortcutBuffer, patchMathliveDisposedBlur } from '../editor/internals';
import { contentCount, findViolations, repairLatex } from '../editor/wellformed';
import { dispatchKeyOp } from '../editor/keyOps';
import {
  expandSelectionSemantic,
  extendSelectionSibling,
  normalizeSelection,
  selectionIsSiblingRun,
} from '../editor/selection';

/** 변환 단축키 (임시 키바인딩 — 추후 사용자 지정 예정). Ctrl/Cmd+Shift+키. */
export const TRANSFORM_SHORTCUTS: Record<string, 'expand' | 'simplify' | 'factor'> = {
  e: 'expand',
  s: 'simplify',
  f: 'factor',
};

/**
 * ☰ 메뉴에서 쓰지 않는 항목을 걷어낸다.
 * - mode(수식/text/LaTeX)·variant(글꼴)·color·background-color: 안 씀
 * - 행렬 구분 기호 서브메뉴(environment-*): 선택 위 플로팅 툴바로 이전
 * 항목 id는 실측 덤프 기준 (mathlive 0.110). 남는 연속 구분선도 정리한다.
 */
function pruneMenu(mf: MathfieldElement): void {
  try {
    const REMOVE = new Set(['mode', 'variant', 'color', 'background-color']);
    type Item = { id?: string; type?: string; submenu?: Item[] };
    const items = (mf.menuItems as Item[]).filter((item) => {
      if (item.id !== undefined && REMOVE.has(item.id)) return false;
      // 구분 기호 서브메뉴는 부모에 id가 없다 — 자식 id로 식별한다.
      if (item.submenu?.some((s) => s.id?.startsWith('environment-'))) return false;
      return true;
    });
    // 제거로 생긴 연속 구분선(divider)을 하나로.
    const cleaned: Item[] = [];
    for (const item of items) {
      const isDivider = item.id === undefined && item.submenu === undefined;
      const prev = cleaned[cleaned.length - 1];
      const prevDivider = prev !== undefined && prev.id === undefined && prev.submenu === undefined;
      if (isDivider && (cleaned.length === 0 || prevDivider)) continue;
      cleaned.push(item);
    }
    mf.menuItems = cleaned as typeof mf.menuItems;
  } catch {
    // 메뉴 구조가 바뀌면(버전 업) 기본 메뉴 그대로 둔다.
  }
}

/** 부모가 명시적으로 조작할 때 쓰는 핸들 (선택 변환 등). */
export type MathFieldHandle = {
  /**
   * 현재 선택을 주어진 LaTeX으로 치환하고 필드의 새 전체 값과 캐럿, 그리고
   * 치환 **직전**의 선택 범위를 돌려준다 (undo가 선택까지 복구할 수 있게).
   * 선택이 없으면 아무것도 하지 않고 null. 치환 중에는 onEdit 보고를 억제하므로
   * 커밋은 호출자가 직접 dispatch해야 한다 (structural 편집으로 즉시 평가되게).
   */
  replaceSelection: (
    latex: string,
  ) => { value: string; caret: number; selectionBefore: readonly [number, number] } | null;
};

type Props = {
  value: string;
  readOnly?: boolean;
  ref?: Ref<MathFieldHandle>;
  /**
   * 사용자 입력 1회마다. latex = 전체 값, caret = 입력 직후 캐럿 오프셋.
   * 문서는 키 입력마다 갱신되고 실행취소도 이 단위로 쌓인다.
   * (평가는 상위 계층이 디바운스한다 — 여기서는 지연 없음)
   */
  onEdit?: (latex: string, caret: number) => void;
  /** Enter를 눌렀을 때. 확정하고 다음으로 넘어가는 신호다. */
  onEnter?: (latex: string) => void;
  onFocus?: () => void;
  /**
   * 선택 영역이 바뀔 때. 선택이 없으면(collapsed) null, 있으면 선택된 LaTeX.
   * 선택 변환 버튼의 표시 여부 판단에 쓴다.
   */
  onSelectionChange?: (selectedLatex: string | null) => void;
  /**
   * 캐럿이 경계에서 더 갈 곳이 없을 때 (MathLive `move-out`).
   * 셀 스택이 인접 셀로 포커스를 넘기는 데 쓴다.
   */
  onMoveOut?: (direction: 'forward' | 'backward' | 'upward' | 'downward') => void;
  /** 변환 단축키 (Ctrl+Shift+E/S/F). 선택이 있을 때 Cell의 applyTransform으로. */
  onTransformShortcut?: (op: 'expand' | 'simplify' | 'factor') => void;
  /** 빈 필드에서 backspace — 셀 삭제/위 셀 이동은 CellStack이 조율. */
  onDeleteEmpty?: () => void;
  /**
   * 값이 바뀔 때마다가 아니라, 이 토큰이 바뀔 때만 포커스를 준다.
   * 리렌더마다 focus()가 불려 커서가 튀는 것을 막기 위한 장치.
   */
  focusToken?: number | null;
  /**
   * focusToken 발화 시 캐럿을 놓을 오프셋. 실행취소가 "그 편집이 일어났던
   * 자리"로 캐럿을 되돌릴 때 쓴다. 없으면 MathLive 기본 동작.
   */
  focusOffset?: number | null;
  /**
   * focusToken 발화 시 복구할 선택 범위. 있으면 focusOffset보다 우선한다 —
   * 선택 변환의 실행취소가 "조작 직전의 선택"을 되살릴 때 쓴다.
   */
  focusSelection?: readonly [number, number] | null;
  /**
   * 이 값이 바뀌면 편집 중(focused)이어도 `value`를 강제로 반영한다.
   * 실행취소/다시실행이 포커스된 필드의 내용을 되돌리기 위한 유일한 경로.
   */
  syncKey?: number;
};

/**
 * `<math-field>` 웹 컴포넌트 React 래퍼.
 *
 * JSX가 아니라 `new MathfieldElement()` 로 직접 만들어 붙인다. 그래야
 *   1. custom element JSX 타입 선언(React 버전마다 다름)이 필요 없고
 *   2. React가 이 엘리먼트를 리렌더로 건드릴 수 없어서
 *      "uncontrolled로 다룬다"는 규칙이 구조적으로 보장된다.
 *
 * 데이터 흐름: 키 입력마다 onEdit으로 문서가 즉시 갱신된다(실행취소 단위).
 * 반대 방향(state -> mathfield)은 사용자가 방금 친 값과 같아 no-op이고,
 * 실행취소/로드 같은 외부 변경만 syncKey/value 이펙트로 흘러든다.
 */
export function MathField({
  value,
  readOnly = false,
  ref,
  onEdit,
  onEnter,
  onFocus,
  onSelectionChange,
  onMoveOut,
  onTransformShortcut,
  onDeleteEmpty,
  focusToken,
  focusOffset,
  focusSelection,
  syncKey,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mfRef = useRef<MathfieldElement | null>(null);

  // 핸들러는 ref로 들고 있어야 prop이 바뀌어도 엘리먼트를 다시 만들지 않는다.
  const handlers = useRef({
    onEdit,
    onEnter,
    onFocus,
    onSelectionChange,
    onMoveOut,
    onTransformShortcut,
    onDeleteEmpty,
  });
  handlers.current = {
    onEdit,
    onEnter,
    onFocus,
    onSelectionChange,
    onMoveOut,
    onTransformShortcut,
    onDeleteEmpty,
  };
  const initialValue = useRef(value);

  // 편집 중인지 추적한다. 편집 중에는 외부 value 동기화가 입력을 덮지 않도록 막는다.
  const isEditing = useRef(false);
  /** replaceSelection 중 input 이벤트 보고를 억제한다 (커밋은 호출자가 한다). */
  const suppressReport = useRef(false);
  /** 현재 선택을 부모에 보고하는 함수. 마운트 이펙트가 채우고 핸들이 재사용한다. */
  const reportRef = useRef<(() => void) | undefined>(undefined);

  // useLayoutEffect여야 한다: layout cleanup은 React가 DOM 노드를 떼기 **전에**
  // 동기 실행된다. 포커스된 mathfield가 blur 없이 DOM에서 떨어지면 MathLive의
  // 전역 포커스 추적(_globallyFocusedMathfield)에 dispose된 필드가 남고, 다음
  // 필드가 포커스될 때 그 낡은 참조의 onBlur를 불러 크래시한다 (mathlivePatch.ts).
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const mf = new MathfieldElement();
    mf.value = initialValue.current;
    // 데스크톱에서 가상 키보드가 멋대로 뜨지 않게.
    mf.mathVirtualKeyboardPolicy = 'manual';

    mf.addEventListener('input', () => {
      if (suppressReport.current) return;
      // 구조 불변식의 단일 게이트 (rules.ts). 파손된 형태가 문서·화면에 한 키
      // 입력 이상 살아남지 못하게, 교정본을 캐럿 보존으로 되써넣고 문서에도
      // 교정본만 보고한다 — 그래서 undo는 언제나 "직전 정상 상태"로 간다.
      const fix = repairLatex(mf.value);
      if (fix.changed) {
        // 캐럿은 "같은 내용 위치"로 되돌린다. MathLive 오프셋은 원자 인덱스라
        // 문자열 splice와 직접 대응하지 않으므로, 캐럿 앞의 내용 토큰 수를
        // 기준으로 다시 찾는다 (구조 토큰이 사라져도 안정적).
        const before = contentCount(mf.getValue({ ranges: [[0, mf.position]] }, 'latex'));
        suppressReport.current = true;
        try {
          mf.setValue(fix.latex, { silenceNotifications: true });
        } finally {
          suppressReport.current = false;
        }
        let target = mf.lastOffset;
        for (let q = 0; q <= mf.lastOffset; q += 1) {
          if (contentCount(mf.getValue({ ranges: [[0, q]] }, 'latex')) >= before) {
            target = q;
            break;
          }
        }
        mf.position = target;
        flushShortcutBuffer(mf);
      }
      if (import.meta.env.DEV) {
        const left = findViolations(mf.value);
        if (left.length > 0) {
          console.warn('[wellformed] 교정 후에도 위반', left.map((v) => v.ruleId), mf.value);
        }
      }
      handlers.current.onEdit?.(mf.value, mf.position);
    });

    // 선택 불변식의 단일 게이트. 모든 선택 경로(드래그·shift+화살표·Ctrl+D·
    // 더블클릭·Ctrl+A·실행취소 복구)가 selection-change를 지나가므로, 여기서
    // 한 번 교정하면 "선택은 항상 한 레벨의 연속 형제 열"이 보장된다.
    // (핸들러 안에서 selection을 재설정해도 재귀 발화하지 않는다 — 실측)
    const reportSelection = () => {
      normalizeSelection(mf);
      const notify = handlers.current.onSelectionChange;
      if (notify === undefined) return;
      if (mf.selectionIsCollapsed) {
        notify(null);
        return;
      }
      // 정규화 뒤에도 형제 열이 아니면 불변식이 깨진 것 — 조작 대상에서 뺀다.
      if (!selectionIsSiblingRun(mf)) {
        if (import.meta.env.DEV) {
          console.warn('[selection] 정규화 후에도 형제 열이 아님', mf.selection.ranges);
        }
        notify(null);
        return;
      }
      notify(mf.getValue(mf.selection, 'latex'));
    };
    reportRef.current = reportSelection;

    mf.addEventListener('focusin', () => {
      isEditing.current = true;
      handlers.current.onFocus?.();
      // selection-change는 "변화"에만 발화한다. 이미 선택이 있는 필드에 포커스가
      // 들어오면 이벤트 없이 선택만 존재해 버튼 상태가 어긋난다 — 즉시 보고해 동기화.
      reportSelection();
    });
    mf.addEventListener('focusout', () => {
      isEditing.current = false;
      // 주의: 여기서 onSelectionChange(null)를 부르지 않는다. blur돼도 모델의
      // 선택은 살아 있고(변환 적용 가능), 창 포커스 전환(alt-tab)만으로 선택
      // 조작 버튼이 사라지면 안 된다. 선택 해제는 selection-change가 알린다.
    });
    mf.addEventListener('selection-change', reportSelection);
    // 캐럿이 경계를 넘으려 할 때 — 셀 간 이동의 신호.
    mf.addEventListener('move-out', (ev) => {
      const direction = (ev as CustomEvent<{ direction: string }>).detail?.direction;
      if (
        direction === 'forward' ||
        direction === 'backward' ||
        direction === 'upward' ||
        direction === 'downward'
      ) {
        handlers.current.onMoveOut?.(direction);
      }
    });
    mf.addEventListener('keydown', (ev) => {
      // MathLive의 'change'는 blur 시에도 발사되므로 Enter만 직접 잡는다.
      if (ev.key === 'Enter') {
        ev.preventDefault();
        handlers.current.onEnter?.(mf.value);
      }
    });

    // 선택 조작 단축키. capture 단계여야 MathLive 기본 처리보다 먼저 가로챈다.
    mf.addEventListener(
      'keydown',
      (ev) => {
        if (mf.readOnly) return;
        // Ctrl/Cmd+Shift+E/S/F: 선택 변환 단축키 (임시 키바인딩).
        if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && !ev.altKey) {
          const op = TRANSFORM_SHORTCUTS[ev.key.toLowerCase()];
          if (op !== undefined) {
            ev.preventDefault();
            ev.stopImmediatePropagation();
            handlers.current.onTransformShortcut?.(op);
            return;
          }
        }
        // 빈 필드에서 backspace: 셀 삭제 + 위 셀 이동 신호.
        if (ev.key === 'Backspace' && mf.value.trim() === '' && mf.selectionIsCollapsed) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          handlers.current.onDeleteEmpty?.();
          return;
        }
        // Ctrl/Cmd+D: 의미 단위 선택 확장 (브라우저 북마크를 가로챈다).
        if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'd') {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          try {
            expandSelectionSemantic(mf);
          } catch {
            // 내부 API 실패 — 아무것도 안 한다 (기본 동작도 없음).
          }
          return;
        }
        // shift+←/→: 같은 레벨(형제) 단위 선택 확장.
        if (
          ev.shiftKey &&
          !ev.ctrlKey &&
          !ev.metaKey &&
          !ev.altKey &&
          (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')
        ) {
          try {
            if (extendSelectionSibling(mf, ev.key === 'ArrowLeft' ? 'left' : 'right')) {
              ev.preventDefault();
              ev.stopImmediatePropagation();
            }
          } catch {
            // 내부 API 실패 — MathLive 기본 확장으로 폴백.
          }
        }
      },
      { capture: true },
    );

    // 구조 보존 편집 연산 (keyOps.ts 레지스트리). 괄호 쌍 생성/제거, 밑 없는
    // 첨자 차단, 첨자 내용 강등 등 — "파손을 애초에 만들지 않는" 층이다.
    // capture 단계여야 MathLive의 자체 처리보다 먼저 가로챌 수 있다.
    mf.addEventListener(
      'keydown',
      (ev) => {
        if (mf.readOnly) return;
        if (ev.ctrlKey || ev.metaKey || ev.altKey) return; // 단축키는 위 리스너 담당
        if (dispatchKeyOp(mf, ev.key)) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          // 연산이 문서를 바꿨으면 insert가 input 이벤트를 발사해
          // onEdit으로 문서·실행취소가 한 단위로 갱신된다.
        }
      },
      { capture: true },
    );

    host.append(mf);
    // ☰ 메뉴에서 안 쓰는 항목 제거 (append 후여야 기본 메뉴가 구성돼 있다).
    pruneMenu(mf);
    // 포커스된 필드가 언마운트될 때의 MathLive 크래시 우회 (editor/internals.ts 참고).
    // 내부 프로토타입에 접근해야 해서 살아있는 인스턴스가 필요하다. 최초 1회만 적용됨.
    patchMathliveDisposedBlur(mf);
    mfRef.current = mf;
    return () => {
      mf.remove();
      mfRef.current = null;
    };
  }, []);

  // readOnly는 보통 컴포넌트 수명 내내 고정이지만 안전하게 동기화한다.
  useEffect(() => {
    if (mfRef.current !== null) mfRef.current.readOnly = readOnly;
  }, [readOnly]);

  // 외부에서 값이 바뀐 경우에만 반영한다 (결과 셀 갱신, 로드 등).
  // 편집 중에는 건드리지 않는다 — 키 입력마다 문서가 갱신되므로 평상시에는
  // 두 값이 같아 no-op이지만, 다른 셀의 재평가가 끼어드는 타이밍을 방어한다.
  useEffect(() => {
    const mf = mfRef.current;
    if (mf !== null && !isEditing.current && mf.value !== value) {
      mf.setValue(value, { silenceNotifications: true });
      flushShortcutBuffer(mf);
    }
  }, [value]);

  // 강제 반영: 편집 중이어도 value를 밀어넣는다. 실행취소/다시실행 전용.
  // value가 아니라 syncKey에만 의존하므로 평상시 타이핑에는 절대 끼어들지 않는다.
  const firstSync = useRef(true);
  useEffect(() => {
    if (firstSync.current) {
      firstSync.current = false;
      return; // 마운트 시점의 값은 이미 반영돼 있다.
    }
    const mf = mfRef.current;
    if (mf !== null && mf.value !== value) {
      mf.setValue(value, { silenceNotifications: true });
      // 실행취소로 내용이 바뀌었다 — 숏컷 버퍼에 남은 옛 타이핑을 반드시 비운다.
      flushShortcutBuffer(mf);
    }
  }, [syncKey]);

  // 포커스 지시. focusSelection이 있으면 선택 복구, 아니면 focusOffset으로 캐럿.
  // syncKey 이펙트가 먼저 선언돼 있어 값 반영 → 포커스/캐럿 순서가 보장된다.
  useEffect(() => {
    if (focusToken === null || focusToken === undefined) return;
    const mf = mfRef.current;
    if (mf === null) return;
    mf.focus();
    // focus()가 선택/캐럿을 임의로 옮길 수 있으므로 그 뒤에 명시적으로 놓는다.
    if (focusSelection !== null && focusSelection !== undefined) {
      const clamp = (v: number) => Math.max(0, Math.min(v, mf.lastOffset));
      mf.selection = {
        ranges: [[clamp(focusSelection[0]), clamp(focusSelection[1])]],
        direction: 'forward',
      };
    } else if (focusOffset !== null && focusOffset !== undefined) {
      mf.position = Math.max(0, Math.min(focusOffset, mf.lastOffset));
    }
  }, [focusToken]);

  useImperativeHandle(
    ref,
    () => ({
      replaceSelection(latex: string) {
        const mf = mfRef.current;
        if (mf === null || mf.selectionIsCollapsed) return null;
        const [from, to] = mf.selection.ranges[0];
        suppressReport.current = true;
        try {
          mf.insert(latex, { insertionMode: 'replaceSelection', selectionMode: 'item' });
        } finally {
          suppressReport.current = false;
        }
        // 삽입물이 새로 선택된 상태다(selectionMode:'item'). 그 선택을 재보고해
        // 버튼 상태를 갱신한다 — expand ↔ factor 왕복이 자연스럽게 된다.
        reportRef.current?.();
        return { value: mf.value, caret: mf.position, selectionBefore: [from, to] as const };
      },
    }),
    [],
  );

  return <div ref={hostRef} className={readOnly ? 'mf mf-readonly' : 'mf'} />;
}
