import {
  addTyped,
  crossTyped,
  dotTyped,
  fracTyped,
  transposeTyped,
} from './elaborate';
import { exprKey, sortScalars } from './normal';
import { fail, ok, type Result } from '../types-Result';
import { SCALAR, isKnownShape, isScalar, isSquare, shape, type Shape } from '../types-shape';
import type { TypedExpr } from '../types-TypedExpr';

/**
 * Normalize — elaborate가 둘씩만 담아둔 곱을 대수적으로 정리하는 별도 패스.
 *
 * elaborate는 **모양을 알아야만 할 수 있는 판정**(연산 해석·차원 검사)만 하고, 곱을
 * 정규화 없이 그대로 중첩해 둔다 (`A(BC)` → `matMul(A, matMul(B,C))`). 이 파일은 그
 * 결과를 받아 **모양을 몰라도 되는 순수 대수 규칙**을 적용한다:
 *
 *  1. 평탄화 — 중첩된 `scalarMul`/`matMul` 을 하나의 n-항 목록으로 편다
 *  2. 스칼라 끌어올리기 — `dot`/`cross`/`transpose`/곱을 뚫고 스칼라를 최상단으로
 *  3. `neg` 흡수 — 부호를 스칼라 계수의 부호로 바꾼다
 *  4. 숫자 접기 + 정렬 — 숫자 리터럴을 하나로 묶어 맨 앞에, 나머지 스칼라는 `exprKey` 순
 *  5. 항등원 제거 — 인수 열에서 `I` 를 걷어낸다
 *  6. 축약 — 1원소 `scalarMul`/`matMul` 은 그 원소 자체로
 *
 * `parse()` 가 elaborate 직후 이 함수를 호출하므로, 공개 API를 거친 트리는 항상
 * 정규화돼 있다. `matPow` 의 밑은 일부러 뚫지 않는다 — `(kA)^2` 을 `k^2A^2` 으로
 * 바꾸려면 지수가 스칼라 거듭제곱까지 만들어야 해서 범위 밖으로 남겨둔다.
 *
 * **거듭제곱 접기는 기본으로 꺼져 있다.** `parse`/`expand`/`factor`/`substitute` 는
 * 사용자가 쓴 곱의 모양을 임의로 바꾸지 않는다 — `AA` 는 `AA` 로 남는다. `simplify` 만
 * `foldPowers=true` 로 이 함수를 불러서 이웃한 같은 인수를 `matPow` 로 접고
 * (`AAAA` → `A⁴`), 지수 합이 0이 되는 소거(`AA^{-1}` → `I`)까지 한다 — "정리하라"는
 * 요청에서는 이게 자연스러운 기대이기 때문. `A^2` 처럼 직접 쓴 거듭제곱은 항상 그대로다.
 */

// ---------------------------------------------------------------------------
// collect — 곱 계열 노드를 (숫자, 스칼라 인수들, 비스칼라 인수들) 로 분해한다
// ---------------------------------------------------------------------------

type Collected = {
  readonly numeric: number;
  /** 스칼라 인수 — 아직 정렬 전. */
  readonly scalars: readonly TypedExpr[];
  /** 비스칼라 인수 — **순서가 의미**, 절대 정렬하지 않는다. */
  readonly matrix: readonly TypedExpr[];
};

/**
 * **이미 normalize를 거친** 자식 노드를 분해한다.
 *
 * `scalarMul`/`matMul`/`mul`/`neg` 를 재귀적으로 뚫고 들어가는 게 요점이다 — 그래야
 * `mul(k, mul(j, A))` 같은 중첩(nested mul-in-mul)이나 `matMul(neg(A), B)` 처럼
 * elaborate가 그대로 남겨둔 부호가 최상단까지 올라온다. 그 외의 노드(sym, add,
 * transpose, matPow, call 등)는 모양만 보고 스칼라/비스칼라 원자 하나로 취급한다 —
 * `add` 에서 멈추는 것도 이 default 분기가 처리한다.
 */
