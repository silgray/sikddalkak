import { expand as ceExpand, factor as ceFactor, simplify as ceSimplify } from '@cortex-js/compute-engine';
import {
  addTyped,
  crossTyped,
  dotTyped,
  elaborate,
  fracTyped,
  mulTyped,
  transposeTyped,
} from '../parse/elaborate';
import {
  combineLikeTerms,
  exprKey,
  foldNumericScalars,
  fromPolynomial,
  sortScalars,
  toPolynomial,
  type Monomial,
  type Polynomial,
} from '../parse/normal';
import { normalize } from '../parse/normalize';
import { asInteger, intLit, isZero, ONE as ONE_LIT, type Literal } from '../types-Literal';
import { divideByInt } from '../literalMath';
import { fail, ok, type Result } from '../types-Result';
import { render } from '../render';
import { parseCeJson } from '../parse/parseSymbol';
import { SCALAR, isScalar, isSquare, type Shape } from '../types-shape';
import type { TypedExpr, Env } from '../types-TypedExpr';

/**
 * 구문 재작성 — expand / simplify / factor / substitute.
 *
 * 모든 규칙은 `normal.ts` 의 정규형과 `ops.ts` 의 성질 표 위에서만 움직인다. 여기에
 * "행렬이면 이렇게" 같은 특수 분기를 넣기 시작하면 설계가 다시 무너진다.
 *
 * **순수 스칼라 부분식은 CE에 위임한다**(설계 §7). 삼각항등식·유리식 정리처럼 우리가
 * 다시 만들 이유가 없는 것들이 거기 있다. 모양이 얽힌 식은 절대 CE에 넘기지 않는다 —
 * 거기가 교환법칙 오적용의 출처였다.
 */

// ---------------------------------------------------------------------------
// CE 위임 경계
// ---------------------------------------------------------------------------

/**
 * 통째로 CE에 넘겨도 되는가 = **모양이 스칼라이고, 안에 모양을 다루는 연산이 하나도 없다.**
 *
 * 결과가 스칼라라는 것만으로는 부족하다. `v·w` 는 스칼라지만 안에 벡터가 있어서 CE에
 * 넘기면 벡터를 스칼라 곱으로 오해한다.
 */
export function isPureScalar(e: TypedExpr): boolean {
  if (!isScalar(e.shape)) return false;
  switch (e.op) {
    case 'num':
    case 'sym':
      return true;
    case 'matrix':
    case 'dot':
    case 'cross':
    case 'transpose':
    case 'matMul':
    case 'matPow':
      return false;
    // `mul` 은 `matrix` 필드가 비스칼라 모양이라 `e.shape` 도 늘 비스칼라다 — 위의
    // `isScalar(e.shape)` 관문에서 이미 걸러진다. 여기 있는 건 switch 완전성 때문이다.
    case 'mul':
      return false;
    case 'add':
      return e.terms.every(isPureScalar);
    case 'neg':
      return isPureScalar(e.operand);
    case 'scalarMul':
      return e.factors.every(isPureScalar);
    case 'scalarPow':
      return isPureScalar(e.base) && isPureScalar(e.exponent);
    case 'call':
      return e.args.every(isPureScalar);
    case 'frac':
      return isPureScalar(e.numerator) && isPureScalar(e.denominator);
    // 미정 항등원은 `isScalar(e.shape)` 관문에서 대부분 걸러지지만(정사각 미정 크기는
    // 스칼라가 아니다), CE는 애초에 `I` 를 모른다 — 넘기면 그냥 미지 심볼로 읽어 무슨
    // 정리를 할지 알 수 없다. 절대 위임하지 않는다.
    case 'matIdentity':
      return false;
  }
}

type CeOp = 'expand' | 'simplify' | 'factor';

/**
 * 순수 스칼라 식을 CE에 넘겼다 받는다.
 *
 * **결과는 `.latex` 가 아니라 MathJSON으로 받는다.** CE 0.90의 LaTeX 직렬화에 버그가
 * 있어서 `Power(Divide(X,a), 2)` 를 `\frac{1}{a}(X)^2` 로 내놓는다 — 지수의 적용 범위가
 * 바뀌어 **값이 달라진다**(실측, 퍼즈가 잡음). MathJSON은 멀쩡하다.
 *
 * 왕복이 실패하면 **원래 식을 그대로 돌려준다**. CE가 우리가 못 읽는 머리를 내놓는 일이
 * 있는데, 그것 때문에 변환 전체가 실패하는 것보다 "안 바뀜"이 낫다.
 */
