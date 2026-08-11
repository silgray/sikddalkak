import { isPureScalar, refineScalars, viaCe } from './delegate';
import { buildCross, buildDot, buildMulAll } from '../expression/builders';
import { exprKey } from '../expression/key';
import { combineLikeTerms } from '../polynomial/combine';
import { fromPolynomial, toPolynomial } from '../polynomial/convert';
import type { Monomial, Polynomial } from '../polynomial/polynomial';
import { normalize } from '../normalize/normalize';
import { asInteger, intLit, isZero, type Literal } from '../literal/literal';
import { divideByInt } from '../literal/arith';
import { ok, type Result } from '../result/result';
import { SCALAR, isKnownShape, isScalar, type Shape } from '../shape/shape';
import type { TypedExpr, Env } from '../expression/node';
import {
  detectSingleMatrixPolynomial,
  liftFromScalarPolynomial,
  lowerToScalarPolynomial,
  pickPlaceholderName,
} from './matPoly';

/**
 * 인수분해.
 *
 * 공통인수 추출은 전부 **조립 전의 `Polynomial` 위에서** 돈다 — 수치 계수, 스칼라
 * 인수(다중집합 교집합), 그리고 비스칼라 인수 열의 **앞/뒤 공통 구간**(비가환이라
 * 순서를 지켜야 해서 접두·접미로만 뽑는다). 순수 스칼라로 떨어지는 자리에서만 CE에
 * 위임한다.
 */

const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));

/**
 * 모든 단항식이 공유하는 정수 계수. 정수가 아니면 1 (안전한 쪽).
 *
 * 유리수 계수는 일부러 안 뽑는다 — `\frac{1}{2}A+\frac{1}{3}B` 에서 `\frac{1}{6}` 을
 * 뽑아내면 사용자가 쓴 것보다 오히려 읽기 나빠진다.
 */
