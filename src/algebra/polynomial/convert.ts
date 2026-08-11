import {
  buildAdd,
  buildCross,
  buildDot,
  buildMul,
  buildNum,
  buildTranspose,
} from '../expr/builders';
import { OP_PROPERTIES } from '../opers';
import { constantInteger, sortScalars } from '../expr/key';
import { fail, ok, type Result } from '../result/result';
import { SCALAR, isKnownShape, isScalar, type Shape } from '../shape/shape';
import type { TypedExpr } from '../expr/node';
import { isOne, isZero, splitSign, ONE as ONE_LIT, ZERO as ZERO_LIT } from '../literal/literal';
import { mulLit } from '../literal/arith';
import {
  MAX_POWER_EXPANSION,
  ONE,
  atom,
  negate,
  polyMul,
  type Monomial,
  type Polynomial,
} from './polynomial';

/**
 * Typed IR ↔ 다항식 왕복.
 *
 * 두 방향을 한 파일에 두는 이유: 왕복이 값을 보존해야 한다는 게 계약이라 한쪽만 고치면
 * 바로 깨진다.
 */

// ---------------------------------------------------------------------------
// 전개 — TypedExpr -> Polynomial
// ---------------------------------------------------------------------------

/**
 * 곱의 결과가 스칼라면 인수 열을 **하나의 스칼라 원자로 접는다.**
 *
 * 이게 없으면 정규형의 전제가 깨진다. `C(ru)` 에서 `ru` 는 `(1,3)(3,1)` = 스칼라인데,
 * 인수 열을 그냥 이어붙이면 `[C, r, u]` 가 되어 **원래 식에 없던 `C·r` 이 생긴다**
 * (`(3,3)(1,3)` — 애초에 곱할 수 없는 조합). 스칼라로 접힌 구간은 거기서 끊어야 한다.
 *
 * 분배는 이미 끝난 뒤에 접으므로 `r(v+w) → rv + rw` 같은 전개는 그대로 남는다.
 */
function collapseIfScalar(p: Polynomial, target: Shape): Result<Polynomial> {
  if (!isScalar(target)) return ok(p);
  const out: Monomial[] = [];
  for (const m of p) {
    if (m.factors.length === 0) {
      out.push(m);
      continue;
    }
    const folded = factorsToExpr(m);
    if (!folded.ok) return folded;
    out.push({
      numeric: m.numeric,
      scalars: sortScalars([...m.scalars, folded.value]),
      factors: [],
    });
  }
  return ok(out);
}

/** 단항식의 **비스칼라 부분만** 하나의 식으로 되돌린다 (내적/외적의 피연산자를 만들 때 쓴다). */
function factorsToExpr(m: Monomial): Result<TypedExpr> {
  if (m.factors.length === 0) return fail('malformed', 'Expected a non-scalar operand');
  return m.factors
    .slice(1)
    .reduce<Result<TypedExpr>>(
      (acc, f) => (acc.ok ? buildMul(acc.value, f) : acc),
      ok(m.factors[0]),
    );
}

/**
 * TypedExpr -> 다항식. 곱을 합 위로 **완전히 분배**한다.
 *
 * 분배가 허용되는 근거는 `opers.ts` 의 `distributesOverAdd` 다 (현재 이항 연산 넷 모두 참).
 */