function viaCe(e: TypedExpr, op: CeOp, env: Env): TypedExpr {
  try {
    // 0.90에서 expand/factor는 Expression의 메서드가 아니라 자유 함수다(.d.ts 확인).
    // 문자열 입력은 기본이 느슨한 AsciiMath 문법이라 `strict` 로 LaTeX 문법을 강제한다.
    const source = render(e);
    const result =
      op === 'expand'
        ? ceExpand(source, { strict: true })
        : op === 'factor'
          ? ceFactor(source, { strict: true })
          : ceSimplify(source, { strict: true });
    const syntax = parseCeJson(result.json);
    if (!syntax.ok) return e;
    const typed = elaborate(syntax.value, env);
    if (!typed.ok || !isScalar(typed.value.shape)) return e;
    return typed.value;
  } catch {
    return e;
  }
}

// ---------------------------------------------------------------------------
// 자식 재조립 — 모양 검사를 다시 통과해야 한다
// ---------------------------------------------------------------------------

const negTyped = (operand: TypedExpr): TypedExpr => ({
  op: 'neg',
  shape: operand.shape,
  operand,
});

/**
 * 자식들에 `f` 를 적용하고 다시 조립한다.
 *
 * 조립에 elaborate와 **같은 생성자**를 쓰는 게 요점이다. 재작성이 모양을 깨뜨리면
 * 조립 단계에서 오류가 나므로, 잘못된 트리가 조용히 빠져나가지 못한다.
 */
function mapChildren(
  e: TypedExpr,
  f: (child: TypedExpr) => Result<TypedExpr>,
): Result<TypedExpr> {
  switch (e.op) {
    case 'num':
    case 'sym':
    case 'matIdentity':
      return ok(e);

    case 'matrix': {
      const rows: TypedExpr[][] = [];
      for (const row of e.rows) {
        const cells: TypedExpr[] = [];
        for (const cell of row) {
          const mapped = f(cell);
          if (!mapped.ok) return mapped;
          if (!isScalar(mapped.value.shape)) {
            return fail('shape-mismatch', 'A matrix entry must be a scalar');
          }
          cells.push(mapped.value);
        }
        rows.push(cells);
      }
      return ok({ op: 'matrix', shape: e.shape, rows });
    }

    case 'add': {
      const terms: TypedExpr[] = [];
      for (const term of e.terms) {
        const mapped = f(term);
        if (!mapped.ok) return mapped;
        terms.push(mapped.value);
      }
      return addTyped(terms);
    }

    case 'neg': {
      const inner = f(e.operand);
      return inner.ok ? ok(negTyped(inner.value)) : inner;
    }

    case 'scalarMul':
    case 'matMul': {
      const mapped: TypedExpr[] = [];
      for (const factor of e.factors) {
        const result = f(factor);
        if (!result.ok) return result;
        mapped.push(result.value);
      }
      return foldMul(mapped);
    }

    case 'mul': {
      const scalar = f(e.scalar);
      if (!scalar.ok) return scalar;
      const matrix = f(e.matrix);
      if (!matrix.ok) return matrix;
      return mulTyped(scalar.value, matrix.value);
    }

    case 'dot':
    case 'cross': {
      const left = f(e.left);
      if (!left.ok) return left;
      const right = f(e.right);
      if (!right.ok) return right;
      const combine = e.op === 'dot' ? dotTyped : crossTyped;
      return combine(left.value, right.value);
    }

    case 'transpose': {
      const inner = f(e.operand);
      return inner.ok ? transposeTyped(inner.value) : inner;
    }

    case 'matPow': {
      const base = f(e.base);
      if (!base.ok) return base;
      if (!isSquare(base.value.shape)) {
        return fail('shape-mismatch', 'A matrix power needs a square base');
      }
      return ok({ op: 'matPow', shape: base.value.shape, base: base.value, exponent: e.exponent });
    }

    case 'scalarPow': {
      const base = f(e.base);
      if (!base.ok) return base;
      const exponent = f(e.exponent);
      if (!exponent.ok) return exponent;
      if (!isScalar(base.value.shape) || !isScalar(exponent.value.shape)) {
        return fail('shape-mismatch', 'A scalar power needs scalar operands');
      }
      return ok({ op: 'scalarPow', shape: SCALAR, base: base.value, exponent: exponent.value });
    }

    case 'call': {
      const args: TypedExpr[] = [];
      for (const arg of e.args) {
        const mapped = f(arg);
        if (!mapped.ok) return mapped;
        if (!isScalar(mapped.value.shape)) {
          return fail('shape-mismatch', `${e.name} expects a scalar argument`);
        }
        args.push(mapped.value);
      }
      return ok({ op: 'call', shape: SCALAR, name: e.name, args });
    }

    case 'frac': {
      const numerator = f(e.numerator);
      if (!numerator.ok) return numerator;
      const denominator = f(e.denominator);
      if (!denominator.ok) return denominator;
      return fracTyped(numerator.value, denominator.value);
    }
  }
}

