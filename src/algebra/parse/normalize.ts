import {
  addTyped,
  crossTyped,
  derivTyped,
  dotTyped,
  fracTyped,
  integralTyped,
  mulTyped,
  prodTyped,
  sumTyped,
  transposeTyped,
} from './elaborate';
import {
  combineLikeTerms,
  constantInteger,
  exprKey,
  fromPolynomial,
  sortScalars,
  toPolynomial,
  type Monomial,
} from './normal';
import { asInteger, intLit, isOne, splitSign, ONE as ONE_LIT, type Literal } from '../literal/literal';
import { divideByInt, mulLit, negLit, powLit, recipLit } from '../literal/arith';
import { fail, ok, type Result } from '../result/result';
import { SCALAR, isKnownShape, isScalar, isSquare, shape, type Shape } from '../shape/shape';
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
 *  7. **덧셈 항 합치기 + 정렬** — 동류항을 합치고(`2A+3A` → `5A`) 항 순서를 고정한다
 *
 * ⚠ **7 때문에 `parse()` 는 더 이상 순수한 구조 정규화가 아니다.** `parse("A+A")` 는
 * `2A` 를, `parse("1+2")` 는 `3` 을 돌려준다 — 의미를 보존하는 재작성이지만 사용자가
 * 쓴 글자 그대로는 아니다. 대신 **분배는 절대 하지 않는다**(`combineTerms` 참고):
 * `(A+B)C + (A+B)C` 는 `2(A+B)C` 이지 `2AC+2BC` 가 아니다.
 *
 * `parse()` 가 elaborate 직후 이 함수를 호출하므로, 공개 API를 거친 트리는 항상
 * 정규화돼 있다. `matPow` 의 밑은 일부러 뚫지 않는다 — `(kA)^2` 을 `k^2A^2` 으로
 * 바꾸려면 지수가 스칼라 거듭제곱까지 만들어야 해서 범위 밖으로 남겨둔다.
 *
 * **거듭제곱 접기는 기본으로 켜져 있다.**
 *  - 행렬: **이웃한** 같은 밑만 접는다 — `AAABBA` → `A³B²A` (비가환이라 떨어진 건 못 모은다),
 *    지수 합이 0이면 소거 (`AA^{-1}` → `I`)
 *  - 스칼라: 교환 가능하므로 **떨어져 있어도 모아서** 접는다 — `xxxyyx` → `x⁴y²`
 *
 * 둘 다 **상수 정수 지수만** 합산한다. `x^a x^b` 처럼 지수가 심볼이면 건드리지 않는다
 * (합산 결과를 우리가 판정할 수 없다).
 *
 * `foldPowers` 인자는 남겨뒀다 — "안 접는 모드"가 다시 필요해질 수 있어서다.
 */

// ---------------------------------------------------------------------------
// collect — 곱 계열 노드를 (숫자, 스칼라 인수들, 비스칼라 인수들) 로 분해한다
// ---------------------------------------------------------------------------