export function toPolynomial(e: TypedExpr): Result<Polynomial> {
  switch (e.op) {
    case 'num':
      return ok([{ numeric: e.value, scalars: [], factors: [] }]);

    case 'sym':
    case 'matrix':
    case 'call':
    case 'apply':
    case 'frac':
    case 'matIdentity':
    case 'deriv':
    case 'sum':
    case 'prod':
    case 'integral':
      // 순수 스칼라 부분식은 CE 몫이라(§7) 여기서는 통째로 원자 취급한다.
      // matIdentity도 여기서는 그냥 원자다 — 소거는 정규화의 몫이다. `frac` 도
      // 나눗셈을 다항식으로 펼치지 않고 통째로 둔다 — 분배 여부는 CE 위임 몫이다.
      // 미분/적분/합/곱도 통째로 원자다 — 곱을 그 안까지 분배할 이유가 없다.
      return ok([atom(e)]);

    case 'scalarPow': {
      // `matPow` 와 달리 **밑은 다항식으로 펼치지 않는다** — `(x+1)^2` 를 분배하면
      // expand/simplify의 기존 동작이 흔들린다. 여기서 필요한 건 딱 하나, 공통인수
      // 추출이 `x^2` 와 `x` 를 잇게 하는 것뿐이라 밑을 **원자 그대로 반복**해
      // `scalars` 다중집합에 넣는다 (`x^2` → `[x, x]`). 이러면 `commonScalars`
      // (다중집합 교집합)가 자동으로 최소 지수를 뽑는다. 지수가 상수 정수 범위
      // 밖이면(심볼·음수·과대) 지금처럼 통째 원자.
      const n = constantInteger(e.exponent);
      if (n === null || n < 1 || n > MAX_POWER_EXPANSION) return ok([atom(e)]);
      return ok([{ numeric: ONE_LIT, scalars: Array(n).fill(e.base) as TypedExpr[], factors: [] }]);
    }

    case 'neg': {
      const inner = toPolynomial(e.operand);
      return inner.ok ? ok(inner.value.map(negate)) : inner;
    }

    case 'add': {
      const out: Monomial[] = [];
      for (const term of e.terms) {
        const p = toPolynomial(term);
        if (!p.ok) return p;
        out.push(...p.value);
      }
      return ok(out);
    }

    case 'scalarMul':
    case 'matMul': {
      // n-항 인수를 순서대로 곱해나간다. (scalarMul은 전부 스칼라 모양이라 폴딩 결과의
      // factors가 애초에 비지만, matMul은 안쪽에서 스칼라로 접히는 경우가 있어
      // collapseIfScalar가 필요하다 — `matMul(r,u)` 처럼 (1,3)(3,1)=(1,1)인 경우.)
      let acc: Polynomial = [ONE];
      for (const f of e.factors) {
        const p = toPolynomial(f);
        if (!p.ok) return p;
        acc = polyMul(acc, p.value);
      }
      return collapseIfScalar(acc, e.shape);
    }

    case 'mul': {
      const scalar = toPolynomial(e.scalar);
      if (!scalar.ok) return scalar;
      const matrix = toPolynomial(e.matrix);
      if (!matrix.ok) return matrix;
      return collapseIfScalar(polyMul(scalar.value, matrix.value), e.shape);
    }

    case 'dot':
    case 'cross': {
      // 결합법칙이 없는 연산이라 인수 열로 풀 수 없다. 대신 **분배는 된다** —
      // 각 항 쌍마다 연산을 하나씩 만들고, 스칼라 계수는 밖으로 빼낸다.
      const left = toPolynomial(e.left);
      if (!left.ok) return left;
      const right = toPolynomial(e.right);
      if (!right.ok) return right;
      const combine = e.op === 'dot' ? buildDot : buildCross;
      const out: Monomial[] = [];
      for (const p of left.value) {
        const pe = factorsToExpr(p);
        if (!pe.ok) return pe;
        for (const q of right.value) {
          const qe = factorsToExpr(q);
          if (!qe.ok) return qe;
          const applied = combine(pe.value, qe.value);
          if (!applied.ok) return applied;
          // 계수를 못 곱하면 접지 않고 인수로 되돌린다 (`polyMul` 과 같은 규약).
          const product = mulLit(p.numeric, q.numeric);
          const numeric = product ?? ONE_LIT;
          const carried =
            product !== null ? [] : [buildNum(p.numeric), buildNum(q.numeric)];
          const scalars = sortScalars([...p.scalars, ...q.scalars, ...carried]);
          out.push(
            OP_PROPERTIES[e.op].yieldsScalar
              ? { numeric, scalars: sortScalars([...scalars, applied.value]), factors: [] }
              : { numeric, scalars, factors: [applied.value] },
          );
        }
      }
      return ok(out);
    }

    case 'transpose': {
      // `(A+B)^T = A^T + B^T`, `(aA)^T = a A^T` — 스칼라 계수는 전치의 영향을 받지 않는다.
      const inner = toPolynomial(e.operand);
      if (!inner.ok) return inner;
      const out: Monomial[] = [];
      for (const m of inner.value) {
        const body = factorsToExpr(m);
        if (!body.ok) return body;
        const t = buildTranspose(body.value);
        if (!t.ok) return t;
        out.push({ numeric: m.numeric, scalars: m.scalars, factors: [t.value] });
      }
      return ok(out);
    }

    case 'matPow': {
      // `(A+B)²` 를 풀어써야 expand가 뜻대로 동작한다. 음수·과대 지수, 그리고 **값이
      // 확정되지 않은 지수**(`A^n`)는 접은 채로 둔다.
      const n = constantInteger(e.exponent);
      if (n === null || n < 1 || n > MAX_POWER_EXPANSION) return ok([atom(e)]);
      const base = toPolynomial(e.base);
      if (!base.ok) return base;
      let acc: Polynomial = [ONE];
      for (let i = 0; i < n; i += 1) acc = polyMul(acc, base.value);
      return ok(acc);
    }
  }
}

