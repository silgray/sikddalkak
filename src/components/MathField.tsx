import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from 'react';
import { MathfieldElement } from 'mathlive';
import { patchMathliveDisposedBlur } from '../mathlivePatch';

/** 부모가 명시적으로 조작할 때 쓰는 핸들 (선택 변환 등). */
export type MathFieldHandle = {
  /**
   * 현재 선택을 주어진 LaTeX으로 치환하고 필드의 새 전체 값을 돌려준다.
   * 선택이 없으면 아무것도 하지 않고 null. 디바운스/dirty를 소모하므로
   * 커밋은 호출자가 직접 dispatch해야 한다 (변환을 별도 실행취소 단계로 만들기 위함).
   */
  replaceSelection: (latex: string) => string | null;
};

type Props = {
  value: string;
  readOnly?: boolean;
  ref?: Ref<MathFieldHandle>;
  /**
   * draft를 확정하려 할 때. 타이핑이 멈춰 디바운스가 만료되거나 blur될 때 불린다.
   * 제자리에 머무는 확정이다.
   */
  onFlush?: (latex: string) => void;
  /** Enter를 눌렀을 때. 확정하고 다음으로 넘어가는 신호다. */
  onEnter?: (latex: string) => void;
  onFocus?: () => void;
  /**
   * 선택 영역이 바뀔 때. 선택이 없으면(collapsed/blur) null, 있으면 선택된 LaTeX.
   * 선택 변환 버튼의 표시 여부 판단에 쓴다.
   */
  onSelectionChange?: (selectedLatex: string | null) => void;
  /**
   * 값이 바뀔 때마다가 아니라, 이 토큰이 바뀔 때만 포커스를 준다.
   * 리렌더마다 focus()가 불려 커서가 튀는 것을 막기 위한 장치.
   */
  focusToken?: number | null;
  /**
   * 이 값이 바뀌면 편집 중(focused)이어도 `value`를 강제로 반영한다.
   * 실행취소/다시실행이 포커스된 필드의 draft를 되돌리기 위한 유일한 경로.
   */
  syncKey?: number;
  /** 타이핑이 멈춘 뒤 flush까지의 지연(ms). */
  debounceMs?: number;
};

/**
 * `<math-field>` 웹 컴포넌트 React 래퍼.
 *
 * JSX가 아니라 `new MathfieldElement()` 로 직접 만들어 붙인다. 그래야
 *   1. custom element JSX 타입 선언(React 버전마다 다름)이 필요 없고
 *   2. React가 이 엘리먼트를 리렌더로 건드릴 수 없어서
 *      "uncontrolled로 다룬다"는 규칙이 구조적으로 보장된다.
 *
 * 편집 중인 draft는 mathfield DOM 안에만 있다. 키 입력마다 부모에 올리지 않고,
 * 타이핑이 멈추거나(디바운스) blur되거나 Enter를 눌렀을 때만 확정한다.
 * 그래서 타이핑 중간의 미완성 상태(파싱 에러)가 평가되지 않고 에러가 번쩍이지 않는다.
 */
