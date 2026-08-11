import {
  buildAdd,
  buildCross,
  buildDot,
  buildMul,
  buildNum,
  buildTranspose,
  matMulShapeOf,
} from '../expression/builders';
import { OP_PROPERTIES } from '../opers';
import { asKnownInteger, exprKey, sortScalars } from '../expression/key';
import { fail, ok, type Result } from '../result/result';
import { SCALAR, isKnownShape, isScalar, type Shape } from '../shape/shape';
import type { TypedExpr } from '../expression/node';
import {
  intLit,
  isOne,
  isZero,
  splitSign,
  ONE as ONE_LIT,
  ZERO as ZERO_LIT,
} from '../literal/literal';
import { mulLit } from '../literal/arith';
import {
  MAX_POWER_EXPANSION,
  ONE,
  leafToMonomial,
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
    if (m.nonScalars.length === 0) {
      out.push(m);
      continue;
    }
    const folded = factorsToExpr(m);
    if (!folded.ok) return folded;
    out.push({
      coefficient: m.coefficient,
      scalars: sortScalars([...m.scalars, folded.value]),
      nonScalars: [],
    });
  }
  return ok(out);
}

/** 단항식의 **비스칼라 부분만** 하나의 식으로 되돌린다 (내적/외적의 피연산자를 만들 때 쓴다). */
function factorsToExpr(m: Monomial): Result<TypedExpr> {
  if (m.nonScalars.length === 0) return fail('malformed', 'Expected a non-scalar operand');
  return m.nonScalars
    .slice(1)
    .reduce<Result<TypedExpr>>(
      (acc, f) => (acc.ok ? buildMul(acc.value, f) : acc),
      ok(m.nonScalars[0]),
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
      return ok([{ coefficient: e.value, scalars: [], nonScalars: [] }]);

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
      return ok([leafToMonomial(e)]);

    case 'scalarPow': {
      // `matPow` 와 달리 **밑은 다항식으로 펼치지 않는다** — `(x+1)^2` 를 분배하면
      // expand/simplify의 기존 동작이 흔들린다. 여기서 필요한 건 딱 하나, 공통인수
      // 추출이 `x^2` 와 `x` 를 잇게 하는 것뿐이라 밑을 **원자 그대로 반복**해
      // `scalars` 다중집합에 넣는다 (`x^2` → `[x, x]`). 이러면 `commonScalars`
      // (다중집합 교집합)가 자동으로 최소 지수를 뽑는다. 지수가 상수 정수 범위
      // 밖이면(심볼·음수·과대) 지금처럼 통째 원자.
      const n = asKnownInteger(e.exponent);
      if (n === null || n < 1 || n > MAX_POWER_EXPANSION) return ok([leafToMonomial(e)]);
      return ok([{ coefficient: ONE_LIT, scalars: Array(n).fill(e.base) as TypedExpr[], nonScalars: [] }]);
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
      const matrix = toPolynomial(e.nonScalar);
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
          const product = mulLit(p.coefficient, q.coefficient);
          const coefficient = product ?? ONE_LIT;
          const carried =
            product !== null ? [] : [buildNum(p.coefficient), buildNum(q.coefficient)];
          const scalars = sortScalars([...p.scalars, ...q.scalars, ...carried]);
          out.push(
            OP_PROPERTIES[e.op].yieldsScalar
              ? { coefficient, scalars: sortScalars([...scalars, applied.value]), nonScalars: [] }
              : { coefficient, scalars, nonScalars: [applied.value] },
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
        out.push({ coefficient: m.coefficient, scalars: m.scalars, nonScalars: [t.value] });
      }
      return ok(out);
    }

    case 'matPow': {
      // `(A+B)²` 를 풀어써야 expand가 뜻대로 동작한다. 음수·과대 지수, 그리고 **값이
      // 확정되지 않은 지수**(`A^n`)는 접은 채로 둔다.
      const n = asKnownInteger(e.exponent);
      if (n === null || n < 1 || n > MAX_POWER_EXPANSION) return ok([leafToMonomial(e)]);
      const base = toPolynomial(e.base);
      if (!base.ok) return base;
      let acc: Polynomial = [ONE];
      for (let i = 0; i < n; i += 1) acc = polyMul(acc, base.value);
      return ok(acc);
    }
  }
}

// ---------------------------------------------------------------------------
// 되돌리기 ① — 인수 열 접기 (`fromMonomial(_, true)` 전용)
// ---------------------------------------------------------------------------

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
 * 하나도 안 남을 수 있는데, 그건 `fromMonomial` 의 `needsNumericLiteral` 이 `1` 로 채운다.
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
            const n = asKnownInteger(f.exponent);
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
  const n = asKnownInteger(f.exponent);
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

