import { buildFrac, buildMul, buildNum } from '../expression/builders';
import { asLiteral } from '../expression/key';
import { ok, type Result } from '../result/result';
import { SCALAR, isScalar } from '../shape/shape';
import type { TypedExpr } from '../expression/node';
import { asInteger, ONE as ONE_LIT } from '../literal/literal';
import { divideByInt, reciprocalLit } from '../literal/arith';
import { toMonomial } from './product';
import { fromMonomial } from '../polynomial/convert';

/**
 * 분수 정규화.
 *
 * 두 가지를 한다: 정수/정수를 유리수 리터럴로 접고, 분자가 비스칼라면 역수를 곱으로 내린다.
 * 이 파일은 `normalize.ts` 를 import 하지 않는다 — 자식 재귀는 `recur` 로 받는다.
 */

/**
 * 분모의 역수. 숫자면 숫자 리터럴로, 아니면 `\frac{1}{d}` 노드로.
 * 못 만들면 `null` — 호출자가 원래 `frac` 을 그대로 둔다.
 */
function reciprocalOf(denominator: TypedExpr): TypedExpr | null {
  const lit = asLiteral(denominator);
  if (lit !== null) {
    const inv = reciprocalLit(lit);
    return inv === null ? null : buildNum(inv);
  }
  return { op: 'frac', shape: SCALAR, numerator: buildNum(ONE_LIT), denominator };
}

/**
 * `frac(비스칼라 분자, 스칼라 분모)` 를 `역수 × 분자` 로 내린다.
 *
 * 곱으로 만든 뒤 `toMonomial`/`fromMonomial` 를 한 번 더 태우는 게 요점이다 — 그래야
 * `\frac{2A}{3}` 의 `2` 와 역수 `1/3` 이 하나의 계수 `2/3` 로 합쳐진다.
 * 실패하면 `null` — **정규화는 실패를 새로 만들지 않는다.**
 */
function hoistFracNumerator(
  numerator: TypedExpr,
  denominator: TypedExpr,
  foldPowers: boolean,
): TypedExpr | null {
  const recip = reciprocalOf(denominator);
  if (recip === null) return null;
  const product = buildMul(recip, numerator);
  if (!product.ok) return null;
  return fromMonomial(toMonomial(product.value), foldPowers);
}

/** `frac` — 유리수 접기, 그리고 비스칼라 분자의 역수 하강. */
export function normalizeFrac(
  e: Extract<TypedExpr, { op: 'frac' }>,
  foldPowers: boolean,
  recur: (child: TypedExpr) => Result<TypedExpr>,
): Result<TypedExpr> {
  const numerator = recur(e.numerator);
  if (!numerator.ok) return numerator;
  const denominator = recur(e.denominator);
  if (!denominator.ok) return denominator;

  // 정수/정수 는 **분수 표기가 아니라 유리수 리터럴**이다. 사용자가 직접 쓴
  // `\frac{3}{9}` 는 CE가 이미 `Rational` 로 주므로(그래서 리터럴로 들어온다) 여기 안
  // 걸리고, 재작성이 만들어낸 `\frac{-3}{9}` 같은 것만 걸린다. 안 접으면 렌더가
  // `\frac{-3}{9}` 를 내고 다시 읽으면 CE가 `Rational(-1,3)` 으로 줄여버려
  // **멱등이 깨진다**(퍼즈로 확인).
  const n = asLiteral(numerator.value);
  const dLit = asLiteral(denominator.value);
  const d = dLit === null ? null : asInteger(dLit);
  if (n !== null && d !== null && d !== 0 && asInteger(n) !== null) {
    return ok(buildNum(divideByInt(n, d)));
  }

  // **분자가 비스칼라면 역수를 곱으로 내린다** — `\frac{2A}{3}` → `\frac{2}{3}A`,
  // `\frac{I}{2}` → `\frac{1}{2}I`, `\frac{A}{a}` → `\frac{1}{a}A`.
  //
  // 나눗셈 표기를 보존하는 건 **스칼라 분수**에 한한다 (`\frac{x^2+2x+1}{x+1}` 은
  // 그대로 둬야 원문 모양이 산다). 분자가 행렬이면 "행렬을 스칼라로 나눈다" 는
  // 뜻이므로 계수를 앞으로 빼는 쪽이 정규형에 맞는다 — 그래야 `toMonomial` 가 계수를
  // 보고 동류항·정렬이 걸린다.
  //
  // ⚠ **`\frac{I}{2}` 는 여기 안 걸린다.** 문맥이 없는 `I` 는 `matIdentity` 케이스가
  // (1,1)로 굳혀버려서 분자가 스칼라가 되기 때문이다. 그리고 `\frac{I}{2}A` 는 애초에
  // elaborate 에서 막힌다 — `hasUnresolvedIdentity` 가 `frac` 안을 안 들여다본다.
  // 둘 다 이 하강과 별개의 건이라 지금은 그대로 둔다.
  if (!isScalar(numerator.value.shape)) {
    const hoisted = hoistFracNumerator(numerator.value, denominator.value, foldPowers);
    if (hoisted !== null) return ok(hoisted);
  }
  return buildFrac(numerator.value, denominator.value);
}
