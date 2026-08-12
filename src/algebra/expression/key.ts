import { asInteger, literalKey, negLit, type Literal } from '../literal/literal';
import { formatShape, type Dim } from '../shape/shape';
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
 * 12000회 기준 600ms → 1040ms 로 **1.7배 느려졌다**(실측 — 이 숫자를 재던 벤치가
 * 그때는 저장소에 없었다. 지금은 `normalize/normalize.bench.ts`, `npm run bench`).
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

/** 배열형 필드 비교. 길이가 다르면 그 자체로 다른 것 — 두 배열이 완전히 같을 때만 0. */
function compareArray<T>(as: readonly T[], bs: readonly T[], cmp: (a: T, b: T) => number): number {
  if (as.length !== bs.length) return as.length - bs.length;
  for (let i = 0; i < as.length; i += 1) {
    const c = cmp(as[i], bs[i]);
    if (c !== 0) return c;
  }
  return 0;
}

/** 대소만 있으면 되는 문자열 비교 — `localeCompare` 는 로케일 규칙을 태워 더 무겁다. */
function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareOptional(
  a: TypedExpr | null,
  b: TypedExpr | null,
  cmp: (a: TypedExpr, b: TypedExpr) => number,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return cmp(a, b);
}

/** `Shape` 의 한 축. `'unknown'` 은 임의로 숫자보다 앞에 둔다 — 대소 자체엔 의미가 없다. */
function compareDim(a: Dim, b: Dim): number {
  if (a === b) return 0;
  if (a === 'unknown') return -1;
  if (b === 'unknown') return 1;
  return a - b;
}

const LITERAL_KIND_RANK: Record<Literal['kind'], number> = {
  int: 0,
  rational: 1,
  decimal: 2,
  complex: 3,
};

/** `literalKey` 와 같은 동치 관계를 지키는 리터럴 비교. */
function compareLiteral(a: Literal, b: Literal): number {
  if (a.kind !== b.kind) return LITERAL_KIND_RANK[a.kind] - LITERAL_KIND_RANK[b.kind];
  switch (a.kind) {
    case 'int':
      return a.value - (b as typeof a).value;
    case 'rational': {
      const bb = b as typeof a;
      return a.n !== bb.n ? a.n - bb.n : a.d - bb.d;
    }
    // `text` 로 비교한다 — `literalKey` 가 `value` 가 아니라 `text` 를 쓴다
    // (`0.50` 과 `0.5` 는 값이 같아도 다른 리터럴이다, 파일 서두 `literal.ts` 참고).
    case 'decimal':
      return compareStr(a.text, (b as typeof a).text);
    case 'complex': {
      const bb = b as typeof a;
      const byRe = compareLiteral(a.re, bb.re);
      return byRe !== 0 ? byRe : compareLiteral(a.im, bb.im);
    }
  }
}

/**
 * op 순위표. `exprKey` 접두 문자의 아스키 코드를 그대로 흉내 낸다 — 정확히 같은 순서는
 * 아니지만(아래 주석), **정렬 최적화 전후로 바뀌는 순서를 최소화**하려는 목적이면
 * 충분하다. `prettifyOrder.ts` 의 `RANK` 와는 **다른 표**다 — 저건 "무거워 보이는 순서"
 * (사람이 읽기 좋은 순서), 이건 "지문 순서"(구조 비교용). 서로 참조하지 않는다.
 *
 * 접두 문자가 겹치는 자리(`matrix`/`mul` 은 둘 다 `m`, `dot`/`deriv` 는 둘 다 `d`,
 * `scalarPow`/`prod` 는 둘 다 `p`, `sym`/`sum` 은 둘 다 `s`)는 순위가 같으므로
 * `compareExpr` 가 op 이름 문자열로 한 번 더 가른다. `call` 은 `exprKey` 가 함수 이름
 * 자체로 시작해 이름마다 자리가 달라지므로 이 표로는 못 흉내 낸다 — `sym` 자리 근처에
 * 고정해두고 그 차이는 받아들인다.
 */
const OP_RANK: Record<TypedExpr['op'], number> = {
  scalarMul: '*'.charCodeAt(0),
  add: '+'.charCodeAt(0),
  neg: '-'.charCodeAt(0),
  matIdentity: 'I'.charCodeAt(0),
  matMul: 'M'.charCodeAt(0),
  matPow: 'P'.charCodeAt(0),
  transpose: 'T'.charCodeAt(0),
  apply: 'a'.charCodeAt(0),
  cross: 'c'.charCodeAt(0),
  dot: 'd'.charCodeAt(0),
  deriv: 'd'.charCodeAt(0),
  frac: 'f'.charCodeAt(0),
  integral: 'i'.charCodeAt(0),
  matrix: 'm'.charCodeAt(0),
  mul: 'm'.charCodeAt(0),
  num: 'n'.charCodeAt(0),
  scalarPow: 'p'.charCodeAt(0),
  prod: 'p'.charCodeAt(0),
  sym: 's'.charCodeAt(0),
  call: 's'.charCodeAt(0),
  sum: 's'.charCodeAt(0),
};