type Collected = {
  readonly numeric: Literal;
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
      return { numeric: negLit(c.numeric), scalars: c.scalars, matrix: c.matrix };
    }

    case 'scalarMul': {
      let numeric = ONE_LIT;
      const scalars: TypedExpr[] = [];
      for (const f of e.factors) {
        const c = collect(f);
        // 못 곱하면 접지 않고 인수로 되돌린다 — 값을 뭉개지 않는다.
        const product = mulLit(numeric, c.numeric);
        if (product !== null) numeric = product;
        else scalars.push(numAtom(c.numeric));
        scalars.push(...c.scalars);
      }
      return { numeric, scalars, matrix: [] };
    }

    case 'matMul': {
      // `matMul` 이라고 해서 늘 비스칼라는 아니다 — `v^Tv` 는 (1,3)(3,1)=(1,1) 로
      // op는 matMul이지만 모양은 스칼라다(설계: 모든 것이 (rows,cols), (1,1)이 스칼라).
      // 이럴 땐 안을 열지 않고 **통째로 스칼라 원자 하나**로 취급해야 한다 — 안을 열면
      // 그 안의 인수들이 바깥 matMul의 인수 열에 잘못 이어붙어 차원이 깨진다.
      if (isScalar(e.shape)) return { numeric: ONE_LIT, scalars: [e], matrix: [] };

      let numeric = ONE_LIT;
      const scalars: TypedExpr[] = [];
      const matrix: TypedExpr[] = [];
      for (const f of e.factors) {
        const c = collect(f);
        const product = mulLit(numeric, c.numeric);
        if (product !== null) numeric = product;
        else scalars.push(numAtom(c.numeric));
        scalars.push(...c.scalars);
        matrix.push(...c.matrix);
      }
      return { numeric, scalars, matrix };
    }

    case 'mul': {
      const s = collect(e.scalar);
      const m = collect(e.matrix);
      const product = mulLit(s.numeric, m.numeric);
      return product !== null
        ? { numeric: product, scalars: [...s.scalars, ...m.scalars], matrix: m.matrix }
        : {
            numeric: ONE_LIT,
            scalars: [numAtom(s.numeric), numAtom(m.numeric), ...s.scalars, ...m.scalars],
            matrix: m.matrix,
          };
    }

    case 'matIdentity':
      // (1,1) 로 굳은 항등원은 스칼라 1과 같다 — 인수로 남기면 안 된다. 안 그러면
      // `pI` 가 `p` 로 안 줄고 `mul(I,p)` 로 남는다(퍼즈로 확인). 아직 비스칼라 크기로
      // 확정된 항등원(문맥에서 진짜 행렬로 쓰일 예정인 경우)은 그대로 원자로 둔다.
      return isScalar(e.shape)
        ? { numeric: ONE_LIT, scalars: [], matrix: [] }
        : { numeric: ONE_LIT, scalars: [], matrix: [e] };

    default:
      return isScalar(e.shape)
        ? { numeric: ONE_LIT, scalars: [e], matrix: [] }
        : { numeric: ONE_LIT, scalars: [], matrix: [e] };
  }
}

// ---------------------------------------------------------------------------
// 덧셈 항 — 합치기와 정렬
// ---------------------------------------------------------------------------

/**
 * 노드가 순수 숫자 리터럴이면 그 값. **`neg(num)` 도 받는다** — `buildProduct` 가 부호를
 * 바깥 `neg` 로 내보내므로 정규화 뒤의 음수는 `num(-3)` 이 아니라 `neg(num 3)` 이다.
 */
function literalOf(e: TypedExpr): Literal | null {
  if (e.op === 'num') return e.value;
  if (e.op === 'neg' && e.operand.op === 'num') return negLit(e.operand.value);
  return null;
}

/**
 * 항 하나에서 부호를 벗겨낸다. 정렬 키가 부호를 1순위로 보기 위해서다.
 *
 * `renderProduct`/`buildProduct` 와 같은 "부호는 바깥" 관례를 읽는 쪽이다.
 */
function stripTermSign(t: TypedExpr): { negative: boolean; core: TypedExpr } {
  if (t.op === 'neg') return { negative: true, core: t.operand };
  if (t.op === 'num') {
    const { negative, magnitude } = splitSign(t.value);
    if (negative) return { negative: true, core: numAtom(magnitude) };
  }
  return { negative: false, core: t };
}

