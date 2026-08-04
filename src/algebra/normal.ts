import {
  addTyped,
  crossTyped,
  dotTyped,
  mulTyped,
  transposeTyped,
  type TypedExpr,
} from './elaborate';
import { OP_PROPERTIES } from './opers';
import { fail, ok, type Result } from './types-result';
import { SCALAR, formatShape, isKnownShape, isScalar, type Shape } from './types-shape';

/**
 * 정규형 — **단항식 = (수치 계수, 스칼라 인수 집합, 비스칼라 인수 열)**.
 *
 * 이 표현 하나가 expand/simplify/factor를 동시에 건전하게 만든다:
 *  - 스칼라 인수는 교환 가능하므로 **집합처럼** 다뤄 정렬한다 (동류항 판정이 쉬워진다)
 *  - 비스칼라 인수는 교환 불가이므로 **열의 순서를 그대로** 유지한다
 *    → `ABA` 와 `A²B` 는 다른 키를 갖는다. 여기가 교환법칙 오적용을 막는 지점이다.
 *  - 동류항 ⇔ (스칼라 인수 집합, 비스칼라 인수 열)이 **완전히 같음**
 *
 * 인수 열로 평탄화해도 되는 근거는 `ops.ts` 의 결합법칙 항목이다. 결합법칙이 없는
 * 외적은 평탄화하지 않고 **통째로 인수 하나**로 남긴다 (`(u×v)×w ≠ u×(v×w)`).
 */

export type Monomial = {
  readonly numeric: number;
  /** 스칼라 인수 — 교환 가능하므로 키 기준으로 정렬해 정규화한다. */
  readonly scalars: readonly TypedExpr[];
  /** 비스칼라 인수 — **순서가 의미다.** 절대 정렬하지 않는다. */
  readonly factors: readonly TypedExpr[];
};

export type Polynomial = readonly Monomial[];

/** `(A+B)^n` 을 풀어쓸 상한. 이보다 크면 접은 채로 둔다 (항이 폭발한다). */
const MAX_POWER_EXPANSION = 6;

// ---------------------------------------------------------------------------
// 구조 키 — 동류항 판정의 근거
// ---------------------------------------------------------------------------

/**
 * 구조적 동일성 키.
 *
 * `debug.ts` 의 s-식과 모양이 비슷하지만 **일부러 따로 둔다** — 저건 사람이 읽는 출력이라
 * 언제든 바뀔 수 있고, 이건 동류항 판정이 걸린 의미 계약이다.
 */
export function exprKey(e: TypedExpr): string {
  switch (e.op) {
    case 'num':
      return `n${String(e.value)}`;
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
      return `P(${exprKey(e.base)},${String(e.exponent)})`;
    case 'scalarPow':
      return `p(${exprKey(e.base)},${exprKey(e.exponent)})`;
    case 'call':
      return `${e.name}(${e.args.map(exprKey).join(',')})`;
    case 'frac':
      return `f(${exprKey(e.numerator)},${exprKey(e.denominator)})`;
    case 'matIdentity':
      return `I(${formatShape(e.shape)})`;
  }
}

/** 동류항 키 — 수치 계수는 뺀다 (그게 합쳐질 대상이므로). */
export const monomialKey = (m: Monomial): string =>
  `${m.scalars.map(exprKey).join('*')}|${m.factors.map(exprKey).join('*')}`;

// ---------------------------------------------------------------------------
// 전개 — TypedExpr -> Polynomial
// ---------------------------------------------------------------------------

/**
 * 스칼라 인수를 정렬한다. 스칼라는 교환 가능하므로 순서를 고정해도 되고, 고정해야
 * 동류항 키가 안정된다 (`ab` 와 `ba` 가 같은 항으로 잡히려면).
 */
export const sortScalars = (scalars: readonly TypedExpr[]): TypedExpr[] =>
  [...scalars].sort((a, b) => (exprKey(a) < exprKey(b) ? -1 : exprKey(a) > exprKey(b) ? 1 : 0));