/**
 * `exprKey` 와 같은 동치 관계를 갖는 **구조 비교자** — 문자열을 만들지 않는다.
 *
 * `sortScalars`/`normalize.ts` 의 `sortTerms` 가 쓴다. **불변식:
 * `compareExpr(a,b) === 0 ⟺ exprKey(a) === exprKey(b)`.** 순서(부호)까지 `exprKey`
 * 사전순과 같을 필요는 없다 — 그건 `OP_RANK` 로 대충 흉내만 낸다(주석 참고). 하지만
 * "같다"는 반드시 일치해야 한다: 어긋나면 `Array.sort` 안정성 때문에 같은 내용이
 * 입력 순서에 따라 다르게 굳고, `monomialKey` 가 흔들려 동류항이 조용히 안 합쳐진다.
 * `key.test.ts` 가 이 불변식을 무작위로 대조한다.
 */
export function compareExpr(a: TypedExpr, b: TypedExpr): number {
  if (a === b) return 0;
  if (a.op !== b.op) {
    const byRank = OP_RANK[a.op] - OP_RANK[b.op];
    return byRank !== 0 ? byRank : compareStr(a.op, b.op);
  }
  switch (a.op) {
    case 'num':
      return compareLiteral(a.value, (b as typeof a).value);
    case 'sym':
      return compareStr(a.name, (b as typeof a).name);
    case 'matIdentity': {
      const bb = b as typeof a;
      return compareDim(a.shape.rows, bb.shape.rows) || compareDim(a.shape.cols, bb.shape.cols);
    }
    case 'matrix': {
      const bb = b as typeof a;
      return compareArray(a.rows, bb.rows, (ra, rb) => compareArray(ra, rb, compareExpr));
    }
    case 'add':
      return compareArray(a.terms, (b as typeof a).terms, compareExpr);
    case 'neg':
      return compareExpr(a.operand, (b as typeof a).operand);
    case 'scalarMul':
    case 'matMul':
      return compareArray(a.factors, (b as typeof a).factors, compareExpr);
    case 'mul': {
      const bb = b as typeof a;
      return compareExpr(a.scalar, bb.scalar) || compareExpr(a.nonScalar, bb.nonScalar);
    }
    case 'dot':
    case 'cross': {
      const bb = b as typeof a;
      return compareExpr(a.left, bb.left) || compareExpr(a.right, bb.right);
    }
    case 'transpose':
      return compareExpr(a.operand, (b as typeof a).operand);
    case 'matPow':
    case 'scalarPow': {
      const bb = b as typeof a;
      return compareExpr(a.base, bb.base) || compareExpr(a.exponent, bb.exponent);
    }
    case 'call':
    case 'apply': {
      const bb = b as typeof a;
      return compareStr(a.name, bb.name) || compareArray(a.args, bb.args, compareExpr);
    }
    case 'frac': {
      const bb = b as typeof a;
      return compareExpr(a.numerator, bb.numerator) || compareExpr(a.denominator, bb.denominator);
    }
    case 'deriv': {
      const bb = b as typeof a;
      return (
        compareExpr(a.body, bb.body) ||
        compareArray(a.vars, bb.vars, compareStr) ||
        (a.order - bb.order)
      );
    }
    case 'sum':
    case 'prod':
    case 'integral': {
      const bb = b as typeof a;
      return (
        compareExpr(a.body, bb.body) ||
        compareStr(a.variable, bb.variable) ||
        compareOptional(a.lower, bb.lower, compareExpr) ||
        compareOptional(a.upper, bb.upper, compareExpr)
      );
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
 * 이미 정렬돼 있는가. `n-1` 회 비교로 확인한다 — 정규화가 자식을 이미 정렬된 채로
 * 넘겨주는 경우가 흔해서(같은 항이 재조립되며 다시 지나가는 자리가 많다), 정렬 자체를
 * 건너뛰는 게 흔한 경우의 비용을 없앤다.
 */
function isSorted(xs: readonly TypedExpr[]): boolean {
  for (let i = 1; i < xs.length; i += 1) {
    if (compareExpr(xs[i - 1], xs[i]) > 0) return false;
  }
  return true;
}

/**
 * 교환 가능한 인수들을 정규 순서(`compareExpr`)로 정렬한다.
 *
 * 순서를 고정해야 동류항 키가 안정된다 (`ab` 와 `ba` 가 같은 항으로 잡히려면). 다항식
 * 전용이 아니다 — 정규화가 **곱 인수 열**에도 그대로 쓴다.
 *
 * **문자열을 만들지 않는다.** 예전엔 `exprKey` 문자열을 뽑아 들고 decorate-sort-undecorate
 * 를 했는데, 트리 크기에 비례하는 문자열을 인수마다 새로 만드는 셈이라 정규화의 굵은
 * 비용 중 하나였다. `compareExpr` 는 첫 차이에서 끊으므로 대개 그보다 훨씬 싸다.
 *
 * 길이 0·1(가장 흔한 경우)과 이미 정렬된 경우는 **입력 배열을 그대로 돌려준다** — 이
 * 모듈 전체가 불변 트리라 참조를 공유해도 안전하고, 위쪽 호출자들이 `===` 로 "바뀐 게
 * 없다"를 알아채는 자리가 많다(`fromMonomial`, `prettify.ts` 의 `mapAll` 등과 같은 관례).
 */
export function sortScalars(scalars: readonly TypedExpr[]): TypedExpr[] {
  if (scalars.length < 2 || isSorted(scalars)) return scalars as TypedExpr[];
  return [...scalars].sort(compareExpr);
}
