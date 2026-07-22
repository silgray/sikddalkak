import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from 'react';
import { MathfieldElement } from 'mathlive';
import { patchMathliveDisposedBlur } from '../mathlivePatch';

/** run 안에 미결(안 닫힌) 여는 괄호가 몇 개인지. `\left(`/`\right)`도 (,)를 포함해 같이 세어진다. */
function unmatchedOpenParens(latex: string): number {
  let depth = 0;
  for (const ch of latex) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
  }
  return depth;
}

/** 부모가 명시적으로 조작할 때 쓰는 핸들 (선택 변환 등). */
export type MathFieldHandle = {
  /**
   * 현재 선택을 주어진 LaTeX으로 치환하고 필드의 새 전체 값과 캐럿을 돌려준다.
   * 선택이 없으면 아무것도 하지 않고 null. 치환 중에는 onEdit 보고를 억제하므로
   * 커밋은 호출자가 직접 dispatch해야 한다 (structural 편집으로 즉시 평가되게).
   */
  replaceSelection: (latex: string) => { value: string; caret: number } | null;
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
  focusToken,
  focusOffset,
  syncKey,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mfRef = useRef<MathfieldElement | null>(null);

  // 핸들러는 ref로 들고 있어야 prop이 바뀌어도 엘리먼트를 다시 만들지 않는다.
  const handlers = useRef({ onEdit, onEnter, onFocus, onSelectionChange });
  handlers.current = { onEdit, onEnter, onFocus, onSelectionChange };
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
      handlers.current.onEdit?.(mf.value, mf.position);
    });

    const reportSelection = () => {
      const notify = handlers.current.onSelectionChange;
      if (notify === undefined) return;
      notify(mf.selectionIsCollapsed ? null : mf.getValue(mf.selection, 'latex'));
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
    mf.addEventListener('keydown', (ev) => {
      // MathLive의 'change'는 blur 시에도 발사되므로 Enter만 직접 잡는다.
      if (ev.key === 'Enter') {
        ev.preventDefault();
        handlers.current.onEnter?.(mf.value);
      }
    });

    // `)` 왼쪽 감싸기: smartFence의 `(`(오른쪽 같은 레벨 전부 감싸기)의 거울상.
    // 같은 레벨에 미결 `(`가 없을 때 `)`를 치면 캐럿 왼쪽의 같은 레벨 run을
    // \left(...\right)로 감싼다. 미결 `(`가 있으면 기본 동작(닫기)에 맡긴다.
    // capture 단계여야 MathLive의 자체 처리보다 먼저 가로챌 수 있다.
    mf.addEventListener(
      'keydown',
      (ev) => {
        if (ev.key !== ')' || mf.readOnly) return;
        if (!mf.selectionIsCollapsed) return; // 선택이 있으면 기본 동작(치환)에 맡김
        const pos = mf.position;
        // 같은 레벨(현재 그룹)의 시작~캐럿 run을 읽는다. 실측: 미결 스마트펜스는
        // 중첩 그룹을 만들지 않고 같은 레벨에 평평하게 있어 run에 `(`로 나타난다.
        mf.executeCommand('extendToGroupStart');
        const run = mf.getValue(mf.selection, 'latex');
        mf.position = pos; // 분석 후 복원
        if (run.trim() === '' || unmatchedOpenParens(run) > 0) return; // 기본 동작
        ev.preventDefault();
        ev.stopImmediatePropagation();
        mf.executeCommand('extendToGroupStart');
        mf.insert(`\\left(${run}\\right)`, {
          insertionMode: 'replaceSelection',
          selectionMode: 'after',
        });
        // insert가 input 이벤트를 발사해 onEdit으로 문서·실행취소가 갱신된다.
      },
      { capture: true },
    );

    host.append(mf);
    // 포커스된 필드가 언마운트될 때의 MathLive 크래시 우회 (mathlivePatch.ts 참고).
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
    }
  }, [syncKey]);

  // 포커스 지시. focusOffset이 있으면 캐럿까지 그 위치로 (실행취소 복원).
  // syncKey 이펙트가 먼저 선언돼 있어 값 반영 → 포커스/캐럿 순서가 보장된다.
  useEffect(() => {
    if (focusToken === null || focusToken === undefined) return;
    const mf = mfRef.current;
    if (mf === null) return;
    mf.focus();
    if (focusOffset !== null && focusOffset !== undefined) {
      // focus()가 선택/캐럿을 임의로 옮길 수 있으므로 그 뒤에 명시적으로 놓는다.
      mf.position = Math.max(0, Math.min(focusOffset, mf.lastOffset));
    }
  }, [focusToken]);

  useImperativeHandle(
    ref,
    () => ({
      replaceSelection(latex: string): { value: string; caret: number } | null {
        const mf = mfRef.current;
        if (mf === null || mf.selectionIsCollapsed) return null;
        suppressReport.current = true;
        try {
          mf.insert(latex, { insertionMode: 'replaceSelection', selectionMode: 'item' });
        } finally {
          suppressReport.current = false;
        }
        // 삽입물이 새로 선택된 상태다(selectionMode:'item'). 그 선택을 재보고해
        // 버튼 상태를 갱신한다 — expand ↔ factor 왕복이 자연스럽게 된다.
        reportRef.current?.();
        return { value: mf.value, caret: mf.position };
      },
    }),
    [],
  );

  return <div ref={hostRef} className={readOnly ? 'mf mf-readonly' : 'mf'} />;
}