function collect(e: TypedExpr): Collected {
  switch (e.op) {
    case 'num':
      return { numeric: e.value, scalars: [], matrix: [] };

    case 'neg': {
      const c = collect(e.operand);
      return { numeric: -c.numeric, scalars: c.scalars, matrix: c.matrix };
    }

    case 'scalarMul': {
      let numeric = 1;
      const scalars: TypedExpr[] = [];
      for (const f of e.factors) {
        const c = collect(f);
        numeric *= c.numeric;
        scalars.push(...c.scalars);
      }
      return { numeric, scalars, matrix: [] };
    }

    case 'matMul': {
      // `matMul` 이라고 해서 늘 비스칼라는 아니다 — `v^Tv` 는 (1,3)(3,1)=(1,1) 로
      // op는 matMul이지만 모양은 스칼라다(설계: 모든 것이 (rows,cols), (1,1)이 스칼라).
      // 이럴 땐 안을 열지 않고 **통째로 스칼라 원자 하나**로 취급해야 한다 — 안을 열면
      // 그 안의 인수들이 바깥 matMul의 인수 열에 잘못 이어붙어 차원이 깨진다.
      if (isScalar(e.shape)) return { numeric: 1, scalars: [e], matrix: [] };

      let numeric = 1;
      const scalars: TypedExpr[] = [];
      const matrix: TypedExpr[] = [];
      for (const f of e.factors) {
        const c = collect(f);
        numeric *= c.numeric;
        scalars.push(...c.scalars);
        matrix.push(...c.matrix);
      }
      return { numeric, scalars, matrix };
    }

    case 'mul': {
      const s = collect(e.scalar);
      const m = collect(e.matrix);
      return { numeric: s.numeric * m.numeric, scalars: [...s.scalars, ...m.scalars], matrix: m.matrix };
    }

    case 'matIdentity':
      // (1,1) 로 굳은 항등원은 스칼라 1과 같다 — 인수로 남기면 안 된다. 안 그러면
      // `pI` 가 `p` 로 안 줄고 `mul(I,p)` 로 남는다(퍼즈로 확인). 아직 비스칼라 크기로
      // 확정된 항등원(문맥에서 진짜 행렬로 쓰일 예정인 경우)은 그대로 원자로 둔다.
      return isScalar(e.shape) ? { numeric: 1, scalars: [], matrix: [] } : { numeric: 1, scalars: [], matrix: [e] };

    default:
      return isScalar(e.shape)
        ? { numeric: 1, scalars: [e], matrix: [] }
        : { numeric: 1, scalars: [], matrix: [e] };
  }
}

// ---------------------------------------------------------------------------
// 되돌리기 — collect의 결과를 다시 트리로
// ---------------------------------------------------------------------------

const numAtom = (value: number): TypedExpr => ({ op: 'num', shape: SCALAR, value });

/** 두 non-scalar 인수 목록을 이어 붙였을 때의 모양. 결합법칙이 있어 인접 쌍만 맞으면 되고, elaborate가 이미 그 사슬 전체를 검증해뒀다. */
const matMulShapeOf = (factors: readonly TypedExpr[]): Shape =>
  shape(factors[0].shape.rows, factors[factors.length - 1].shape.cols);

/**
 * 인수 열에서 항등원을 걷어낸다. 이웃한 같은 인수를 `matPow` 로 접지는 않는다 —
 * `AA` 는 `AA` 로 남는다. `foldPowers=false` 경로(parse/expand/factor/substitute)가 쓴다.
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
 * 인수 하나를 (밑, 지수)로 뜯는다. 벌거벗은 인수는 지수 1인 셈이다.
 *
 * `matPow` 는 **어떤 정수 지수든** 뜯는다 — 음수(역행렬)도 포함이라야
 * `A \cdot A^{-1}` 처럼 이웃한 지수를 더해서 소거(항등원)까지 갈 수 있다.
 */
function powerParts(f: TypedExpr): { readonly base: TypedExpr; readonly exponent: number } {
  return f.op === 'matPow' ? { base: f.base, exponent: f.exponent } : { base: f, exponent: 1 };
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
    const key = exprKey(first.base);
    let totalExponent = first.exponent;
    let run = 1;
    while (i + run < factors.length) {
      const next = powerParts(factors[i + run]);
      if (exprKey(next.base) !== key) break;
      totalExponent += next.exponent;
      run += 1;
    }
    if (run > 1 && isSquare(first.base.shape)) {
      if (totalExponent === 0) {
        out.push({ op: 'matIdentity', shape: first.base.shape });
      } else if (totalExponent === 1) {
        out.push(first.base);
      } else {
        out.push({ op: 'matPow', shape: first.base.shape, base: first.base, exponent: totalExponent });
      }
    } else {
      out.push(factors[i]);
    }
    i += run;
  }
  return out;
}