// ---------------------------------------------------------------------------
// expand
// ---------------------------------------------------------------------------

/**
 * 다항식 안의 **스칼라 계수만** CE로 넘긴다. 비스칼라 인수 열은 건드리지 않는다.
 * CE가 돌려준 숫자는 곧바로 수치 계수로 흡수한다 (`3^2` → `9` → 계수에 곱해짐).
 *
 * `fold` 는 순수 스칼라 인수들을 **하나로 묶어** 넘길지 정한다.
 *  - `true` (expand/simplify): `A·A` 가 `A²` 로 접힌다. 하나씩 넘기면 안 접힌다.
 *  - `false` (factor): 묶어버리면 `abA + acB` 에서 공통 인수 `a` 가 블록 안에 갇혀
 *    추출되지 않는다. 인수분해할 때는 흩어진 채로 두는 게 맞다.
 */
function refineScalars(p: Polynomial, op: CeOp, env: Env, fold: boolean): Polynomial {
  return foldNumericScalars(
    p.map((m) => {
      if (m.scalars.length === 0) return m;
      const refined = m.scalars.map((s) => (isPureScalar(s) ? viaCe(s, op, env) : s));
      if (!fold) return { ...m, scalars: sortScalars(refined) };

      // 내적처럼 모양이 얽힌 스칼라는 CE에 넘길 수 없으니 따로 둔다.
      const pure = refined.filter(isPureScalar);
      const rest = refined.filter((s) => !isPureScalar(s));
      if (pure.length < 2) return { ...m, scalars: sortScalars(refined) };
      const merged = foldMul(pure);
      if (!merged.ok) return { ...m, scalars: sortScalars(refined) };
      return { ...m, scalars: sortScalars([viaCe(merged.value, op, env), ...rest]) };
    }),
  );
}

/**
 * 곱을 합 위로 완전히 분배하고 동류항을 합친다.
 *
 * `v^T(A+B)v` → `v^TAv + v^TBv`, `(A+B)²` → `A² + AB + BA + B²` (순서 유지).
 *
 * `fromPolynomial` 은 `mulTyped` 로 좌결합 접기만 하고 평탄화·정렬은 안 한다 — 그 결과가
 * `parse()`(elaborate+normalize)가 같은 값에 대해 내놓는 트리와 **모양이 다를 수 있다**
 * (값은 같은데 구조가 달라 렌더→재파싱 왕복이 깨진다, 퍼즈로 확인). 그래서 끝에
 * `normalize` 를 한 번 더 걸어 어느 경로로 왔든 같은 값이 같은 트리로 수렴하게 한다.
 */
export function expand(e: TypedExpr, env: Env): Result<TypedExpr> {
  const result = expandRaw(e, env);
  if (!result.ok) return result;
  return normalize(result.value);
}

function expandRaw(e: TypedExpr, env: Env): Result<TypedExpr> {
  if (isPureScalar(e)) return ok(viaCe(e, 'expand', env));
  const p = toPolynomial(e);
  if (!p.ok) return p;
  return fromPolynomial(combineLikeTerms(refineScalars(p.value, 'expand', env, true)), e.shape);
}

// ---------------------------------------------------------------------------
// simplify
// ---------------------------------------------------------------------------

