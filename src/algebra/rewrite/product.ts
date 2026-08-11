import { buildNum } from '../expr/builders';
import { constantInteger, exprKey, sortScalars } from '../expr/key';
import { fail, ok, type Result } from '../result/result';
import { SCALAR, isScalar, shape, type Shape } from '../shape/shape';
import type { TypedExpr } from '../expr/node';
import { intLit, isOne, negLit, splitSign, ONE as ONE_LIT, type Literal } from '../literal/literal';
import { mulLit } from '../literal/arith';
import type { Monomial } from '../polynomial/polynomial';

/**
 * 곱 계열 정규화 — `neg` / `scalarMul` / `matMul` / `mul`.
 *
 * 두 함수가 짝을 이룬다: `collect` 가 곱을 (계수, 스칼라들, 비스칼라들) 셋으로 **분해**하고,
 * `buildProduct` 가 그걸 다시 **조립**한다. 그 사이에서 접기·정렬·항등원 제거가 일어난다.
 *
 * 쓰는 표현은 다항식의 `Monomial` 과 같다 — 곱 하나를 셋으로 가르는 일이 단항식과 정확히
 * 같은 모양이라서다. 다만 **`collect` 가 돌려주는 `scalars` 는 정렬 전이다**
 * (`buildProduct` 가 마지막에 한 번 정렬한다). `monomialKey` 를 뽑으려면 그 전에 정렬해야
 * 한다 — `Monomial` 문서의 경고 참고.
 *
 * 이 파일은 `normalize.ts` 를 import 하지 않는다. 자식 재귀는 `recur` 로 받는다.
 */

// ---------------------------------------------------------------------------
// 분해
// ---------------------------------------------------------------------------

/**
 * **이미 정규화를 거친** 자식 노드를 분해한다.
 *
 * `scalarMul`/`matMul`/`mul`/`neg` 를 재귀적으로 뚫고 들어가는 게 요점이다 — 그래야
 * `mul(k, mul(j, A))` 같은 중첩이나 `matMul(neg(A), B)` 처럼 elaborate가 그대로 남겨둔
 * 부호가 최상단까지 올라온다. 그 외의 노드(sym, add, transpose, matPow, call 등)는 모양만
 * 보고 스칼라/비스칼라 원자 하나로 취급한다 — `add` 에서 멈추는 것도 이 default 분기다.
 */
export function collect(e: TypedExpr): Monomial {
  switch (e.op) {
    case 'num':
      return { numeric: e.value, scalars: [], factors: [] };

    case 'neg': {
      const c = collect(e.operand);
      return { numeric: negLit(c.numeric), scalars: c.scalars, factors: c.factors };
    }

    case 'scalarMul': {
      let numeric = ONE_LIT;
      const scalars: TypedExpr[] = [];
      for (const f of e.factors) {
        const c = collect(f);
        // 못 곱하면 접지 않고 인수로 되돌린다 — 값을 뭉개지 않는다.
        const product = mulLit(numeric, c.numeric);
        if (product !== null) numeric = product;
        else scalars.push(buildNum(c.numeric));
        scalars.push(...c.scalars);
      }
      return { numeric, scalars, factors: [] };
    }

    case 'matMul': {
      // `matMul` 이라고 해서 늘 비스칼라는 아니다 — `v^Tv` 는 (1,3)(3,1)=(1,1) 로
      // op는 matMul이지만 모양은 스칼라다(설계: 모든 것이 (rows,cols), (1,1)이 스칼라).
      // 이럴 땐 안을 열지 않고 **통째로 스칼라 원자 하나**로 취급해야 한다 — 안을 열면
      // 그 안의 인수들이 바깥 matMul의 인수 열에 잘못 이어붙어 차원이 깨진다.
      if (isScalar(e.shape)) return { numeric: ONE_LIT, scalars: [e], factors: [] };

      let numeric = ONE_LIT;
      const scalars: TypedExpr[] = [];
      const factors: TypedExpr[] = [];
      for (const f of e.factors) {
        const c = collect(f);
        const product = mulLit(numeric, c.numeric);
        if (product !== null) numeric = product;
        else scalars.push(buildNum(c.numeric));
        scalars.push(...c.scalars);
        factors.push(...c.factors);
      }
      return { numeric, scalars, factors };
    }

    case 'mul': {
      const s = collect(e.scalar);
      const m = collect(e.matrix);
      const product = mulLit(s.numeric, m.numeric);
      return product !== null
        ? { numeric: product, scalars: [...s.scalars, ...m.scalars], factors: m.factors }
        : {
            numeric: ONE_LIT,
            scalars: [
              buildNum(s.numeric),
              buildNum(m.numeric),
              ...s.scalars,
              ...m.scalars,
            ],
            factors: m.factors,
          };
    }

    case 'matIdentity':
      // (1,1) 로 굳은 항등원은 스칼라 1과 같다 — 인수로 남기면 안 된다. 안 그러면
      // `pI` 가 `p` 로 안 줄고 `mul(I,p)` 로 남는다(퍼즈로 확인). 아직 비스칼라 크기로
      // 확정된 항등원(문맥에서 진짜 행렬로 쓰일 예정인 경우)은 그대로 원자로 둔다.
      return isScalar(e.shape)
        ? { numeric: ONE_LIT, scalars: [], factors: [] }
        : { numeric: ONE_LIT, scalars: [], factors: [e] };

    default:
      return isScalar(e.shape)
        ? { numeric: ONE_LIT, scalars: [e], factors: [] }
        : { numeric: ONE_LIT, scalars: [], factors: [e] };
  }
}

