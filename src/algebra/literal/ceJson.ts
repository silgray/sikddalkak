import type { MathJsonExpression } from '@cortex-js/compute-engine';
import { intLit, isReal, isZero, makeRational, type Literal } from './literal';

/**
 * 리터럴 ↔ CE MathJSON 코덱.
 *
 * **CE 인스턴스가 필요 없다** — 순수 번역이다. CE에 실제로 뭘 시키는 건 `arith.ts` 이고,
 * 여기는 그 앞뒤로 형식만 바꿔준다. 리터럴이 CE 경계를 건널 때 쓰는 유일한 문(門)이라
 * 정규형 판정이 전부 여기 모여 있다.
 *
 * 행렬도 CE MathJSON 을 직접 조립하지만(`transform/matrixFold.ts`) 그건 행렬 쪽 코덱이다 —
 * 각 도메인이 자기 타입의 코덱을 갖는다.
 */

/**
 * CE MathJSON → 리터럴. **리터럴이 생기는 유일한 문(門)이다.**
 *
 * 리터럴이 아닌 것(심볼, 연산 머리)은 `null` — 호출자가 다른 경로로 처리한다.
 * `"ComplexInfinity"`/`"NaN"` 도 `null` 이다. 이걸 안 막으면 `sym` 으로 새어나가
 * "ComplexInfinity 라는 변수" 가 되는데, 그게 지금 있는 조용한 버그다.
 */
export function fromCeJson(json: unknown): Literal | null {
  if (typeof json === 'number') {
    if (!Number.isFinite(json)) return null;
    return Number.isInteger(json) ? intLit(json) : decimalOf(json);
  }
  // `{num: "..."}` — 큰 수·고정밀 소수. 왕복이 안 되면 정직하게 거절한다.
  if (typeof json === 'object' && json !== null && 'num' in json) {
    const text = String((json as { num: unknown }).num);
    const value = Number(text);
    if (!Number.isFinite(value)) return null;
    if (Number.isInteger(value)) {
      return Number.isSafeInteger(value) && String(value) === text.replace(/^\+/, '')
        ? intLit(value)
        : null;
    }
    return { kind: 'decimal', value, text: text.replace(/^\+/, '') };
  }
  // 허수 단위. CE는 `\imaginaryI` 를 이 심볼로, 맨 `i` 는 `["Complex",0,1]` 로 준다(실측).
  if (json === 'ImaginaryUnit') return { kind: 'complex', re: intLit(0), im: intLit(1) };
  if (typeof json === 'string') return null; // 그 밖의 심볼
  if (!Array.isArray(json)) return null;

  const [head, ...args] = json as [unknown, ...unknown[]];
  if (head === 'Rational' && args.length === 2) {
    const n = fromCeJson(args[0]);
    const d = fromCeJson(args[1]);
    if (n?.kind !== 'int' || d?.kind !== 'int') return null;
    return makeRational(n.value, d.value);
  }
  // ⚠ 실수부·허수부가 **그 자체로 `Rational` 일 수 있다**(실측:
  // `Multiply(i, 1/2)` → `Complex(0, Rational(1,2))`). 그래서 재귀로 받는다.
  if (head === 'Complex' && args.length === 2) {
    const re = fromCeJson(args[0]);
    const im = fromCeJson(args[1]);
    if (re === null || im === null || !isReal(re) || !isReal(im)) return null;
    // 허수부가 0이면 실수다 (CE도 그렇게 무너뜨린다 — 정규형을 맞춘다).
    return isZero(im) ? re : { kind: 'complex', re, im };
  }
  return null;
}

function decimalOf(value: number): Literal {
  return { kind: 'decimal', value, text: String(value) };
}

/** 리터럴 → CE MathJSON. */
export function toCeJson(l: Literal): MathJsonExpression {
  switch (l.kind) {
    case 'int':
      return l.value;
    case 'rational':
      return ['Rational', l.n, l.d] as unknown as MathJsonExpression;
    case 'decimal':
      return l.value;
    case 'complex':
      return ['Complex', toCeJson(l.re), toCeJson(l.im)] as unknown as MathJsonExpression;
  }
}