/**
 * 정리.
 *
 * expand와 달리 **괄호를 함부로 풀지 않는다.** 자식부터 정리한 뒤, 덧셈 노드에서만
 * 동류항을 합친다. 어떤 항을 합치려고 분배가 필요하면 그 항은 통째로 놔둔다 —
 * 사용자가 `\left(A+B\right)C` 라고 쓴 걸 정리랍시고 펼쳐놓지 않기 위해서다.
 *
 * 재귀는 `simplifyRaw` 안에서만 돌고, **normalize는 맨 바깥에서 한 번만** 건다 —
 * 재귀할 때마다 정규화하면 트리 깊이만큼 중복 작업이 쌓인다 (정규화 자체는 몇 번을
 * 걸어도 값은 안 바뀌지만, 굳이 반복할 이유가 없다).
 *
 * **`foldPowers=true`** — simplify는 이웃한 같은 인수를 `matPow` 로 접는다
 * (`AAAA` → `A⁴`) 그리고 역행렬을 소거한다(`AA^{-1}` → `I`). "정리해 달라"는 요청에서
 * 자연스러운 기대이기 때문. parse/expand/factor/substitute는 안 그런다 —
 * 사용자가 쓴 곱의 모양을 임의로 바꾸지 않는다는 결정은 그대로다 (`normalize.ts` 참고).
 */
export function simplify(e: TypedExpr, env: Env): Result<TypedExpr> {
  const result = simplifyRaw(e, env);
  if (!result.ok) return result;
  return normalize(result.value, true);
}

function simplifyRaw(e: TypedExpr, env: Env): Result<TypedExpr> {
  if (isPureScalar(e)) return ok(viaCe(e, 'simplify', env));

  if (e.op === 'add') {
    const terms: TypedExpr[] = [];
    for (const term of e.terms) {
      const simplified = simplifyRaw(term, env);
      if (!simplified.ok) return simplified;
      terms.push(simplified.value);
    }
    const monomials: Monomial[] = [];
    for (const term of terms) {
      const p = toPolynomial(term);
      // 분배가 일어나는 항(= 단항식이 여러 개)은 펼치지 않고 통째로 하나의 인수로 둔다.
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
    return fromPolynomial(
      combineLikeTerms(refineScalars(monomials, 'simplify', env, true)),
      e.shape,
    );
  }

  return mapChildren(e, (child) => simplifyRaw(child, env));
}

// ---------------------------------------------------------------------------
// factor
// ---------------------------------------------------------------------------

const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));

/**
 * 모든 단항식이 공유하는 정수 계수. 정수가 아니면 1 (안전한 쪽).
 *
 * 유리수 계수는 일부러 안 뽑는다 — `\frac{1}{2}A+\frac{1}{3}B` 에서 `\frac{1}{6}` 을
 * 뽑아내면 사용자가 쓴 것보다 오히려 읽기 나빠진다.
 */
function commonNumeric(p: Polynomial): number {
  const ints = p.map((m) => asInteger(m.numeric));
  if (ints.some((n) => n === null)) return 1;
  const values = ints as number[];
  const g = values.reduce((acc, n) => gcd(acc, n), 0);
  if (g <= 1) return 1;
  // 전부 음수면 부호까지 뽑는다.
  return values.every((n) => n < 0) ? -g : g;
}

/** 모든 단항식이 공유하는 스칼라 인수 (중복 개수까지 고려). */
function commonScalars(p: Polynomial): TypedExpr[] {
  let shared = [...p[0].scalars];
  for (const m of p.slice(1)) {
    const pool = m.scalars.map(exprKey);
    shared = shared.filter((s) => {
      const at = pool.indexOf(exprKey(s));
      if (at < 0) return false;
      pool.splice(at, 1);
      return true;
    });
  }
  return shared;
}

const removeOnce = (scalars: readonly TypedExpr[], remove: readonly TypedExpr[]): TypedExpr[] => {
  const out = [...scalars];
  for (const r of remove) {
    const at = out.findIndex((s) => exprKey(s) === exprKey(r));
    if (at >= 0) out.splice(at, 1);
  }
  return out;
};

/**
 * 공통 좌인수의 길이. **모든 단항식이 인수를 하나 이상 남겨야** 한다 —
 * `A + AB` 를 `A(I+B)` 로 쓰려면 단위행렬이 필요한데 우리 표현엔 없다.
 */
function commonPrefixLength(p: Polynomial): number {
  const limit = Math.min(...p.map((m) => m.factors.length)) - 1;
  let length = 0;
  while (length < limit) {
    const key = exprKey(p[0].factors[length]);
    if (!p.every((m) => exprKey(m.factors[length]) === key)) break;
    length += 1;
  }
  return length;
}