// ---------------------------------------------------------------------------
// 인수 열 접기
// ---------------------------------------------------------------------------

/** 두 non-scalar 인수 목록을 이어 붙였을 때의 모양. 결합법칙이 있어 인접 쌍만 맞으면 되고, elaborate가 이미 그 사슬 전체를 검증해뒀다. */
export const matMulShapeOf = (factors: readonly TypedExpr[]): Shape =>
  shape(factors[0].shape.rows, factors[factors.length - 1].shape.cols);

/**
 * 인수 열에서 항등원을 걷어낸다. 이웃한 같은 인수를 `matPow` 로 접지는 않는다 —
 * `AA` 는 `AA` 로 남는다. `foldPowers=false` 경로가 쓴다.
 *
 * 전부 항등원이었다면 모양을 보존하려고 하나만 남긴다.
 */
function stripIdentities(factors: readonly TypedExpr[]): TypedExpr[] {
  // 애초에 빈 목록(스칼라만 있는 곱이라 행렬 인수가 없는 경우)을 "전부 항등원이라
  // 하나 남긴다" 분기와 헷갈리면 안 된다 — factors[0]이 undefined가 되어 터진다.
  if (factors.length === 0) return [];
  const stripped = factors.filter((f) => f.op !== 'matIdentity');
  return stripped.length === 0 ? [factors[0]] : stripped;
}

/**
 * 스칼라 인수를 같은 밑끼리 모아 거듭제곱으로 접는다 — `xxxyyx` → `x⁴y²`.
 *
 * **행렬과 달리 떨어져 있어도 모은다.** 스칼라는 교환 가능하므로 위치를 지킬 이유가
 * 없고, 어차피 뒤에서 `sortScalars` 가 순서를 다시 잡는다. (행렬 쪽 `combineAdjacentPowers`
 * 가 이웃만 보는 건 비가환이라 자리를 못 옮기기 때문이다 — 두 규칙이 다른 이유가 그거다.)
 *
 * 상수 정수 지수만 합산한다. `x^a x^b` 처럼 지수가 심볼이면 합을 우리가 판정할 수 없으니
 * 건드리지 않고 그대로 흘려보낸다.
 *
 * 지수 합이 0이면 **인수 목록에서 빠진다** (`xx^{-1}` → 곱의 항등원 1). 그러면 인수가
 * 하나도 안 남을 수 있는데, 그건 `buildProduct` 의 `needsNumericLiteral` 이 `1` 로 채운다.
 */
function foldScalarPowers(scalars: readonly TypedExpr[]): TypedExpr[] {
  /** 밑 키 → 지수 합. 처음 나온 순서를 유지한다(정렬은 호출자 몫이지만 결정적이어야 한다). */
  const order: string[] = [];
  const bases = new Map<string, { base: TypedExpr; exponent: number }>();
  const untouched: TypedExpr[] = [];

  for (const f of scalars) {
    const parts =
      f.op === 'scalarPow'
        ? (() => {
            const n = constantInteger(f.exponent);
            return n === null ? null : { base: f.base, exponent: n };
          })()
        : { base: f, exponent: 1 };
    // 지수를 못 읽는 인수는 접기에 참여시키지 않는다 (같은 밑이어도 합칠 수 없다).
    if (parts === null) {
      untouched.push(f);
      continue;
    }
    const key = exprKey(parts.base);
    const seen = bases.get(key);
    if (seen === undefined) {
      order.push(key);
      bases.set(key, parts);
    } else {
      bases.set(key, { base: seen.base, exponent: seen.exponent + parts.exponent });
    }
  }

  const out: TypedExpr[] = [];
  for (const key of order) {
    const { base, exponent } = bases.get(key) as { base: TypedExpr; exponent: number };
    if (exponent === 0) continue; // x·x^{-1} = 1 — 인수에서 빠진다
    if (exponent === 1) out.push(base);
    else out.push({ op: 'scalarPow', shape: SCALAR, base, exponent: buildNum(intLit(exponent)) });
  }
  out.push(...untouched);
  return out;
}