function commonNumeric(p: Polynomial): number {
  const ints = p.map((m) => asInteger(m.coefficient));
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
 * 공통 좌인수의 길이. **어떤 단항식은 인수를 전부 내줄 수 있다** —
 * `A + AB` 를 `A(I+B)` 로 쓸 때 `A` 하나뿐인 항은 core가 비고, 그 자리는
 * `matIdentity` 로 채운다(`insertIdentityIfEmpty`). 그래서 상한은 최소 길이까지다.
 */
function commonPrefixLength(p: Polynomial): number {
  const limit = Math.min(...p.map((m) => m.nonScalars.length));
  let length = 0;
  while (length < limit) {
    const key = exprKey(p[0].nonScalars[length]);
    if (!p.every((m) => exprKey(m.nonScalars[length]) === key)) break;
    length += 1;
  }
  return length;
}

/** 공통 우인수의 길이. 같은 이유로 전부 내주는 것도 허용한다. */
function commonSuffixLength(p: Polynomial): number {
  const limit = Math.min(...p.map((m) => m.nonScalars.length));
  let length = 0;
  while (length < limit) {
    const key = exprKey(p[0].nonScalars[p[0].nonScalars.length - 1 - length]);
    if (!p.every((m) => exprKey(m.nonScalars[m.nonScalars.length - 1 - length]) === key)) break;
    length += 1;
  }
  return length;
}

/**
 * core(공통 좌·우인수를 뗀 나머지) 위치의 실제 모양을 읽는다.
 *
 * 비어있지 않은 core를 가진 항이 있으면 거기서 직접 읽는다. 전부 비었으면(`A-A` 처럼
 * core가 하나도 안 남는 극단적인 경우) 공통 좌·우인수의 안쪽 경계 모양에서 유도하고,
 * 좌·우인수도 없으면(순수 스칼라 식) 식 전체의 모양(스칼라)으로 떨어진다 — 이 마지막
 * 경우가 "여긴 그냥 스칼라 1 자리다" 라는 신호가 된다(아래 `insertIdentityIfEmpty`).
 */
function inferCoreShape(
  cores: readonly (readonly TypedExpr[])[],
  prefixShared: readonly TypedExpr[],
  suffixShared: readonly TypedExpr[],
  fallback: Shape,
): Shape {
  for (const core of cores) {
    if (core.length > 0) return { rows: core[0].shape.rows, cols: core[core.length - 1].shape.cols };
  }
  const prefixLast = prefixShared[prefixShared.length - 1];
  const suffixFirst = suffixShared[0];
  const rows = prefixLast !== undefined ? prefixLast.shape.cols : fallback.rows;
  const cols = suffixFirst !== undefined ? suffixFirst.shape.rows : fallback.cols;
  return { rows, cols };
}

/**
 * core가 빈 단항식에 `matIdentity` 를 채워 넣는다.
 *
 * 공통 좌·우인수를 뗀 뒤 한 항에 아무것도 안 남으면(`A + AB` 에서 `A` 항처럼) 그
 * 자리는 수학적으로 항등원이다. `buildAdd` 는 스칼라 `1` 과 행렬을 못 더하므로
 * (모양 불일치 오류), 여기서 미리 `matIdentity` 를 인수로 박아 넣어야 뒤따르는
 * `fromPolynomial`→`buildAdd` 조립이 통과한다.
 *
 * `coreShape` 가 스칼라면 애초에 행렬이 낀 자리가 아니므로(순수 스칼라 인수분해) 손대지
 * 않는다 — 빈 인수 열은 그대로 숫자 `1` 을 뜻한다. 모양이 확정 안 됐는데 스칼라도
 * 아니면(행렬 자리인데 크기를 모름) 이 추출 자체를 포기한다 — 미정 모양으로 만들면
 * `numeric.ts` 가 값을 못 내 퍼즈 표본이 버려진다.
 */
function insertIdentityIfEmpty(
  core: readonly TypedExpr[],
  coreShape: Shape,
): readonly TypedExpr[] | null {
  if (core.length > 0) return core;
  if (isScalar(coreShape)) return core;
  if (!isKnownShape(coreShape)) return null;
  return [{ op: 'matIdentity', shape: coreShape }];
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
  readonly coefficient: Literal;
  readonly otherScalars: readonly TypedExpr[];
};

function asBilinearTerm(m: Monomial): BilinearTerm | null {
  if (m.nonScalars.length === 1 && m.nonScalars[0].op === 'cross') {
    const c = m.nonScalars[0];
    return { kind: 'cross', left: c.left, right: c.right, coefficient: m.coefficient, otherScalars: m.scalars };
  }
  if (m.nonScalars.length === 0) {
    const dots = m.scalars.filter((s) => s.op === 'dot');
    if (dots.length === 1) {
      const d = dots[0] as TypedExpr & { op: 'dot'; left: TypedExpr; right: TypedExpr };
      return {
        kind: 'dot',
        left: d.left,
        right: d.right,
        coefficient: m.coefficient,
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
    parts.map((t, i) => ({ coefficient: t.coefficient, scalars: t.otherScalars, nonScalars: [varying[i]] })),
    varying[0].shape,
  );
  if (!inner.ok) return inner;

  const combine = kind === 'dot' ? buildDot : buildCross;
  return sharedLeft
    ? combine(parts[0].left, inner.value)
    : combine(inner.value, parts[0].right);
}

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
  // 0단계: 밑이 행렬 심볼 하나뿐인 다항식(`A^3+4A^2+5A+2I`)이면 스칼라로 내려서
  // **스칼라 인수분해와 같은 경로**(이 함수 자체를 재귀 호출)를 태운 뒤 되돌린다.
  // `A` 는 자기 자신·`I` 와 교환 가능하므로 스칼라 다항식과 구조가 같다 — CE의
  // 완전한 다항식 인수분해를 그대로 물려받는다. 자리표지를 못 고르거나 내리기/
  // 올리기가 실패하면(방어적) 조용히 다음 단계로 넘어간다.
  if (!isScalar(e.shape)) {
    const base = detectSingleMatrixPolynomial(e);
    if (base !== null) {
      const placeholder = pickPlaceholderName(e);
      if (placeholder !== null) {
        const lowered = lowerToScalarPolynomial(e, placeholder);
        if (lowered.ok) {
          // 원래 env의 shapes를 그대로 물려준다 — 계수 안에 원래 심볼(벡터 등)이
          // 통째로 남아있을 수 있고(`(v·w)A^2+…`), 그게 CE 왕복(`viaCe`)을 타면
          // `render`→재`elaborate` 되는데, 그때 이 env로 모양을 다시 찾는다. 자리표지
          // 만 아는 좁은 env를 주면 그 심볼들이 미지→스칼라 기본값으로 잘못
          // 재해석된다(실측, 퍼즈가 잡음 — `r`,`u` 벡터가 스칼라로 둔갑).
          const scalarEnv: Env = { ...env, shapes: { ...env.shapes, [placeholder]: SCALAR } };
          const factoredScalar = factorRaw(lowered.value, scalarEnv);
          if (factoredScalar.ok) {
            const lifted = liftFromScalarPolynomial(factoredScalar.value, placeholder, base);
            if (lifted.ok) return lifted;
          }
        }
      }
    }
  }
  // 구조적 추출을 **먼저** 시도한다. CE를 먼저 부르면 순수 스칼라 `AB+AC` 처럼
  // 우리 쪽이 할 수 있는 것까지 놓친다 (CE 0.90은 다변수 공통인수를 못 뽑는다, 실측).
  const structural = factorStructural(e, env);
  if (structural !== null) return structural;
  // 구조적으로 뽑을 게 없을 때만 CE에 맡긴다 — `x²-y²` 같은 건 거기가 낫다.
  if (isPureScalar(e)) return ok(viaCe(e, 'factor', env));
  return ok(e);
}

/**
 * 공통인수를 실제로 뽑아낸 경우에만 결과를 낸다. 뽑을 게 없으면 `null`.
 *
 * 2단계로 뽑는다 — 먼저 앞에서 공통 인수를 떼고, **그 몫에서 다시** 뒤에서 공통
 * 인수를 뗀다. `ABA+ACA` 처럼 양쪽에 공통 인수가 있는 식도 `A(B+C)A` 로 잡힌다
 * (단순한 2단계라 "최선의" 인수분해를 노리지 않는다 — 예: 앞을 조금 덜 떼면 뒤가
 * 더 떼지는 경우까지는 안 본다).
 */
function factorStructural(e: TypedExpr, env: Env): Result<TypedExpr> | null {
  const parsed = toPolynomial(e);
  if (!parsed.ok) return parsed;
  const p = combineLikeTerms(refineScalars(parsed.value, 'simplify', env, false)).filter(
    (m) => !isZero(m.coefficient),
  );
  if (p.length < 2) return null;

  const coefficient = commonNumeric(p);
  const scalars = commonScalars(p);

  // 1단계: 앞에서.
  const prefix = commonPrefixLength(p);
  const prefixShared = p[0].nonScalars.slice(0, prefix);
  const afterPrefix = p.map((m) => ({ ...m, nonScalars: m.nonScalars.slice(prefix) }));

  // 2단계: 1단계를 뗀 몫에서, 뒤에서.
  const suffix = commonSuffixLength(afterPrefix);
  const suffixShared = afterPrefix[0].nonScalars.slice(afterPrefix[0].nonScalars.length - suffix);

  if (prefix === 0 && suffix === 0) {
    // 인수 열에서 뽑을 게 없으면 내적/외적 쪽을 본다 (`u·v + u·w → u·(v+w)`).
    const bilinear = factorBilinear(p);
    if (bilinear !== null) return bilinear;
    if (coefficient === 1 && scalars.length === 0) return null;
  }

  const cores = afterPrefix.map((m) => coreFactors(m.nonScalars, suffix));
  const coreShape = inferCoreShape(cores, prefixShared, suffixShared, e.shape);
  const filledCores: (readonly TypedExpr[])[] = [];
  for (const core of cores) {
    const filled = insertIdentityIfEmpty(core, coreShape);
    // 행렬 자리인데 모양을 못 정하면 이 추출은 포기한다 — 값을 못 내는 트리를
    // 만드느니 원래 식을 돌려주는 게 안전하다.
    if (filled === null) return null;
    filledCores.push(filled);
  }

  const remainder: Monomial[] = p.map((m, i) => ({
    // `coefficient` 은 위에서 정수임이 보장된다 (`commonNumeric`).
    coefficient: divideByInt(m.coefficient, coefficient),
    scalars: removeOnce(m.scalars, scalars),
    nonScalars: filledCores[i],
  }));

  const inner = fromPolynomial(remainder, coreShape);
  if (!inner.ok) return inner;

  // 몫이 스칼라이고 항이 여럿이면 CE factor 를 이어 붙인다 — `2x^2+4x+2` 에서
  // 공통 계수 `2` 만 떼면 `x^2+2x+1` 이 남는데, 그건 CE가 `(x+1)^2` 로 더 풀 수 있다.
  // 몫이 행렬이면(비스칼라 인수가 남아있으면) CE엔 절대 못 넘긴다 — 스칼라만 위임.
  const refined =
    isScalar(inner.value.shape) && remainder.length > 1
      ? viaCe(inner.value, 'factor', env)
      : inner.value;

  const parts: TypedExpr[] = [];
  if (coefficient !== 1) parts.push({ op: 'num', shape: SCALAR, value: intLit(coefficient) });
  parts.push(...scalars, ...prefixShared, refined, ...suffixShared);
  return buildMulAll(parts);
}

/** 인수 열의 앞 `suffix` 만큼을 뺀 나머지(뒤에서 뗀 core). */
const coreFactors = (nonScalars: readonly TypedExpr[], suffix: number): readonly TypedExpr[] =>
  nonScalars.slice(0, nonScalars.length - suffix);