/** 공통 우인수의 길이. 같은 이유로 각 단항식에 인수를 하나 이상 남긴다. */
function commonSuffixLength(p: Polynomial): number {
  const limit = Math.min(...p.map((m) => m.factors.length)) - 1;
  let length = 0;
  while (length < limit) {
    const key = exprKey(p[0].factors[p[0].factors.length - 1 - length]);
    if (!p.every((m) => exprKey(m.factors[m.factors.length - 1 - length]) === key)) break;
    length += 1;
  }
  return length;
}

/**
 * 내적/외적 항 하나를 분해한다.
 *
 * 이 둘은 결과가 각각 스칼라·인수 하나로 접혀버려서 인수 열의 좌·우 공통인수 경로를
 * 타지 못한다. 그래서 따로 본다: `u·v + u·w → u·(v+w)`.
 */
type BilinearTerm = {
  readonly kind: 'dot' | 'cross';
  readonly left: TypedExpr;
  readonly right: TypedExpr;
  readonly numeric: Literal;
  readonly otherScalars: readonly TypedExpr[];
};

function asBilinearTerm(m: Monomial): BilinearTerm | null {
  if (m.factors.length === 1 && m.factors[0].op === 'cross') {
    const c = m.factors[0];
    return { kind: 'cross', left: c.left, right: c.right, numeric: m.numeric, otherScalars: m.scalars };
  }
  if (m.factors.length === 0) {
    const dots = m.scalars.filter((s) => s.op === 'dot');
    if (dots.length === 1) {
      const d = dots[0] as TypedExpr & { op: 'dot'; left: TypedExpr; right: TypedExpr };
      return {
        kind: 'dot',
        left: d.left,
        right: d.right,
        numeric: m.numeric,
        otherScalars: m.scalars.filter((s) => s !== d),
      };
    }
  }
  return null;
}

/**
 * 내적/외적의 공통 좌·우 인수를 뽑는다. 뽑을 게 없으면 `null`.
 *
 * 외적은 반교환이라 **좌우를 섞지 않는 것**이 중요하다. 여기서는 분배를 되돌릴 뿐
 * 순서를 바꾸지 않으므로 `u×v + u×w = u×(v+w)` 도 `v×u + w×u = (v+w)×u` 도 안전하다.
 */
function factorBilinear(p: Polynomial): Result<TypedExpr> | null {
  const terms = p.map(asBilinearTerm);
  if (terms.some((t) => t === null)) return null;
  const parts = terms as BilinearTerm[];
  const kind = parts[0].kind;
  if (!parts.every((t) => t.kind === kind)) return null;

  const sharedLeft = parts.every((t) => exprKey(t.left) === exprKey(parts[0].left));
  const sharedRight = parts.every((t) => exprKey(t.right) === exprKey(parts[0].right));
  if (!sharedLeft && !sharedRight) return null;

  const varying = parts.map((t) => (sharedLeft ? t.right : t.left));
  const inner = fromPolynomial(
    parts.map((t, i) => ({ numeric: t.numeric, scalars: t.otherScalars, factors: [varying[i]] })),
    varying[0].shape,
  );
  if (!inner.ok) return inner;

  const combine = kind === 'dot' ? dotTyped : crossTyped;
  return sharedLeft
    ? combine(parts[0].left, inner.value)
    : combine(inner.value, parts[0].right);
}

const foldMul = (parts: readonly TypedExpr[]): Result<TypedExpr> =>
  parts
    .slice(1)
    .reduce<Result<TypedExpr>>((acc, p) => (acc.ok ? mulTyped(acc.value, p) : acc), ok(parts[0]));

/**
 * 인수분해.
 *
 * 비가환이므로 **공통 좌인수 또는 우인수만** 뽑는다. `AB+AC → A(B+C)`,
 * `BA+CA → (B+C)A`. `AB+CA` 처럼 어느 쪽도 공통이 아니면 **정직하게 포기**한다 —
 * 억지로 뽑으면 곱의 순서가 바뀌어 답이 달라진다.
 */
export function factor(e: TypedExpr, env: Env): Result<TypedExpr> {
  const result = factorRaw(e, env);
  if (!result.ok) return result;
  return normalize(result.value);
}

