import { ComputeEngine } from '@cortex-js/compute-engine';
import type { MathJsonExpression } from '@cortex-js/compute-engine';
import { intLit, makeRational, type Literal, type RealLiteral } from './literal';
import { fromCeJson, toCeJson } from './ceJson';

/**
 * 리터럴 산술 — **CE 위임**.
 *
 * 정확한 유리수·십진·복소 산술을 다시 만들 이유가 없다. CE가 이미 갖고 있고,
 * 기약분수화·부호 정규화·`분모 1 → 정수`·`허수부 0 → 실수` 까지 전부 해준다(실측).
 * 그래서 `Literal` 의 정규형 불변식은 **여기를 통과하는 것만으로** 보장된다.
 *
 * ⚠ **CE에는 JSON만 넘긴다. `ce.box("문자열")` 절대 금지** — `ExpressionInput` 이
 * `string` 을 포함하고 `LatexString` 도 `string` 이라 CE가 구분을 못 해서, 맨 문자열은
 * **LaTeX으로 재렉싱된다**. `simplify("Pi")` 가 `P·i` 가 되고 `"ab"` 가 `a·b` 로
 * 쪼개진다(실측). `ce.box(json)` 을 먼저 태우면 완전히 무장 해제된다.
 *
 * 실패는 **`null`** 이다 (`viaCe`/`invertLiteral` 과 같은 방어 관례). 호출자는 접지 말고
 * 원래 트리를 그대로 유지해야 한다 — "안 접힘" 이 "틀린 답" 보다 낫다.
 *
 * 이 파일 전용 CE 인스턴스를 두는 것도 기존 관례다 (`render.ts`, `parseSymbol.ts`,
 * `matrixFold.ts` 가 각자 갖고 있다 — 버전 격리 규칙).
 */

const ce = new ComputeEngine();

/** CE에 이항 연산을 맡긴다. 우리가 못 읽는 결과가 오면 `null`. */
function viaCe(head: string, a: Literal, b: Literal): Literal | null {
  try {
    const json = [head, toCeJson(a), toCeJson(b)] as unknown as MathJsonExpression;
    return fromCeJson(ce.box(json).evaluate().json);
  } catch {
    return null;
  }
}

/** 정수/유리수만 담긴 쌍인가 — JS 빠른 경로를 탈 수 있는지. */
function ratParts(l: Literal): { n: number; d: number } | null {
  if (l.kind === 'int') return { n: l.value, d: 1 };
  if (l.kind === 'rational') return { n: l.n, d: l.d };
  return null;
}

/**
 * 정수·유리수 구간의 빠른 경로.
 *
 * CE 왕복이 ≈16µs 인데 `normalize` 는 곱마다 이걸 부른다 — 퍼즈를 넓게 돌리면
 * (`ALGEBRA_FUZZ_SAMPLES=10000`) 왕복 비용이 타임아웃에 닿는다. 이 구간에서 CE의
 * 정규형(기약·분모 양수·분모 1이면 정수)은 gcd로 결정적이라 **답이 정확히 같다.**
 * 중간값이 안전 정수를 벗어나면 포기하고 CE로 넘긴다.
 */
function fastRat(
  a: Literal,
  b: Literal,
  combine: (an: number, ad: number, bn: number, bd: number) => [number, number],
): Literal | null {
  const x = ratParts(a);
  const y = ratParts(b);
  if (x === null || y === null) return null;
  const [n, d] = combine(x.n, x.d, y.n, y.d);
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d)) return null;
  return makeRational(n, d);
}

export function addLit(a: Literal, b: Literal): Literal | null {
  return fastRat(a, b, (an, ad, bn, bd) => [an * bd + bn * ad, ad * bd]) ?? viaCe('Add', a, b);
}

export function mulLit(a: Literal, b: Literal): Literal | null {
  return fastRat(a, b, (an, ad, bn, bd) => [an * bn, ad * bd]) ?? viaCe('Multiply', a, b);
}

/** 부호 뒤집기 — 실패가 없다 (정규형을 깨지 않는 유일한 연산). */
export function negLit(l: Literal): Literal {
  switch (l.kind) {
    case 'int':
      return intLit(-l.value);
    case 'rational':
      return { kind: 'rational', n: -l.n, d: l.d };
    case 'decimal':
      return { kind: 'decimal', value: -l.value, text: String(-l.value) };
    case 'complex':
      return { kind: 'complex', re: negLit(l.re) as RealLiteral, im: negLit(l.im) as RealLiteral };
  }
}

/**
 * 정수로 나눈다. `factor` 가 공통 정수 계수를 뽑아낼 때 쓴다 (`m.numeric / numeric`).
 * 나눗셈이 안 떨어져도 정확한 유리수가 나온다.
 */
export function divideByInt(l: Literal, divisor: number): Literal {
  if (divisor === 0) return l; // 호출자가 0을 주지 않는다 (gcd 결과라 >=1 또는 <=-1).
  const fast = fastRat(l, intLit(divisor), (an, ad, bn, bd) => [an * bd, ad * bn]);
  // 실패해도 계수를 잃으면 안 되므로 CE로 한 번 더 시도하고, 그것도 실패하면 원값.
  return fast ?? viaCe('Divide', l, intLit(divisor)) ?? l;
}

/** 역수. `\frac{2A}{3}` → `\frac{2}{3}A` 하강이 분모의 역수를 만들 때 쓴다. */
export function recipLit(l: Literal): Literal | null {
  const fast = fastRat(intLit(1), l, (an, ad, bn, bd) => [an * bd, ad * bn]);
  return fast ?? viaCe('Divide', intLit(1), l);
}

/** 정수 거듭제곱. `matPow`/`scalarPow` 접기가 쓴다. */
export function powLit(base: Literal, exponent: number): Literal | null {
  if (!Number.isSafeInteger(exponent)) return null;
  return viaCe('Power', base, intLit(exponent));
}