/**
 * 인수 열 **안에서** 앞 구간이 스칼라로 접히면 거기서 끊어 스칼라 쪽으로 옮긴다.
 *
 * `r u r` 을 보자 (`r`=(1,3), `u`=(3,1)). 전체 모양은 (1,3)이라 비스칼라지만 **앞의 두
 * 개가 (1,1)로 접힌다.** 그대로 `matMul(r,u,r)` 로 조립하면 렌더가 `rur` 인데, 그걸 다시
 * 읽으면 elaborate가 왼쪽부터 묶어 `(ru)r` = `mul(스칼라, r)` 이 되어 **같은 값이 다른
 * 트리·다른 LaTeX**(`2\left(ru\right)kr`)이 된다 — 렌더 멱등이 깨진다(퍼즈가 잡음).
 *
 * `toMonomial` 이 주는 인수 열에는 이런 구간이 안 생긴다(스칼라로 접히는 `matMul` 은
 * 통째로 스칼라 원자 하나로 잡는다). 하지만 다항식 쪽 `polyMul` 은 인수 열을 그냥
 * 이어붙이므로 생길 수 있다. 예전 `monomialToExpr` 은 `buildMul` 좌결합 접기라 쌍마다
 * 모양을 다시 봐서 이걸 우연히 피해갔다 — 평탄 조립으로 합치면서 명시적으로 해줘야 한다.
 *
 * 끊은 구간은 스칼라 인수가 되므로 **정렬 전에** 불러야 한다.
 */
function splitScalarRuns(factors: readonly TypedExpr[]): {
  readonly collapsed: readonly TypedExpr[];
  readonly rest: readonly TypedExpr[];
} {
  const collapsed: TypedExpr[] = [];
  const rest: TypedExpr[] = [];
  let run: TypedExpr[] = [];
  for (const f of factors) {
    run.push(f);
    // 인수 하나짜리는 건드리지 않는다 — 비스칼라 자리에 스칼라가 홀로 있다면 그건 여기서
    // 고칠 문제가 아니라 인수 열을 만든 쪽의 문제다.
    if (run.length > 1 && isScalar(matMulShapeOf(run))) {
      collapsed.push({ op: 'matMul', shape: matMulShapeOf(run), factors: run });
      run = [];
    }
  }
  rest.push(...run);
  return { collapsed, rest };
}

// ---------------------------------------------------------------------------
// 되돌리기 ② — Monomial -> TypedExpr
// ---------------------------------------------------------------------------

/**
 * 단항식 하나를 식으로. `toMonomial`(`normalize/product.ts`)의 짝이다.
 *
 * **조립기는 이 하나뿐이다.** 예전엔 여기(`monomialToExpr`)와 정규화 쪽(`fromMonomial`)에
 * 두 벌이 있었는데, 하나는 좌결합 `buildMul` 접기, 하나는 n-항 직접 조립이라 **같은 값이
 * 경로에 따라 다른 트리로** 나왔다. 다항식 쪽이 제 타입(`Monomial`)을 가진 집이라 여기로
 * 합쳤다.
 *
 * 부호는 **숫자 계수 안에 넣지 않고 바깥에 `neg` 로 씌운다** — `coefficient=-1` 을 그대로
 * 스칼라 인수 목록에 넣으면 다른 인수가 있을 때 `-1A` 처럼 불필요한 "1" 이 남는다.
 * (`render.ts` 의 `renderProduct` 도 같은 관례를 읽는다.)
 *
 * `foldPowers` 가 갈라놓는 것은 **거듭제곱 접기뿐**이다:
 *  - `true` (정규화 경로) — `AA` → `A²`, `xxy` → `x²y`, `AA^{-1}` → `I` 까지 간다
 *  - `false` (다항식 경로) — 항등원만 걷어내고 `AA` 는 `AA` 로 둔다. 인수분해가 공통
 *    인수를 뽑으려면 `x^2` 이 `[x, x]` 로 흩어진 채여야 해서다 (`toPolynomial` 의
 *    `scalarPow` 케이스 참고).
 *
 * 실패할 수 없다 — 인수 열의 모양은 호출 전에 이미 검증돼 있고(`matMulShapeOf` 문서),
 * 노드는 직접 만든다.
 */
export function fromMonomial(m: Monomial, foldPowers: boolean): TypedExpr {
  const { negative, magnitude } = splitSign(m.coefficient);
  const folded = foldPowers ? foldAdjacentPowers(m.nonScalars) : stripIdentities(m.nonScalars);
  const { collapsed, rest: nonScalars } = splitScalarRuns(folded);

  const allScalars = collapsed.length === 0 ? m.scalars : [...m.scalars, ...collapsed];
  const scalars = sortScalars(foldPowers ? foldScalarPowers(allScalars) : allScalars);

  const matrixNode: TypedExpr | null =
    nonScalars.length === 0
      ? null
      : nonScalars.length === 1
        ? nonScalars[0]
        : { op: 'matMul', shape: matMulShapeOf(nonScalars), factors: nonScalars };

  // 숫자 리터럴은 크기가 1이 아니거나, 다른 항이 전혀 없어 "1" 자체를 나타내야 할 때만 넣는다.
  const needsNumericLiteral = !isOne(magnitude) || (scalars.length === 0 && matrixNode === null);
  const scalarParts = needsNumericLiteral ? [buildNum(magnitude), ...scalars] : scalars;

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
        : { op: 'mul', shape: matrixNode.shape, scalar: scalarNode, nonScalar: matrixNode };

  return negative ? { op: 'neg', shape: core.shape, operand: core } : core;
}

// ---------------------------------------------------------------------------
// 되돌리기 ③ — Polynomial -> TypedExpr
// ---------------------------------------------------------------------------

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
  const live = p.filter((m) => !isZero(m.coefficient));
  if (live.length === 0) return ok(zeroOf(target));
  // 다항식 경로는 접지 않는다 — 인수분해가 `x^2` 을 `[x, x]` 로 흩어진 채 봐야 한다.
  return buildAdd(live.map((m) => fromMonomial(m, false)));
}