/**
 * 덧셈 항 정렬. 덧셈은 교환 가능하므로 순서를 고정해도 되고, 고정해야 `parse` 와
 * `expand` 가 같은 값에 같은 LaTeX 을 낸다 (퍼즈 ③).
 *
 * 키는 세 겹이다. **순수 `exprKey` 하나로는 사람이 읽기 나쁜 순서가 나온다:**
 *  1. **상수항은 맨 뒤로** — `n`(0x6E) < `s`(0x73) 라 `exprKey` 만 쓰면 `a+1` 이 `1+a` 가 된다
 *  2. **양수 먼저** — `-`(0x2D)가 모든 글자보다 앞서서 `A-B` 가 `-B+A` 로 뒤집힌다.
 *     렌더가 첫 항의 `-` 를 그대로 내보내므로 사용자에게 보이는 문자열이 나빠진다
 *  3. 나머지는 `exprKey` 순 — 안정적이기만 하면 되므로 임의로 정한다
 *
 * 순서를 고정해야 `parse` 와 `expand` 가 같은 값에 같은 LaTeX 을 낸다 (퍼즈 ③).
 */
function sortTerms(terms: readonly TypedExpr[],
  key: (((a: { term: TypedExpr; constant: number; sign: number; key: string; }, b: { term: TypedExpr; constant: number; sign: number; key: string; }) => number) | undefined) = undefined
): TypedExpr[] {
  const keyed = terms.map((t) => {
    const { negative, core } = stripTermSign(t);
    return {
      term: t,
      constant: core.op === 'num' ? 1 : 0,
      sign: negative ? 1 : 0,
      key: exprKey(core),
    };
  });
  if(key === undefined) {
    keyed.sort(
      (a, b) =>
        a.constant - b.constant ||
        a.sign - b.sign ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
  }
  else {
    keyed.sort(key);
  }
  return keyed.map((k) => k.term);
}

/**
 * 동류항을 합친다 (`AcB + cAB` → `2cAB`, `\frac{3}{7}A + \frac{1}{5}A` → `\frac{22}{35}A`).
 *
 * ❗ **분배는 하지 않는다.** `toPolynomial` 은 곱을 합 위로 완전히 분배하므로, 단항식이
 * 여럿 나오는 항(= 괄호가 풀리는 항)은 펼치지 않고 통째로 원자 하나로 둔다. 이 가드가
 * 없으면 `(A+B)C + (A+B)C` 가 `2AC+2BC` 가 된다 — `parse` 가 사용자 괄호를 푸는 셈이다.
 * (`simplifyRaw` 가 쓰는 것과 같은 가드다.)
 *
 * ❗ **실패를 새로 만들지 않는다.** 어느 단계든 실패하면 원래 항을 그대로 돌려준다.
 * 여기서 실패를 전파하면 `parse()` 가 지금까지 받던 식을 거부하기 시작하고, 그건
 * 퍼즈가 아니라 주 앱에서 터진다 (`viaCe`/`invertLiteral` 과 같은 방어 관례).
 *
 * 아무것도 안 합쳐졌으면 **원래 항을 그대로 유지한다** — `toPolynomial` 왕복은 합칠 게
 * 없어도 트리를 바꾸므로(정렬·좌결합 재조립), 굳이 통과시키면 렌더 멱등만 위태로워진다.
 */
function combineTerms(
  terms: readonly TypedExpr[],
  target: Shape,
  foldPowers: boolean,
): readonly TypedExpr[] {
  if (terms.length < 2) return terms;

  const monomials: Monomial[] = [];
  for (const term of terms) {
    const p = toPolynomial(term);
    if (p.ok && p.value.length === 1) {
      monomials.push(p.value[0]);
    } else {
      monomials.push(
        isScalar(term.shape)
          ? { numeric: ONE_LIT, scalars: [term], factors: [] }
          : { numeric: ONE_LIT, scalars: [], factors: [term] },
      );
    }
  }

  const combined = combineLikeTerms(monomials);
  // 개수가 그대로면 합쳐진 게 없다 — 원본을 건드리지 않는다.
  if (combined.length === monomials.length) return terms;

  const rebuilt = fromPolynomial(combined, target);
  if (!rebuilt.ok) return terms;
  // 재조립된 트리는 `mulTyped` 좌결합이라 정규화 모양이 아니다. 항 단위로만 다시 다진다
  // (`add` 로 재귀하면 여기로 되돌아와 무한 재귀가 된다).
  const out = rebuilt.value.op === 'add' ? rebuilt.value.terms : [rebuilt.value];
  const normalized: TypedExpr[] = [];
  for (const t of out) {
    const r = normalize(t, foldPowers);
    if (!r.ok) return terms;
    normalized.push(r.value);
  }
  return normalized;
}

/**
 * 분모의 역수. 숫자면 숫자 리터럴로, 아니면 `\frac{1}{d}` 노드로.
 * 못 만들면 `null` — 호출자가 원래 `frac` 을 그대로 둔다.
 */
function reciprocalOf(denominator: TypedExpr): TypedExpr | null {
  const lit = literalOf(denominator);
  if (lit !== null) {
    const inv = recipLit(lit);
    return inv === null ? null : numAtom(inv);
  }
  return { op: 'frac', shape: SCALAR, numerator: numAtom(ONE_LIT), denominator };
}

/**
 * `frac(비스칼라 분자, 스칼라 분모)` 를 `역수 × 분자` 로 내린다.
 *
 * 곱으로 만든 뒤 `collect`/`buildProduct` 를 한 번 더 태우는 게 요점이다 — 그래야
 * `\frac{2A}{3}` 의 `2` 와 역수 `1/3` 이 하나의 계수 `2/3` 로 합쳐진다.
 * 실패하면 `null` — **normalize 는 실패를 새로 만들지 않는다.**
 */
function hoistFracNumerator(
  numerator: TypedExpr,
  denominator: TypedExpr,
  foldPowers: boolean,
): TypedExpr | null {
  const recip = reciprocalOf(denominator);
  if (recip === null) return null;
  const product = mulTyped(recip, numerator);
  if (!product.ok) return null;
  const c = collect(product.value);
  return buildProduct(c.numeric, c.scalars, c.matrix, foldPowers);
}

// ---------------------------------------------------------------------------
// 되돌리기 — collect의 결과를 다시 트리로
// ---------------------------------------------------------------------------

const numAtom = (value: Literal): TypedExpr => ({ op: 'num', shape: SCALAR, value });

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
    else out.push({ op: 'scalarPow', shape: SCALAR, base, exponent: numAtom(intLit(exponent)) });
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
    let totalExponent = first.exponent;
    let run = 1;
    while (i + run < factors.length) {
      const next = powerParts(factors[i + run]);
      if (next === null || exprKey(next.base) !== key) break;
      totalExponent += next.exponent;
      run += 1;
    }
    if (run > 1 && isSquare(first.base.shape)) {
      if (totalExponent === 0) {
        out.push({ op: 'matIdentity', shape: first.base.shape });
      } else if (totalExponent === 1) {
        out.push(first.base);
      } else {
        out.push({
          op: 'matPow',
          shape: first.base.shape,
          base: first.base,
          exponent: numAtom(intLit(totalExponent)),
        });
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
export function normalize(e: TypedExpr, foldPowers = true,
  _key: (((a: { term: TypedExpr; constant: number; sign: number; key: string; }, b: { term: TypedExpr; constant: number; sign: number; key: string; }) => number) | undefined) = undefined
): Result<TypedExpr> {
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
      return addTyped(sortTerms(combineTerms(terms, e.shape, foldPowers), _key));
    }

    case 'neg': {
      const inner = normalize(e.operand, foldPowers);
      if (!inner.ok) return inner;
      const c = collect(inner.value);
      return ok(buildProduct(negLit(c.numeric), c.scalars, c.matrix, foldPowers));
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

      let numeric = ONE_LIT;
      const scalars: TypedExpr[] = [];
      const matrixFactors: TypedExpr[] = [];
      for (const child of children) {
        const c = collect(child);
        // 못 곱하면 접지 않고 인수로 되돌린다 — 값을 뭉개지 않는다.
        const product = mulLit(numeric, c.numeric);
        if (product !== null) numeric = product;
        else scalars.push(numAtom(c.numeric));
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

      // 세 계수를 한 번에 곱한다. 하나라도 실패하면 접지 않고 인수로 남긴다.
      const pair = mulLit(cl.numeric, cr.numeric);
      const all = pair === null ? null : mulLit(pair, merged.numeric);
      const carried =
        all !== null ? [] : [numAtom(cl.numeric), numAtom(cr.numeric), numAtom(merged.numeric)];
      return ok(
        buildProduct(
          all ?? ONE_LIT,
          [...cl.scalars, ...cr.scalars, ...merged.scalars, ...carried],
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
      const exponent = normalize(e.exponent, foldPowers);
      if (!exponent.ok) return exponent;
      // 정수로 확정되면 **단일 리터럴로 되돌려 담는다.** 일반 normalize 를 거친 `-1` 은
      // `buildProduct` 의 부호 호이스팅 때문에 `neg(num 1)` 이 되는데, 그러면 s-식이
      // `(matPow A (neg 1))` 이 되어 기존 기대값(`(matPow A -1)`)과 어긋난다.
      const n = constantInteger(exponent.value);
      const folded = n === null ? exponent.value : numAtom(intLit(n));
      // A^0 은 항등원 — elaborate 가 이미 걸렀지만, 정리 뒤에 0이 될 수도 있다.
      if (n === 0) return ok({ op: 'matIdentity', shape: e.shape });
      if (n === 1) return ok(base.value);
      return ok({ op: 'matPow', shape: e.shape, base: base.value, exponent: folded });
    }

    case 'scalarPow': {
      const base = normalize(e.base, foldPowers);
      if (!base.ok) return base;
      const exponent = normalize(e.exponent, foldPowers);
      if (!exponent.ok) return exponent;
      // 리터럴^정수리터럴 은 값으로 접는다. 곱에서 숫자를 접는 것(`collect`)과 같은
      // "숫자 접기" 이고, **복소수는 여기서만 접힌다** — `ceSimplify` 는 `i^{2}` 를
      // 안 풀어준다(실측: `["Power",["Complex",0,1],2]` 그대로). `literal/arith.ts` 는
      // `ce.box(...).evaluate()` 를 쓰므로 `-1` 이 나온다.
      //
      // `literalOf` 로 밑·지수 둘 다 **`neg(num)` 도** 받는다 — `num` 만 보면
      // `\left(-2\right)^3` (트리로는 `scalarPow(neg(2),3)`) 이 여기서 안 접힌 채로
      // 렌더 `-2^{3}` 을 냈다가, **재파싱할 때는** CE가 델리미터 없는 `-2` 를 음수
      // 리터럴 `num(-2)` 하나로 읽어(실측) 그제서야 접혀 `-8` 이 되는 왕복 불일치가
      // 있었다(`\sum`/`\prod` 처럼 본문을 CE에 안 넘기는 불투명 노드 안에서 fuzz가 잡음).
      // `neg(scalarPow(...))`(바깥 단항 마이너스)는 이 case가 아니라 `neg` case를 타므로
      // 안 섞인다 — `(-2)^3` 과 `-(2^3)` 은 계속 다른 트리다.
      const baseLit = literalOf(base.value);
      const expLit = literalOf(exponent.value);
      if (baseLit !== null && expLit !== null) {
        const n = asInteger(expLit);
        const folded = n === null ? null : powLit(baseLit, n);
        if (folded !== null) return ok(numAtom(folded));
      }
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

    // `call` 과 같은 취급 — 원자 하나로 두고 인수만 재귀한다. 모양은 정규화로
    // 안 바뀐다(호출부 모양은 elaborate가 이미 확정했다).
    case 'apply': {
      const args: TypedExpr[] = [];
      for (const a of e.args) {
        const r = normalize(a, foldPowers);
        if (!r.ok) return r;
        args.push(r.value);
      }
      return ok({ op: 'apply', shape: e.shape, name: e.name, args });
    }

    case 'frac': {
      const numerator = normalize(e.numerator, foldPowers);
      if (!numerator.ok) return numerator;
      const denominator = normalize(e.denominator, foldPowers);
      if (!denominator.ok) return denominator;
      // 정수/정수 는 **분수 표기가 아니라 유리수 리터럴**이다. 사용자가 직접 쓴
      // `\frac{3}{9}` 는 CE가 이미 `Rational` 로 주므로(그래서 리터럴로 들어온다) 여기 안
      // 걸리고, 재작성이 만들어낸 `\frac{-3}{9}` 같은 것만 걸린다. 안 접으면 렌더가
      // `\frac{-3}{9}` 를 내고 다시 읽으면 CE가 `Rational(-1,3)` 으로 줄여버려
      // **멱등이 깨진다**(퍼즈로 확인).
      const n = literalOf(numerator.value);
      const dLit = literalOf(denominator.value);
      const d = dLit === null ? null : asInteger(dLit);
      if (n !== null && d !== null && d !== 0 && asInteger(n) !== null) {
        return ok(numAtom(divideByInt(n, d)));
      }
      // **분자가 비스칼라면 역수를 곱으로 내린다** — `\frac{2A}{3}` → `\frac{2}{3}A`,
      // `\frac{I}{2}` → `\frac{1}{2}I`, `\frac{A}{a}` → `\frac{1}{a}A`.
      //
      // 나눗셈 표기를 보존하는 건 **스칼라 분수**에 한한다 (`\frac{x^2+2x+1}{x+1}` 은
      // 그대로 둬야 원문 모양이 산다). 분자가 행렬이면 "행렬을 스칼라로 나눈다" 는
      // 뜻이므로 계수를 앞으로 빼는 쪽이 정규형에 맞는다 — 그래야 `collect` 가 계수를
      // 보고 동류항·정렬이 걸린다.
      //
      // ⚠ **`\frac{I}{2}` 는 여기 안 걸린다.** 문맥이 없는 `I` 는 아래 matIdentity 케이스가
      // (1,1)로 굳혀버려서 분자가 스칼라가 되기 때문이다. 그리고 `\frac{I}{2}A` 는 애초에
      // elaborate 에서 막힌다 — `hasUnresolvedIdentity` 가 `frac` 안을 안 들여다본다.
      // 둘 다 이 하강과 별개의 건이라 지금은 그대로 둔다.
      if (!isScalar(numerator.value.shape)) {
        const hoisted = hoistFracNumerator(numerator.value, denominator.value, foldPowers);
        if (hoisted !== null) return ok(hoisted);
      }
      return fracTyped(numerator.value, denominator.value);
    }

    // 본문(그리고 상하한)을 재귀 정규화만 하고 재조립한다. **바운드 경계를 넘는 스칼라
    // 호이스팅은 없다** — `collect`/`buildProduct` 는 이 두 op를 몰라서(default 분기가
    // 불투명 원자로 취급) 애초에 안까지 파고들지 않는다. `\sum_k(kA)` 의 `k` 가 상수처럼
    // 밖으로 끌려나오지 않는 이유가 그거다.
    case 'deriv': {
      const body = normalize(e.body, foldPowers);
      if (!body.ok) return body;
      return derivTyped(body.value, e.vars, e.order);
    }

    case 'sum':
    case 'prod':
    case 'integral': {
      const body = normalize(e.body, foldPowers);
      if (!body.ok) return body;
      const lower = e.lower !== null ? normalize(e.lower, foldPowers) : null;
      if (lower !== null && !lower.ok) return lower;
      const upper = e.upper !== null ? normalize(e.upper, foldPowers) : null;
      if (upper !== null && !upper.ok) return upper;
      const build = e.op === 'sum' ? sumTyped : e.op === 'prod' ? prodTyped : integralTyped;
      return build(
        body.value,
        e.variable,
        lower === null ? null : lower.value,
        upper === null ? null : upper.value,
      );
    }
  }
}