/**
 * 인수 하나를 (밑, 지수)로 뜯는다. 벌거벗은 인수는 지수 1인 셈이다.
 *
 * `matPow` 는 **어떤 정수 지수든** 뜯는다 — 음수(역행렬)도 포함이라야
 * `A \cdot A^{-1}` 처럼 이웃한 지수를 더해서 소거(항등원)까지 갈 수 있다.
 */
function powerParts(
  f: TypedExpr,
): { readonly base: TypedExpr; readonly exponent: number } | null {
  if (f.op !== 'matPow') return { base: f, exponent: 1 };
  // 값이 확정되지 않은 지수(`A^n`)는 더할 수 없다 — 그 구간은 접지 않는다.
  const n = constantInteger(f.exponent);
  return n === null ? null : { base: f.base, exponent: n };
}

/**
 * 한 번의 "이웃한 같은 밑 지수 합치기" 패스. 항등원 제거는 호출자가 미리 한다.
 * 지수 합이 0이면 `matIdentity`, 1이면 밑 자체, 그 외에는 `matPow`.
 */
function combineAdjacentPowers(factors: readonly TypedExpr[]): TypedExpr[] {
  const out: TypedExpr[] = [];
  let i = 0;
  while (i < factors.length) {
    const first = powerParts(factors[i]);
    // 지수가 확정되지 않은 인수(`A^n`)는 더할 수 없다 — 그 자리에서 끊고 그대로 둔다.
    if (first === null) {
      out.push(factors[i]);
      i += 1;
      continue;
    }
    const key = exprKey(first.base);
    let exponent = first.exponent;
    let j = i + 1;
    while (j < factors.length) {
      const next = powerParts(factors[j]);
      if (next === null || exprKey(next.base) !== key) break;
      exponent += next.exponent;
      j += 1;
    }
    if (exponent === 0) {
      out.push({ op: 'matIdentity', shape: first.base.shape });
    } else if (exponent === 1) {
      out.push(first.base);
    } else {
      out.push({
        op: 'matPow',
        shape: first.base.shape,
        base: first.base,
        exponent: buildNum(intLit(exponent)),
      });
    }
    i = j;
  }
  return out;
}

/**
 * 항등원 제거와 이웃 거듭제곱 합치기를 **더 걸러낼 게 없을 때까지** 번갈아 돈다.
 *
 * 먼저 걸러야 하는 이유: `A I A` 처럼 사이에 낀 항등원을 빼야 `A` 둘이 이웃해져 `A²` 로
 * 접힌다. 합치는 과정에서 지수 합이 0이 되어 **새 항등원이 생길 수도** 있으므로
 * (`AA^{-1} → I`), 반복한다 (`AA^{-1}B` → 걸러낼 것 없음 → 합치기로 `[I,B]` → 다시 걸러 `[B]`).
 * 전부 항등원이었다면 모양을 보존하려고 하나만 남긴다.
 */
function foldAdjacentPowers(factors: readonly TypedExpr[]): TypedExpr[] {
  // 애초에 빈 목록(스칼라만 있는 곱이라 행렬 인수가 없는 경우)을 "전부 항등원이라
  // 하나 남긴다" 분기와 헷갈리면 안 된다 — current[0]이 undefined가 되어 터진다.
  if (factors.length === 0) return [];
  let current = factors;
  for (;;) {
    const stripped = current.filter((f) => f.op !== 'matIdentity');
    if (stripped.length === 0) return [current[0]];
    const combined = combineAdjacentPowers(stripped);
    if (!combined.some((f) => f.op === 'matIdentity')) return combined;
    current = combined;
  }
}

// ---------------------------------------------------------------------------
// 조립
// ---------------------------------------------------------------------------

/**
 * `collect` 의 결과를 다시 식으로 조립한다.
 *
 * 부호는 **숫자 계수 안에 넣지 않고 바깥에 `neg` 로 씌운다** — `numeric=-1` 을 그대로
 * 스칼라 인수 목록에 넣으면 다른 인수가 있을 때 `-1A` 처럼 불필요한 "1" 이 남는다.
 * (`polynomial/convert.ts` 의 `monomialToExpr`/`fromPolynomial` 과 같은 관례.)
 */
