import { asInteger, literalKey } from '../literal/literal';
import { formatShape } from '../shape/shape';
import type { TypedExpr } from './node';

/**
 * Typed IR 의 **구조 지문**과 상수 판정.
 *
 * 다항식과는 무관한 범용 유틸이라 여기 있다 — 동류항 판정(`polynomial`), 치환 고정점과
 * 캐시 지문(`evaluate`), 셀 간 캐시(`cellGraph`)가 전부 이 키 위에서 돈다.
 */

/**
 * 구조적 동일성 키.
 *
 * `debug.ts` 의 s-식과 모양이 비슷하지만 **일부러 따로 둔다** — 저건 사람이 읽는 출력이라
 * 언제든 바뀔 수 있고, 이건 동류항 판정이 걸린 의미 계약이다.
 *
 * **단사여야 한다** — 서로 다른 두 식이 같은 키를 내면 동류항 판정이 조용히 무너진다.
 */
export function exprKey(e: TypedExpr): string {
  switch (e.op) {
    case 'num':
      return `n${literalKey(e.value)}`;
    case 'sym':
      return `s${e.name}`;
    case 'matrix':
      return `m[${e.rows.map((r) => r.map(exprKey).join(',')).join(';')}]`;
    case 'add':
      return `+(${e.terms.map(exprKey).join(' ')})`;
    case 'neg':
      return `-(${exprKey(e.operand)})`;
    case 'scalarMul':
      return `*(${e.factors.map(exprKey).join(',')})`;
    case 'matMul':
      return `M(${e.factors.map(exprKey).join(',')})`;
    case 'mul':
      return `mul(${exprKey(e.scalar)},${exprKey(e.matrix)})`;
    case 'dot':
      return `dot(${exprKey(e.left)},${exprKey(e.right)})`;
    case 'cross':
      return `cross(${exprKey(e.left)},${exprKey(e.right)})`;
    case 'transpose':
      return `T(${exprKey(e.operand)})`;
    case 'matPow':
      return `P(${exprKey(e.base)},${exprKey(e.exponent)})`;
    case 'scalarPow':
      return `p(${exprKey(e.base)},${exprKey(e.exponent)})`;
    case 'call':
      return `${e.name}(${e.args.map(exprKey).join(',')})`;
    // `call` 처럼 맨 이름으로 접두하지 않는다 — 사용자가 `abs` 같은 내장 함수 이름과
    // 겹치는 이름으로 함수를 정의할 수 있어서(`call`의 `name` 은 SCALAR_FUNCTIONS 값
    // 중 하나뿐이다), 그대로 두면 서로 다른 두 op가 같은 키를 낼 수 있다.
    case 'apply':
      return `apply(${e.name},${e.args.map(exprKey).join(',')})`;
    case 'frac':
      return `f(${exprKey(e.numerator)},${exprKey(e.denominator)})`;
    case 'matIdentity':
      return `I(${formatShape(e.shape)})`;
    case 'deriv':
      return `deriv(${exprKey(e.body)},${e.vars.join(',')},${e.order})`;
    case 'sum':
    case 'prod':
    case 'integral': {
      const lo = e.lower === null ? '_' : exprKey(e.lower);
      const hi = e.upper === null ? '_' : exprKey(e.upper);
      return `${e.op}(${exprKey(e.body)},${e.variable},${lo},${hi})`;
    }
  }
}

/**
 * 지수를 **알려진 정수**로 줄일 수 있으면 그 값, 아니면 `null`.
 *
 * `matPow.exponent` 가 `TypedExpr` 이 되면서 "정수인가" 판정이 여러 곳(normalize의 접기,
 * toPolynomial의 전개, matrixFold의 역행렬, numeric)에 필요해졌다. 한 곳에 둔다.
 *
 * `neg(num)` 도 받는다 — `buildProduct` 가 부호를 바깥 `neg` 로 내보내므로 정규화 뒤의
 * 음수 지수는 `num(-1)` 이 아니라 `neg(num 1)` 일 수 있다.
 */
export function constantInteger(e: TypedExpr): number | null {
  if (e.op === 'num') return asInteger(e.value);
  if (e.op === 'neg' && e.operand.op === 'num') {
    const n = asInteger(e.operand.value);
    return n === null ? null : -n;
  }
  return null;
}
