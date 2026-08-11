import { asInteger, literalKey, negLit, type Literal } from '../literal/literal';
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
 *
 * ⚠ **`WeakMap` 캐시를 달지 말 것 — 재봤고 느려진다.** 노드가 불변이라 캐시 자체는
 * 안전하지만, 정규화가 다루는 부분식은 대개 잎 한둘짜리라 키가 짧고, 게다가
 * `fromMonomial` 이 매번 새 노드를 만들어 적중률이 낮다. 넣었더니 정규화 벤치가
 * 12000회 기준 600ms → 1040ms 로 **1.7배 느려졌다**(실측).
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
      return `mul(${exprKey(e.scalar)},${exprKey(e.nonScalar)})`;
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
 * `neg(num)` 도 받는다 — `fromMonomial` 가 부호를 바깥 `neg` 로 내보내므로 정규화 뒤의
 * 음수 지수는 `num(-1)` 이 아니라 `neg(num 1)` 일 수 있다.
 */
export function asKnownInteger(e: TypedExpr): number | null {
  const lit = asLiteral(e);
  return lit === null ? null : asInteger(lit);
}

/**
 * 노드를 리터럴로 읽는다. 리터럴이 아니면 `null`.
 *
 * **`neg(num)` 도 받는다** — 정규화가 부호를 바깥 `neg` 로 내보내므로(`fromMonomial`),
 * 정규화 뒤의 음수는 `num(-3)` 이 아니라 `neg(num 3)` 이다. 이 한 줄 때문에 곳곳에서
 * `num` 만 보다가 음수를 놓치는 일이 있었다.
 */
export function asLiteral(e: TypedExpr): Literal | null {
  if (e.op === 'num') return e.value;
  if (e.op === 'neg' && e.operand.op === 'num') return negLit(e.operand.value);
  return null;
}

/**
 * 교환 가능한 인수들을 `exprKey` 순으로 정렬한다.
 *
 * 순서를 고정해야 동류항 키가 안정된다 (`ab` 와 `ba` 가 같은 항으로 잡히려면). 다항식
 * 전용이 아니다 — 정규화가 **곱 인수 열**에도 그대로 쓴다.
 *
 * 키를 먼저 뽑아 들고 정렬한다 — 비교 함수 안에서 뽑으면 비교마다 다시 만들게 된다
 * (`sortTerms` 도 같은 꼴이다). 인수가 두셋뿐인 흔한 경우엔 차이가 없고, 열이 길어질수록
 * 벌어진다.
 */
export const sortScalars = (scalars: readonly TypedExpr[]): TypedExpr[] =>
  scalars
    .map((expr) => ({ expr, key: exprKey(expr) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((keyed) => keyed.expr);