/**
 * **이웃한, 같은 밑을 가진** 인수들의 지수를 더해 하나의 `matPow` 로 접는다. 항등원도
 * 여기서 걷어낸다. `foldPowers=true` 경로(`simplify`)만 쓴다.
 *
 * `matPow(C,2)` 와 벌거벗은 `C` 처럼 **표현은 달라도 밑이 같은** 경우까지 합쳐야 한다 —
 * 그러지 않으면 `((C^2)^2)^T` 를 simplify한 뒤에도 `C^2 C^2` 에서 멈추고 `C^4` 까지 못
 * 간다. `ABA` 의 두 `A` 는 붙어 있지 않으므로 여전히 안 합쳐진다 — 이웃 검사 자체는 그대로다.
 *
 * **항등원을 먼저 버리고 나서 지수를 합친다** — `AIA` 는 `I` 를 지우면 두 `A` 가
 * 이웃해져 `A²` 로 접힌다. 나중에 버리면 이 기회를 놓친다. 합치는 과정에서 지수 합이
 * 0이 되어 **새 항등원이 생길 수도** 있으므로(`AA^{-1} → I`), 더 걸러낼 게 없어질
 * 때까지 반복한다(`AA^{-1}B` → 걸러낼 것 없음 → 합치기로 `[I,B]` → 다시 걸러 `[B]`).
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
 * `collect` 의 결과를 다시 식으로 조립한다.
 *
 * 부호는 **숫자 계수 안에 넣지 않고 바깥에 `neg` 로 씌운다** — `numeric=-1` 을 그대로
 * 스칼라 인수 목록에 넣으면 다른 인수가 있을 때 `-1A` 처럼 불필요한 "1" 이 남는다.
 * (`normal.ts`의 `monomialToExpr`/`fromPolynomial` 과 같은 관례.)
 */
function buildProduct(
  numeric: number,
  scalars: readonly TypedExpr[],
  matrixFactors: readonly TypedExpr[],
  foldPowers: boolean,
): TypedExpr {
  const magnitude = Math.abs(numeric);
  const sortedScalars = sortScalars(scalars);
  const collapsedMatrix = foldPowers ? foldAdjacentPowers(matrixFactors) : stripIdentities(matrixFactors);

  const matrixNode: TypedExpr | null =
    collapsedMatrix.length === 0
      ? null
      : collapsedMatrix.length === 1
        ? collapsedMatrix[0]
        : { op: 'matMul', shape: matMulShapeOf(collapsedMatrix), factors: collapsedMatrix };

  // 숫자 리터럴은 크기가 1이 아니거나, 다른 항이 전혀 없어 "1" 자체를 나타내야 할 때만 넣는다.
  const needsNumericLiteral = magnitude !== 1 || (sortedScalars.length === 0 && matrixNode === null);
  const scalarParts = needsNumericLiteral ? [numAtom(magnitude), ...sortedScalars] : sortedScalars;

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

  return numeric < 0 ? { op: 'neg', shape: core.shape, operand: core } : core;
}

/**
 * 이미 정규화된 non-scalar 인수 목록 하나를 단일 식으로 (호출자가 dot/cross/transpose에
 * 넘기기 위해).
 *
 * **목록이 비어 있으면 오류다** — dot/cross/transpose는 원래 비스칼라 피연산자를
 * 요구하는데, 그 피연산자가 (예: 문맥 없이 쓴 `I` 처럼) 끝내 스칼라로 굳어버려 안이
 * 통째로 비는 경우다. 조용히 뭔가를 지어내는 대신 정직하게 오류를 낸다.
 */