const ONE: Monomial = { numeric: 1, scalars: [], factors: [] };

/** 잎 하나를 단항식으로. 모양이 결정한다: 스칼라면 계수 쪽, 아니면 인수 열 쪽. */
const atom = (e: TypedExpr): Monomial =>
  isScalar(e.shape)
    ? { numeric: 1, scalars: [e], factors: [] }
    : { numeric: 1, scalars: [], factors: [e] };

const negate = (m: Monomial): Monomial => ({ ...m, numeric: -m.numeric });

/**
 * 두 다항식의 곱. **인수 열을 이어붙이기만 하고 재배열하지 않는다** —
 * 행렬곱은 결합법칙은 있지만(그래서 이어붙일 수 있고) 교환법칙은 없다(그래서 순서를 지킨다).
 */
function polyMul(left: Polynomial, right: Polynomial): Polynomial {
  const out: Monomial[] = [];
  for (const p of left) {
    for (const q of right) {
      out.push({
        numeric: p.numeric * q.numeric,
        scalars: sortScalars([...p.scalars, ...q.scalars]),
        factors: [...p.factors, ...q.factors],
      });
    }
  }
  return out;
}

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
      (acc, f) => (acc.ok ? mulTyped(acc.value, f) : acc),
      ok(m.factors[0]),
    );
}

/**
 * TypedExpr -> 다항식. 곱을 합 위로 **완전히 분배**한다.
 *
 * 분배가 허용되는 근거는 `ops.ts` 의 `distributesOverAdd` 다 (현재 이항 연산 넷 모두 참).
 */
export function toPolynomial(e: TypedExpr): Result<Polynomial> {
  switch (e.op) {
    case 'num':
      return ok([{ numeric: e.value, scalars: [], factors: [] }]);

    case 'sym':
    case 'matrix':
    case 'call':
    case 'scalarPow':
    case 'frac':
    case 'matIdentity':
      // 순수 스칼라 부분식은 CE 몫이라(§7) 여기서는 통째로 원자 취급한다.
      // matIdentity도 여기서는 그냥 원자다 — 소거는 normalize의 몫이다. `frac` 도
      // 나눗셈을 다항식으로 펼치지 않고 통째로 둔다 — 분배 여부는 CE 위임 몫이다.
      return ok([atom(e)]);

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
      const combine = e.op === 'dot' ? dotTyped : crossTyped;
      const out: Monomial[] = [];
      for (const p of left.value) {
        const pe = factorsToExpr(p);
        if (!pe.ok) return pe;
        for (const q of right.value) {
          const qe = factorsToExpr(q);
          if (!qe.ok) return qe;
          const applied = combine(pe.value, qe.value);
          if (!applied.ok) return applied;
          const scalars = sortScalars([...p.scalars, ...q.scalars]);
          const numeric = p.numeric * q.numeric;
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
        const t = transposeTyped(body.value);
        if (!t.ok) return t;
        out.push({ numeric: m.numeric, scalars: m.scalars, factors: [t.value] });
      }
      return ok(out);
    }

    case 'matPow': {
      // `(A+B)²` 를 풀어써야 expand가 뜻대로 동작한다. 음수·과대 지수는 접은 채로 둔다.
      if (e.exponent < 1 || e.exponent > MAX_POWER_EXPANSION) return ok([atom(e)]);
      const base = toPolynomial(e.base);
      if (!base.ok) return base;
      let acc: Polynomial = [ONE];
      for (let i = 0; i < e.exponent; i += 1) acc = polyMul(acc, base.value);
      return ok(acc);
    }
  }
}

// ---------------------------------------------------------------------------
// 되돌리기 — Polynomial -> TypedExpr
// ---------------------------------------------------------------------------

const num = (value: number): TypedExpr => ({ op: 'num', shape: SCALAR, value });

