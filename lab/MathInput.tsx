import { useEffect, useRef } from 'react';
import { MathfieldElement } from 'mathlive';

/**
 * 랩 전용 `<math-field>` 래퍼.
 *
 * 주 앱의 `src/components/MathField.tsx` 와 달리 **구조 교정 게이트를 달지 않는다.**
 * 랩에서 검증하는 건 대수 모듈이지 에디터 레이어가 아니다. 게이트가 끼면 무엇이
 * 대수 모듈의 동작이고 무엇이 에디터의 교정인지 구분되지 않는다.
 */
export function MathInput({
  value,
  onChange,
  readOnly = false,
  placeholder,
}: {
  value: string;
  onChange?: (latex: string) => void;
  readOnly?: boolean;
  placeholder?: string;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const field = useRef<MathfieldElement | null>(null);
  const latest = useRef(onChange);
  latest.current = onChange;

  useEffect(() => {
    const container = host.current;
    if (container === null) return;
    const mf = new MathfieldElement();
    mf.value = value;
    mf.readOnly = readOnly;
    if (placeholder !== undefined) mf.setAttribute('placeholder', placeholder);
    mf.addEventListener('input', () => latest.current?.(mf.value));
    container.appendChild(mf);
    field.current = mf;
    return () => {
      field.current = null;
      mf.remove();
    };
    // 마운트 시 한 번만 만든다 (uncontrolled). 값 반영은 아래 훅이 맡는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 바깥에서 값이 바뀐 경우에만 되쓴다 — 타이핑 중 캐럿이 튀지 않게 같으면 건드리지 않는다.
  useEffect(() => {
    const mf = field.current;
    if (mf !== null && mf.value !== value) mf.value = value;
  }, [value]);

  return <span className="math-input" ref={host} />;
}