function asSingleMatrix(factors: readonly TypedExpr[]): Result<TypedExpr> {
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
// 본체
// ---------------------------------------------------------------------------

/**
 * Typed IR을 받아 평탄화·스칼라 호이스팅·정렬·항등원 제거를 적용한 Typed IR을 낸다.
 *
 * `foldPowers` 가 `true` 면 이웃한 같은 인수를 `matPow` 로 더 접는다 (`simplify` 전용,
 * 파일 서두 참고). 기본은 `false` — parse/expand/factor/substitute는 곱의 모양을
 * 그대로 둔다.
 */
export function normalize(e: TypedExpr, foldPowers = false): Result<TypedExpr> {
  switch (e.op) {
    case 'num':
    case 'sym':
      return ok(e);

    // 끝까지 아무도 크기를 알려주지 않은 항등원은 (1,1)로 굳힌다 — I 혼자 쓰면 스칼라
    // 1과 같다는 뜻.
    case 'matIdentity':
      return ok(isKnownShape(e.shape) ? e : { op: 'matIdentity', shape: SCALAR });

    case 'matrix': {
      const rows: TypedExpr[][] = [];
      for (const row of e.rows) {
        const newRow: TypedExpr[] = [];
        for (const cell of row) {
          const r = normalize(cell, foldPowers);
          if (!r.ok) return r;
          newRow.push(r.value);
        }
        rows.push(newRow);
      }
      return ok({ op: 'matrix', shape: e.shape, rows });
    }

    case 'add': {
      const terms: TypedExpr[] = [];
      for (const term of e.terms) {
        const r = normalize(term, foldPowers);
        if (!r.ok) return r;
        terms.push(r.value);
      }
      return addTyped(terms);
    }

    case 'neg': {
      const inner = normalize(e.operand, foldPowers);
      if (!inner.ok) return inner;
      const c = collect(inner.value);
      return ok(buildProduct(-c.numeric, c.scalars, c.matrix, foldPowers));
    }

    case 'scalarMul':
    case 'matMul':
    case 'mul': {
      let children: readonly TypedExpr[];
      if (e.op === 'mul') {
        const s = normalize(e.scalar, foldPowers);
        if (!s.ok) return s;
        const m = normalize(e.matrix, foldPowers);
        if (!m.ok) return m;
        children = [s.value, m.value];
      } else {
        const normed: TypedExpr[] = [];
        for (const f of e.factors) {
          const r = normalize(f, foldPowers);
          if (!r.ok) return r;
          normed.push(r.value);
        }
        children = normed;
      }

      let numeric = 1;
      const scalars: TypedExpr[] = [];
      const matrixFactors: TypedExpr[] = [];
      for (const child of children) {
        const c = collect(child);
        numeric *= c.numeric;
        scalars.push(...c.scalars);
        matrixFactors.push(...c.matrix);
      }
      return ok(buildProduct(numeric, scalars, matrixFactors, foldPowers));
    }

    case 'dot':
    case 'cross': {
      const leftR = normalize(e.left, foldPowers);
      if (!leftR.ok) return leftR;
      const rightR = normalize(e.right, foldPowers);
      if (!rightR.ok) return rightR;
      const cl = collect(leftR.value);
      const cr = collect(rightR.value);

      const leftCore = asSingleMatrix(cl.matrix);
      if (!leftCore.ok) return leftCore;
      const rightCore = asSingleMatrix(cr.matrix);
      if (!rightCore.ok) return rightCore;
      const combine = e.op === 'dot' ? dotTyped : crossTyped;
      const core = combine(leftCore.value, rightCore.value);
      if (!core.ok) return core;
      const merged = collect(core.value);

      return ok(
        buildProduct(
          cl.numeric * cr.numeric * merged.numeric,
          [...cl.scalars, ...cr.scalars, ...merged.scalars],
          merged.matrix,
          foldPowers,
        ),
      );
    }

    case 'transpose': {
      const inner = normalize(e.operand, foldPowers);
      if (!inner.ok) return inner;
      const c = collect(inner.value);
      const operand = asSingleMatrix(c.matrix);
      if (!operand.ok) return operand;
      const t = transposeTyped(operand.value);
      if (!t.ok) return t;
      return ok(buildProduct(c.numeric, c.scalars, [t.value], foldPowers));
    }

    // `matPow`의 밑은 일부러 뚫지 않는다 — `(kA)^n` 을 `k^n A^n` 으로 바꾸려면 지수가
    // 스칼라 거듭제곱까지 새로 만들어야 해서 이번 범위 밖이다 (설계 §다음 라운드).
    case 'matPow': {
      const base = normalize(e.base, foldPowers);
      if (!base.ok) return base;
      // I^n = I.
      if (base.value.op === 'matIdentity') return ok(base.value);
      return ok({ op: 'matPow', shape: e.shape, base: base.value, exponent: e.exponent });
    }

    case 'scalarPow': {
      const base = normalize(e.base, foldPowers);
      if (!base.ok) return base;
      const exponent = normalize(e.exponent, foldPowers);
      if (!exponent.ok) return exponent;
      return ok({ op: 'scalarPow', shape: SCALAR, base: base.value, exponent: exponent.value });
    }

    case 'call': {
      const args: TypedExpr[] = [];
      for (const a of e.args) {
        const r = normalize(a, foldPowers);
        if (!r.ok) return r;
        args.push(r.value);
      }
      return ok({ op: 'call', shape: SCALAR, name: e.name, args });
    }

    case 'frac': {
      const numerator = normalize(e.numerator, foldPowers);
      if (!numerator.ok) return numerator;
      const denominator = normalize(e.denominator, foldPowers);
      if (!denominator.ok) return denominator;
      return fracTyped(numerator.value, denominator.value);
    }
  }
}