export function MathField({
  value,
  readOnly = false,
  ref,
  onFlush,
  onEnter,
  onFocus,
  onSelectionChange,
  focusToken,
  syncKey,
  debounceMs = 300,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mfRef = useRef<MathfieldElement | null>(null);

  // 핸들러는 ref로 들고 있어야 prop이 바뀌어도 엘리먼트를 다시 만들지 않는다.
  const handlers = useRef({ onFlush, onEnter, onFocus, onSelectionChange });
  handlers.current = { onFlush, onEnter, onFocus, onSelectionChange };
  const initialValue = useRef(value);
  const debounce = useRef(debounceMs);
  debounce.current = debounceMs;

  // 편집 중인지 추적한다. 편집 중에는 외부 value 동기화가 draft를 덮지 않도록 막는다.
  const isEditing = useRef(false);
  /**
   * 마지막 외부 반영 이후 사용자 입력이 있었는지. flush는 dirty일 때만 부모에
   * 알린다 — MathLive가 LaTeX을 재직렬화해 문자열이 달라져도(예: 행렬 줄바꿈)
   * 단순 blur가 "편집"으로 오인되지 않게 하기 위해서다. 결과 행 분리(feature 3)의
   * 오탐 방지에 특히 중요하다.
   */
  const isDirty = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearTimer = () => {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  };

  // useLayoutEffect여야 한다: layout cleanup은 React가 DOM 노드를 떼기 **전에**
  // 동기 실행된다. 포커스된 mathfield가 blur 없이 DOM에서 떨어지면 MathLive의
  // 전역 포커스 추적(_globallyFocusedMathfield)에 dispose된 필드가 남고, 다음
  // 필드가 포커스될 때 그 낡은 참조의 onBlur를 불러 크래시한다. cleanup에서
  // 아직 붙어있는 동안 blur()를 호출해 추적을 정리한다.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const mf = new MathfieldElement();
    mf.value = initialValue.current;
    // 데스크톱에서 가상 키보드가 멋대로 뜨지 않게.
    mf.mathVirtualKeyboardPolicy = 'manual';

    const flush = () => {
      clearTimer();
      if (!isDirty.current) return; // 사용자 입력이 없었다 — 알릴 것도 없다.
      isDirty.current = false;
      handlers.current.onFlush?.(mf.value);
    };

    mf.addEventListener('input', () => {
      // 타이핑이 멈추면 flush. 매 입력마다 타이머를 다시 건다.
      isDirty.current = true;
      clearTimer();
      timerRef.current = setTimeout(flush, debounce.current);
    });
    mf.addEventListener('focusin', () => {
      isEditing.current = true;
      handlers.current.onFocus?.();
    });
    mf.addEventListener('focusout', () => {
      // 편집을 떠나면 대기 중인 디바운스를 기다리지 않고 즉시 확정한다.
      isEditing.current = false;
      flush();
      // 주의: 여기서 onSelectionChange(null)를 부르지 않는다. blur돼도 모델의
      // 선택은 살아 있고(변환 적용 가능), 창 포커스 전환(alt-tab)만으로 선택
      // 조작 버튼이 사라지면 안 된다. 선택 해제는 selection-change가 알린다.
    });
    mf.addEventListener('selection-change', () => {
      const notify = handlers.current.onSelectionChange;
      if (notify === undefined) return;
      notify(mf.selectionIsCollapsed ? null : mf.getValue(mf.selection, 'latex'));
    });
    mf.addEventListener('keydown', (ev) => {
      // MathLive의 'change'는 blur 시에도 발사되므로 Enter만 직접 잡는다.
      if (ev.key === 'Enter') {
        ev.preventDefault();
        clearTimer();
        isDirty.current = false;
        handlers.current.onEnter?.(mf.value);
      }
    });

    host.append(mf);
    // 포커스된 필드가 언마운트될 때의 MathLive 크래시 우회 (mathlivePatch.ts 참고).
    // 내부 프로토타입에 접근해야 해서 살아있는 인스턴스가 필요하다. 최초 1회만 적용됨.
    patchMathliveDisposedBlur(mf);
    mfRef.current = mf;
    return () => {
      clearTimer();
      mf.remove();
      mfRef.current = null;
    };
  }, []);

  // readOnly는 보통 컴포넌트 수명 내내 고정이지만 안전하게 동기화한다.
  useEffect(() => {
    if (mfRef.current !== null) mfRef.current.readOnly = readOnly;
  }, [readOnly]);

  // 외부에서 값이 바뀐 경우에만 반영한다 (결과 셀 갱신, 로드, undo 등).
  // 편집 중에는 건드리지 않는다 — 그러지 않으면 다른 셀의 재평가로 리렌더가
  // 일어날 때 아직 flush되지 않은 draft를 옛 확정값으로 덮어써 버린다.
  useEffect(() => {
    const mf = mfRef.current;
    if (mf !== null && !isEditing.current && mf.value !== value) {
      mf.setValue(value, { silenceNotifications: true });
      isDirty.current = false; // 외부 반영은 편집이 아니다.
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
    // 대기 중인 디바운스 flush를 버린다 — 되돌린 직후 낡은 draft가 커밋되면
    // 실행취소가 즉시 무효화되는 경쟁을 막는다.
    clearTimer();
    isDirty.current = false;
    if (mf !== null && mf.value !== value) {
      mf.setValue(value, { silenceNotifications: true });
    }
  }, [syncKey]);

  useEffect(() => {
    if (focusToken !== null && focusToken !== undefined) mfRef.current?.focus();
  }, [focusToken]);

  useImperativeHandle(
    ref,
    () => ({
      replaceSelection(latex: string): string | null {
        const mf = mfRef.current;
        if (mf === null || mf.selectionIsCollapsed) return null;
        mf.insert(latex, { insertionMode: 'replaceSelection', selectionMode: 'item' });
        // insert가 input 이벤트를 발사해 디바운스가 걸리는데, 이 변경의 커밋은
        // 호출자가 직접 한다 — 별도 실행취소 단계로 만들기 위해서다.
        clearTimer();
        isDirty.current = false;
        return mf.value;
      },
    }),
    [],
  );

  return <div ref={hostRef} className={readOnly ? 'mf mf-readonly' : 'mf'} />;
}
