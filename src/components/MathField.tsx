import { useEffect, useRef } from 'react';
import { MathfieldElement } from 'mathlive';

type Props = {
  value: string;
  readOnly?: boolean;
  /** 매 키 입력마다 */
  onInput?: (latex: string) => void;
  /** Enter(=) 를 눌렀을 때 */
  onCommit?: (latex: string) => void;
  onFocus?: () => void;
  /**
   * 값이 바뀔 때마다가 아니라, 이 토큰이 바뀔 때만 포커스를 준다.
   * 리렌더마다 focus()가 불려 커서가 튀는 것을 막기 위한 장치.
   */
  focusToken?: number | null;
};

/**
 * `<math-field>` 웹 컴포넌트 React 래퍼.
 *
 * JSX가 아니라 `new MathfieldElement()` 로 직접 만들어 붙인다. 그래야
 *   1. custom element JSX 타입 선언(React 버전마다 다름)이 필요 없고
 *   2. React가 이 엘리먼트를 리렌더로 건드릴 수 없어서
 *      "uncontrolled로 다룬다"는 규칙이 구조적으로 보장된다.
 *
 * 데이터 흐름은 `mathfield --input--> React state` 단방향이다.
 * 반대 방향(state -> mathfield)은 아래 value 동기화 이펙트에서
 * 값이 실제로 다를 때만 일어난다 — 사용자가 타이핑한 경우에는
 * 이미 두 값이 같으므로 setValue가 호출되지 않아 캐럿이 튀지 않는다.
 */
export function MathField({ value, readOnly = false, onInput, onCommit, onFocus, focusToken }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mfRef = useRef<MathfieldElement | null>(null);

  // 핸들러는 ref로 들고 있어야 prop이 바뀌어도 엘리먼트를 다시 만들지 않는다.
  const handlers = useRef({ onInput, onCommit, onFocus });
  handlers.current = { onInput, onCommit, onFocus };
  const initialValue = useRef(value);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const mf = new MathfieldElement();
    mf.value = initialValue.current;
    // 데스크톱에서 가상 키보드가 멋대로 뜨지 않게.
    mf.mathVirtualKeyboardPolicy = 'manual';
    mf.addEventListener('input', () => handlers.current.onInput?.(mf.value));
    mf.addEventListener('focusin', () => handlers.current.onFocus?.());
    mf.addEventListener('keydown', (ev) => {
      // MathLive의 'change' 이벤트는 blur 시에도 발사되므로 Enter만 직접 잡는다.
      if (ev.key === 'Enter') {
        ev.preventDefault();
        handlers.current.onCommit?.(mf.value);
      }
    });

    host.append(mf);
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

  // 외부에서 값이 바뀐 경우에만 반영한다 (결과 셀 갱신, undo 등).
  useEffect(() => {
    const mf = mfRef.current;
    if (mf !== null && mf.value !== value) {
      mf.setValue(value, { silenceNotifications: true });
    }
  }, [value]);

  useEffect(() => {
    if (focusToken !== null && focusToken !== undefined) mfRef.current?.focus();
  }, [focusToken]);

  return <div ref={hostRef} className={readOnly ? 'mf mf-readonly' : 'mf'} />;
}