/**
 * 단항식 하나를 식으로. 부호는 밖에서 `neg` 로 붙이므로 여기서는 절댓값만 쓴다.
 *
 * **이웃한 같은 인수를 `matPow` 로 접지 않는다** — `m.factors` 를 그대로 곱해나간다.
 * `AA` 는 `AA` 로 남는다.
 */
function monomialToExpr(m: Monomial): Result<TypedExpr> {
  const magnitude = Math.abs(m.numeric);
  const parts: TypedExpr[] = [];
  const body = [...m.scalars, ...m.factors];
  if (magnitude !== 1 || body.length === 0) parts.push(num(magnitude));
  parts.push(...body);
  return parts
    .slice(1)
    .reduce<Result<TypedExpr>>((acc, p) => (acc.ok ? mulTyped(acc.value, p) : acc), ok(parts[0]));
}

/**
 * 항이 전부 상쇄됐을 때의 값.
 *
 * 스칼라 `0` 으로 뭉뚱그리지 않고 **모양에 맞는 영행렬**을 낸다. 그러지 않으면 `A-A` 가
 * 스칼라가 되어 `\left(A-A\right)+B` 같은 합성이 "행렬+스칼라" 오류로 막힌다 —
 * 재작성이 식의 모양을 바꿔선 안 된다는 원칙이 깨지는 자리다.
 */
function zeroOf(target: Shape): TypedExpr {
  if (isScalar(target)) return num(0);
  if (!isKnownShape(target)) return num(0);
  const rows = Array.from({ length: target.rows as number }, () =>
    Array.from({ length: target.cols as number }, () => num(0)),
  );
  return { op: 'matrix', shape: target, rows };
}

/**
 * 다항식 -> 식.
 *
 * `target` 은 원래 식의 모양이다. 전부 상쇄됐을 때 어떤 영(zero)을 낼지 정하는 데만 쓴다.
 */
export function fromPolynomial(p: Polynomial, target: Shape = SCALAR): Result<TypedExpr> {
  const live = p.filter((m) => m.numeric !== 0);
  if (live.length === 0) return ok(zeroOf(target));

  const terms: TypedExpr[] = [];
  for (const m of live) {
    const built = monomialToExpr(m);
    if (!built.ok) return built;
    terms.push(
      m.numeric < 0 ? { op: 'neg', shape: built.value.shape, operand: built.value } : built.value,
    );
  }
  return addTyped(terms);
}

/**
 * 스칼라 인수로 섞여 들어온 순수 숫자를 수치 계수로 흡수한다.
 *
 * CE가 `3^2` 를 `9` 로 정리해 돌려주면 그 `9` 는 스칼라 인수 자리에 앉는다. 그대로 두면
 * 계수 `3` 과 인수 `9` 가 나란히 렌더돼 `3\cdot 9…` 같은 게 나오고, `\cdot` 는 병치보다
 * 느슨해서 다시 읽을 때 묶음이 달라진다. 애초에 하나로 합치는 게 맞다.
 */
export function foldNumericScalars(p: Polynomial): Polynomial {
  return p.map((m) => {
    let numeric = m.numeric;
    const scalars: TypedExpr[] = [];
    for (const s of m.scalars) {
      if (s.op === 'num') numeric *= s.value;
      else scalars.push(s);
    }
    return { numeric, scalars, factors: m.factors };
  });
}

/** 같은 인수 열을 가진 항들을 합친다. 순서는 처음 나온 순서를 유지한다. */
export function combineLikeTerms(p: Polynomial): Polynomial {
  const order: string[] = [];
  const byKey = new Map<string, Monomial>();
  for (const m of p) {
    const key = monomialKey(m);
    const existing = byKey.get(key);
    if (existing === undefined) {
      order.push(key);
      byKey.set(key, m);
    } else {
      byKey.set(key, { ...existing, numeric: existing.numeric + m.numeric });
    }
  }
  return order.map((key) => byKey.get(key) as Monomial);
}