export function buildProduct(
  numeric: Literal,
  scalars: readonly TypedExpr[],
  matrixFactors: readonly TypedExpr[],
  foldPowers: boolean,
): TypedExpr {
  const { negative, magnitude } = splitSign(numeric);
  const sortedScalars = sortScalars(foldPowers ? foldScalarPowers(scalars) : scalars);
  const collapsedMatrix = foldPowers ? foldAdjacentPowers(matrixFactors) : stripIdentities(matrixFactors);

  const matrixNode: TypedExpr | null =
    collapsedMatrix.length === 0
      ? null
      : collapsedMatrix.length === 1
        ? collapsedMatrix[0]
        : { op: 'matMul', shape: matMulShapeOf(collapsedMatrix), factors: collapsedMatrix };

  // 숫자 리터럴은 크기가 1이 아니거나, 다른 항이 전혀 없어 "1" 자체를 나타내야 할 때만 넣는다.
  const needsNumericLiteral = !isOne(magnitude) || (sortedScalars.length === 0 && matrixNode === null);
  const scalarParts = needsNumericLiteral ? [buildNum(magnitude), ...sortedScalars] : sortedScalars;

  const scalarNode: TypedExpr | null =
    scalarParts.length === 0
      ? null
      : scalarParts.length === 1
        ? scalarParts[0]
        : { op: 'scalarMul', shape: SCALAR, factors: scalarParts };

  const core: TypedExpr =
    matrixNode === null
      ? (scalarNode as TypedExpr) // needsNumericLiteral 보장으로 scalarNode는 여기서 항상 non-null
      : scalarNode === null
        ? matrixNode
        : { op: 'mul', shape: matrixNode.shape, scalar: scalarNode, matrix: matrixNode };

  return negative ? { op: 'neg', shape: core.shape, operand: core } : core;
}

/**
 * 이미 정규화된 non-scalar 인수 목록 하나를 단일 식으로 (호출자가 dot/cross/transpose에
 * 넘기기 위해).
 *
 * **목록이 비어 있으면 오류다** — dot/cross/transpose는 원래 비스칼라 피연산자를
 * 요구하는데, 그 피연산자가 (예: 문맥 없이 쓴 `I` 처럼) 끝내 스칼라로 굳어버려 안이
 * 통째로 비는 경우다. 조용히 뭔가를 지어내는 대신 정직하게 오류를 낸다.
 */
export function asSingleMatrix(factors: readonly TypedExpr[]): Result<TypedExpr> {
  if (factors.length === 0) {
    return fail(
      'shape-mismatch',
      'Expected a non-scalar operand here, but it reduced to a scalar',
    );
  }
  return ok(
    factors.length === 1
      ? factors[0]
      : { op: 'matMul', shape: matMulShapeOf(factors), factors: [...factors] },
  );
}

// ---------------------------------------------------------------------------
// 케이스 핸들러
// ---------------------------------------------------------------------------

/** `neg` — 자식을 분해해 부호를 계수로 흡수한 뒤 다시 조립한다. */
export function normalizeNeg(
  e: Extract<TypedExpr, { op: 'neg' }>,
  foldPowers: boolean,
  recur: (child: TypedExpr) => Result<TypedExpr>,
): Result<TypedExpr> {
  const inner = recur(e.operand);
  if (!inner.ok) return inner;
  const c = collect(inner.value);
  return ok(buildProduct(negLit(c.numeric), c.scalars, c.factors, foldPowers));
}

/** `scalarMul` / `matMul` / `mul` — 인수를 전부 분해해 하나의 곱으로 다시 조립한다. */
export function normalizeProduct(
  e: Extract<TypedExpr, { op: 'scalarMul' | 'matMul' | 'mul' }>,
  foldPowers: boolean,
  recur: (child: TypedExpr) => Result<TypedExpr>,
): Result<TypedExpr> {
  let children: readonly TypedExpr[];
  if (e.op === 'mul') {
    const s = recur(e.scalar);
    if (!s.ok) return s;
    const m = recur(e.matrix);
    if (!m.ok) return m;
    children = [s.value, m.value];
  } else {
    const normed: TypedExpr[] = [];
    for (const f of e.factors) {
      const r = recur(f);
      if (!r.ok) return r;
      normed.push(r.value);
    }
    children = normed;
  }

  let numeric = ONE_LIT;
  const scalars: TypedExpr[] = [];
  const matrixFactors: TypedExpr[] = [];
  for (const child of children) {
    const c = collect(child);
    // 못 곱하면 접지 않고 인수로 되돌린다 — 값을 뭉개지 않는다.
    const product = mulLit(numeric, c.numeric);
    if (product !== null) numeric = product;
    else scalars.push(buildNum(c.numeric));
    scalars.push(...c.scalars);
    matrixFactors.push(...c.factors);
  }
  return ok(buildProduct(numeric, scalars, matrixFactors, foldPowers));
}
