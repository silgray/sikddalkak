import { useEffect, useRef } from 'react';
import { MathfieldElement } from 'mathlive';

type Props = {
  value: string;
  readOnly?: boolean;
  /**
   * draft를 확정하려 할 때. 타이핑이 멈춰 디바운스가 만료되거나 blur될 때 불린다.
   * 제자리에 머무는 확정이다.
   */
  onFlush?: (latex: string) => void;
  /** Enter를 눌렀을 때. 확정하고 다음으로 넘어가는 신호다. */
  onEnter?: (latex: string) => void;
  onFocus?: () => void;
  /**
   * 값이 바뀔 때마다가 아니라, 이 토큰이 바뀔 때만 포커스를 준다.
   * 리렌더마다 focus()가 불려 커서가 튀는 것을 막기 위한 장치.
   */
  focusToken?: number | null;
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
  onFlush,
  onEnter,
  onFocus,
  focusToken,
  debounceMs = 300,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mfRef = useRef<MathfieldElement | null>(null);

  // 핸들러는 ref로 들고 있어야 prop이 바뀌어도 엘리먼트를 다시 만들지 않는다.
  const handlers = useRef({ onFlush, onEnter, onFocus });
  handlers.current = { onFlush, onEnter, onFocus };
  const initialValue = useRef(value);
  const debounce = useRef(debounceMs);
  debounce.current = debounceMs;

  // 편집 중인지 추적한다. 편집 중에는 외부 value 동기화가 draft를 덮지 않도록 막는다.
  const isEditing = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const mf = new MathfieldElement();
    mf.value = initialValue.current;
    // 데스크톱에서 가상 키보드가 멋대로 뜨지 않게.
    mf.mathVirtualKeyboardPolicy = 'manual';

    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const flush = () => {
      clear();
      handlers.current.onFlush?.(mf.value);
    };

    mf.addEventListener('input', () => {
      // 타이핑이 멈추면 flush. 매 입력마다 타이머를 다시 건다.
      clear();
      timer = setTimeout(flush, debounce.current);
    });
    mf.addEventListener('focusin', () => {
      isEditing.current = true;
      handlers.current.onFocus?.();
    });
    mf.addEventListener('focusout', () => {
      // 편집을 떠나면 대기 중인 디바운스를 기다리지 않고 즉시 확정한다.
      isEditing.current = false;
      flush();
    });
    mf.addEventListener('keydown', (ev) => {
      // MathLive의 'change'는 blur 시에도 발사되므로 Enter만 직접 잡는다.
      if (ev.key === 'Enter') {
        ev.preventDefault();
        clear();
        handlers.current.onEnter?.(mf.value);
      }
    });

    host.append(mf);
    mfRef.current = mf;
    return () => {
      clear();
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
    }
  }, [value]);

  useEffect(() => {
    if (focusToken !== null && focusToken !== undefined) mfRef.current?.focus();
  }, [focusToken]);

  return <div ref={hostRef} className={readOnly ? 'mf mf-readonly' : 'mf'} />;
}
