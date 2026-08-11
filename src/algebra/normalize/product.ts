import { buildNum, matMulShapeOf } from '../expression/builders';
import { fail, ok, type Result } from '../result/result';
import { isScalar } from '../shape/shape';
import type { TypedExpr } from '../expression/node';
import { negLit, ONE as ONE_LIT } from '../literal/literal';
import { mulLit } from '../literal/arith';
import { fromMonomial } from '../polynomial/convert';
import type { Monomial } from '../polynomial/polynomial';

/**
 * 곱 계열 정규화 — `neg` / `scalarMul` / `matMul` / `mul`.
 *
 * 두 함수가 짝을 이룬다: `toMonomial` 가 곱을 (계수, 스칼라들, 비스칼라들) 셋으로 **분해**하고,
 * `fromMonomial`(`polynomial/convert.ts`)가 그걸 다시 **조립**한다. 그 사이에서 접기·정렬·
 * 항등원 제거가 일어난다. 조립 쪽이 저기 있는 건 `Monomial` 이 다항식의 타입이고 다항식
 * 경로도 같은 조립기를 쓰기 때문이다.
 *
 * 쓰는 표현은 다항식의 `Monomial` 과 같다 — 곱 하나를 셋으로 가르는 일이 단항식과 정확히
 * 같은 모양이라서다. 다만 **`toMonomial` 가 돌려주는 `scalars` 는 정렬 전이다**
 * (`fromMonomial` 가 마지막에 한 번 정렬한다). `monomialKey` 를 뽑으려면 그 전에 정렬해야
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
export function toMonomial(e: TypedExpr): Monomial {
  switch (e.op) {
    case 'num':
      return { coefficient: e.value, scalars: [], nonScalars: [] };

    case 'neg': {
      const c = toMonomial(e.operand);
      return { coefficient: negLit(c.coefficient), scalars: c.scalars, nonScalars: c.nonScalars };
    }

    case 'scalarMul': {
      let coefficient = ONE_LIT;
      const scalars: TypedExpr[] = [];
      for (const f of e.factors) {
        const c = toMonomial(f);
        // 못 곱하면 접지 않고 인수로 되돌린다 — 값을 뭉개지 않는다.
        const product = mulLit(coefficient, c.coefficient);
        if (product !== null) coefficient = product;
        else scalars.push(buildNum(c.coefficient));
        scalars.push(...c.scalars);
      }
      return { coefficient, scalars, nonScalars: [] };
    }

    case 'matMul': {
      // `matMul` 이라고 해서 늘 비스칼라는 아니다 — `v^Tv` 는 (1,3)(3,1)=(1,1) 로
      // op는 matMul이지만 모양은 스칼라다(설계: 모든 것이 (rows,cols), (1,1)이 스칼라).
      // 이럴 땐 안을 열지 않고 **통째로 스칼라 원자 하나**로 취급해야 한다 — 안을 열면
      // 그 안의 인수들이 바깥 matMul의 인수 열에 잘못 이어붙어 차원이 깨진다.
      if (isScalar(e.shape)) return { coefficient: ONE_LIT, scalars: [e], nonScalars: [] };

      let coefficient = ONE_LIT;
      const scalars: TypedExpr[] = [];
      const nonScalars: TypedExpr[] = [];
      for (const f of e.factors) {
        const c = toMonomial(f);
        const product = mulLit(coefficient, c.coefficient);
        if (product !== null) coefficient = product;
        else scalars.push(buildNum(c.coefficient));
        scalars.push(...c.scalars);
        nonScalars.push(...c.nonScalars);
      }
      return { coefficient, scalars, nonScalars };
    }

    case 'mul': {
      const s = toMonomial(e.scalar);
      const m = toMonomial(e.nonScalar);
      const product = mulLit(s.coefficient, m.coefficient);
      return product !== null
        ? { coefficient: product, scalars: [...s.scalars, ...m.scalars], nonScalars: m.nonScalars }
        : {
            coefficient: ONE_LIT,
            scalars: [
              buildNum(s.coefficient),
              buildNum(m.coefficient),
              ...s.scalars,
              ...m.scalars,
            ],
            nonScalars: m.nonScalars,
          };
    }

    case 'matIdentity':
      // (1,1) 로 굳은 항등원은 스칼라 1과 같다 — 인수로 남기면 안 된다. 안 그러면
      // `pI` 가 `p` 로 안 줄고 `mul(I,p)` 로 남는다(퍼즈로 확인). 아직 비스칼라 크기로
      // 확정된 항등원(문맥에서 진짜 행렬로 쓰일 예정인 경우)은 그대로 원자로 둔다.
      return isScalar(e.shape)
        ? { coefficient: ONE_LIT, scalars: [], nonScalars: [] }
        : { coefficient: ONE_LIT, scalars: [], nonScalars: [e] };

    default:
      return isScalar(e.shape)
        ? { coefficient: ONE_LIT, scalars: [e], nonScalars: [] }
        : { coefficient: ONE_LIT, scalars: [], nonScalars: [e] };
  }
}

// ---------------------------------------------------------------------------
// 조립 보조
// ---------------------------------------------------------------------------

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
  const c = toMonomial(inner.value);
  return ok(fromMonomial({ ...c, coefficient: negLit(c.coefficient) }, foldPowers));
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
    const m = recur(e.nonScalar);
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

  let coefficient = ONE_LIT;
  const scalars: TypedExpr[] = [];
  const nonScalars: TypedExpr[] = [];
  for (const child of children) {
    const c = toMonomial(child);
    // 못 곱하면 접지 않고 인수로 되돌린다 — 값을 뭉개지 않는다.
    const product = mulLit(coefficient, c.coefficient);
    if (product !== null) coefficient = product;
    else scalars.push(buildNum(c.coefficient));
    scalars.push(...c.scalars);
    nonScalars.push(...c.nonScalars);
  }
  return ok(fromMonomial({ coefficient, scalars, nonScalars }, foldPowers));
}