function factorRaw(e: TypedExpr, env: Env): Result<TypedExpr> {
  // 구조적 추출을 **먼저** 시도한다. CE를 먼저 부르면 순수 스칼라 `AB+AC` 처럼
  // 우리 쪽이 할 수 있는 것까지 놓친다 (CE 0.90은 다변수 공통인수를 못 뽑는다, 실측).
  const structural = factorStructural(e, env);
  if (structural !== null) return structural;
  // 구조적으로 뽑을 게 없을 때만 CE에 맡긴다 — `x²-y²` 같은 건 거기가 낫다.
  if (isPureScalar(e)) return ok(viaCe(e, 'factor', env));
  return ok(e);
}

/** 공통인수를 실제로 뽑아낸 경우에만 결과를 낸다. 뽑을 게 없으면 `null`. */
function factorStructural(e: TypedExpr, env: Env): Result<TypedExpr> | null {
  const parsed = toPolynomial(e);
  if (!parsed.ok) return parsed;
  const p = combineLikeTerms(refineScalars(parsed.value, 'simplify', env, false)).filter(
    (m) => !isZero(m.numeric),
  );
  if (p.length < 2) return null;

  const numeric = commonNumeric(p);
  const scalars = commonScalars(p);
  const prefix = commonPrefixLength(p);
  const suffix = commonSuffixLength(p);
  // 좌우 양쪽을 동시에 뽑으면 남는 부분이 비는 경우를 따로 다뤄야 해서, 더 긴 쪽 하나만 뽑는다.
  const useSuffix = suffix > prefix;
  const taken = useSuffix ? suffix : prefix;

  if (taken === 0) {
    // 인수 열에서 뽑을 게 없으면 내적/외적 쪽을 본다 (`u·v + u·w → u·(v+w)`).
    const bilinear = factorBilinear(p);
    if (bilinear !== null) return bilinear;
    if (numeric === 1 && scalars.length === 0) return null;
  }

  const shared = useSuffix
    ? p[0].factors.slice(p[0].factors.length - taken)
    : p[0].factors.slice(0, taken);

  const remainder: Monomial[] = p.map((m) => ({
    // `numeric` 은 위에서 정수임이 보장된다 (`commonNumeric`).
    numeric: divideByInt(m.numeric, numeric),
    scalars: removeOnce(m.scalars, scalars),
    factors: useSuffix
      ? m.factors.slice(0, m.factors.length - taken)
      : m.factors.slice(taken),
  }));

  const inner = fromPolynomial(remainder, innerShape(remainder, e.shape));
  if (!inner.ok) return inner;

  const parts: TypedExpr[] = [];
  if (numeric !== 1) parts.push({ op: 'num', shape: SCALAR, value: intLit(numeric) });
  parts.push(...scalars);
  if (useSuffix) {
    parts.push(inner.value, ...shared);
  } else {
    parts.push(...shared, inner.value);
  }
  return foldMul(parts);
}

/** 공통 인수를 떼어낸 뒤 남은 부분의 모양 — 전부 상쇄됐을 때 어떤 영을 낼지 정한다. */
function innerShape(remainder: Polynomial, fallback: Shape): Shape {
  const first = remainder[0];
  if (first.factors.length === 0) return SCALAR;
  const rows = first.factors[0].shape.rows;
  const cols = first.factors[first.factors.length - 1].shape.cols;
  return rows === undefined || cols === undefined ? fallback : { rows, cols };
}

// ---------------------------------------------------------------------------
// substitute
// ---------------------------------------------------------------------------

/**
 * 정의된 심볼을 그 정의로 바꾼다. **한 단계만** — 치환한 결과 안의 심볼은 다시 치환하지
 * 않는다. 반복은 호출자가 결정한다 (그래야 사용자가 한 단계씩 눈으로 볼 수 있다).
 */
export function substitute(e: TypedExpr, env: Env): Result<TypedExpr> {
  const bindings = env.bindings;
  if (bindings === undefined) return ok(e);

  const step = (node: TypedExpr): Result<TypedExpr> => {
    if (node.op === 'sym') {
      const bound = bindings[node.name];
      return bound === undefined ? ok(node) : ok(bound);
    }
    return mapChildren(node, step);
  };
  const result = step(e);
  if (!result.ok) return result;
  // 치환된 심볼의 정의가 이미 중첩된 곱일 수 있다 (`D=AB` 를 `Dv` 에 꽂으면 그 자체가
  // matMul 안의 matMul이 된다) — 다른 변환들과 같은 이유로 여기도 정규화한다.
  return normalize(result.value);
}