// ---------------------------------------------------------------------------
// 되돌리기 — Polynomial -> TypedExpr
// ---------------------------------------------------------------------------

/**
 * 단항식 하나를 식으로. 부호는 밖에서 `neg` 로 붙이므로 여기서는 절댓값만 쓴다.
 *
 * **이웃한 같은 인수를 `matPow` 로 접지 않는다** — `m.factors` 를 그대로 곱해나간다.
 * `AA` 는 `AA` 로 남는다.
 */
function monomialToExpr(m: Monomial): Result<TypedExpr> {
  const { magnitude } = splitSign(m.numeric);
  const parts: TypedExpr[] = [];
  const body = [...m.scalars, ...m.factors];
  if (!isOne(magnitude) || body.length === 0) parts.push(buildNum(magnitude));
  parts.push(...body);
  return parts
    .slice(1)
    .reduce<Result<TypedExpr>>((acc, p) => (acc.ok ? buildMul(acc.value, p) : acc), ok(parts[0]));
}

/**
 * 항이 전부 상쇄됐을 때의 값.
 *
 * 스칼라 `0` 으로 뭉뚱그리지 않고 **모양에 맞는 영행렬**을 낸다. 그러지 않으면 `A-A` 가
 * 스칼라가 되어 `\left(A-A\right)+B` 같은 합성이 "행렬+스칼라" 오류로 막힌다 —
 * 재작성이 식의 모양을 바꿔선 안 된다는 원칙이 깨지는 자리다.
 */
function zeroOf(target: Shape): TypedExpr {
  if (isScalar(target)) return buildNum(ZERO_LIT);
  if (!isKnownShape(target)) return buildNum(ZERO_LIT);
  const rows = Array.from({ length: target.rows as number }, () =>
    Array.from({ length: target.cols as number }, () => buildNum(ZERO_LIT)),
  );
  return { op: 'matrix', shape: target, rows };
}

/**
 * 다항식 -> 식.
 *
 * `target` 은 원래 식의 모양이다. 전부 상쇄됐을 때 어떤 영(zero)을 낼지 정하는 데만 쓴다.
 */
export function fromPolynomial(p: Polynomial, target: Shape = SCALAR): Result<TypedExpr> {
  const live = p.filter((m) => !isZero(m.numeric));
  if (live.length === 0) return ok(zeroOf(target));

  const terms: TypedExpr[] = [];
  for (const m of live) {
    const built = monomialToExpr(m);
    if (!built.ok) return built;
    terms.push(
      splitSign(m.numeric).negative
        ? { op: 'neg', shape: built.value.shape, operand: built.value }
        : built.value,
    );
  }
  return buildAdd(terms);
}
