import { buildAdd, buildFrac, buildMul } from '../expression/builders';
import { fromPolynomial, toPolynomial } from '../polynomial/convert';
import { constantInteger, exprKey } from '../expression/key';
import { intLit } from '../literal/literal';
import { fail, ok, type Result } from '../result/result';
import { SCALAR, isScalar, isSquare } from '../shape/shape';
import type { TypedExpr } from '../expression/node';
import { freeSymbols } from './evaluate';

/**
 * 단일 행렬 심볼 다항식 — `factor` 3단계(§ 계획).
 *
 * 행렬 심볼이 **하나뿐인** 다항식(`A^3+4A^2+5A+2I`)은 `A` 가 자기 자신·`I` 와
 * 교환 가능하므로 스칼라 다항식과 구조적으로 같은 문제다. 여기서는 그 사실을 이용해
 * 스칼라 자리표지 `x` 로 **내리고**(`lower`), 스칼라 인수분해 경로(`factorRaw` 재귀
 * 호출 — `transform.ts` 쪽에서 한다, 순환 참조를 피하려고 이 파일은 그 호출을 모른다)
 * 를 그대로 태운 뒤, 결과를 다시 행렬 식으로 **올린다**(`lift`).
 *
 * 스칼라 인수분해가 나중에 개선되면(공유 진입점이 CE와 더 잘 엮이면) 이 경로도
 * 자동으로 좋아진다 — 그게 이 파일을 따로 둔 이유다.
 */

/** CE·구조에서 예약된 뜻이 있어 자리표지로 쓰면 안 되는 홑 글자. */
const RESERVED_PLACEHOLDER_LETTERS = new Set(['I', 'e', 'i', 'T']);

/** 흔히 쓰는 순서로 훑는 자리표지 후보 글자 풀. */
const PLACEHOLDER_CANDIDATES = 'xyzuvwpqrstmn'.split('');

/**
 * 식에서 자유롭게 쓸 수 있는 홑 글자 자리표지를 고른다. 이미 쓰인 이름과, `I`/`e`/`i`/`T`
 * 처럼 다른 뜻이 있는 글자는 피한다. 못 찾으면 `null` — 호출자는 이 경로를 포기한다.
 */
export function pickPlaceholderName(e: TypedExpr): string | null {
  const used = new Set(freeSymbols(e));
  for (const letter of PLACEHOLDER_CANDIDATES) {
    if (!used.has(letter) && !RESERVED_PLACEHOLDER_LETTERS.has(letter)) return letter;
  }
  return null;
}

/**
 * `e` 가 "행렬 심볼 하나의 다항식"인지 판정하고, 맞으면 그 공통 밑을 돌려준다.
 *
 * 판정 기준: `toPolynomial` 로 편 각 단항식에서 `matIdentity` 를 뺀 비스칼라 인수
 * 열(`effective`)이, 있다면 전부 **같은 밑의 반복**이어야 하고, 그 밑이 모든 항에서
 * **동일**해야 한다. 계수(`m.scalars`/`m.numeric`)는 안 본다 — 안에 `v·w` 같은 게
 * 있어도 상관없다, 모양만 스칼라면 된다(이미 `toPolynomial` 이 보장한다).
 *
 * 상수항만 있거나(밑을 확정 못 함) 항이 하나뿐이면(인수분해할 합이 아님) `null`.
 */
export function detectSingleMatrixPolynomial(e: TypedExpr): TypedExpr | null {
  const parsed = toPolynomial(e);
  if (!parsed.ok || parsed.value.length < 2) return null;

  let base: TypedExpr | null = null;
  for (const m of parsed.value) {
    const effective = m.factors.filter((f) => f.op !== 'matIdentity');
    if (effective.length === 0) continue; // 상수항 — 밑 후보가 아니다.
    const key = exprKey(effective[0]);
    if (!effective.every((f) => exprKey(f) === key)) return null; // 한 항 안에서도 밑이 안 같다.
    if (base === null) {
      if (!isSquare(effective[0].shape)) return null;
      base = effective[0];
    } else if (exprKey(base) !== key) {
      return null; // 항마다 밑이 다르다.
    }
  }
  return base;
}

/**
 * `e`(밑이 `base` 하나뿐인 다항식)를 자리표지 `placeholderName` 의 스칼라 다항식으로.
 *
 * 각 단항식의 비스칼라 인수 개수(= `matIdentity` 를 뺀 차수)를 지수로 삼아
 * `numeric·scalars·placeholder^n` 으로 바꾼다. 계수(`numeric`/`scalars`)는 이미
 * 스칼라라 손대지 않고 그대로 옮긴다.
 */
export function lowerToScalarPolynomial(e: TypedExpr, placeholderName: string): Result<TypedExpr> {
  const parsed = toPolynomial(e);
  if (!parsed.ok) return parsed;
  const placeholder: TypedExpr = { op: 'sym', shape: SCALAR, name: placeholderName };

  const terms = parsed.value.map((m) => {
    const degree = m.factors.filter((f) => f.op !== 'matIdentity').length;
    if (degree === 0) return { numeric: m.numeric, scalars: m.scalars, factors: [] };
    if (degree === 1) return { numeric: m.numeric, scalars: [...m.scalars, placeholder], factors: [] };
    const power: TypedExpr = {
      op: 'scalarPow',
      shape: SCALAR,
      base: placeholder,
      exponent: { op: 'num', shape: SCALAR, value: intLit(degree) },
    };
    return { numeric: m.numeric, scalars: [...m.scalars, power], factors: [] };
  });
  return fromPolynomial(terms, SCALAR);
}

/**
 * 자리표지 스칼라 다항식의 인수분해 결과를 다시 `base` 행렬 식으로 되돌린다.
 *
 * `sym(placeholder)` → `base`, `scalarPow(placeholder, n)` → `matPow(base, n)` 로
 * 바꾸고 나머지는 재귀한다. `add` 에서 항 일부만 행렬이 되면(상수항 `1` 처럼) 남은
 * 스칼라 항을 `matIdentity` 로 승격한다 — `buildMul` 로 만들면 모양 검사가 같이 돈다.
 *
 * CE `factor` 는 순수 스칼라 다항식만 돌려주므로 `matrix`/`matMul`/`dot`/`cross`/
 * `transpose`/`matPow`/`matIdentity` 는 이 결과에 나타날 수 없다 — 나오면 우리가
 * 놓친 경우이니 조용히 넘기지 않고 오류로 세운다.
 */
export function liftFromScalarPolynomial(
  scalarResult: TypedExpr,
  placeholderName: string,
  base: TypedExpr,
): Result<TypedExpr> {
  const lift = (node: TypedExpr): Result<TypedExpr> => {
    if (node.op === 'sym' && node.name === placeholderName) return ok(base);

    switch (node.op) {
      case 'num':
      case 'sym':
        return ok(node);

      case 'neg': {
        const inner = lift(node.operand);
        if (!inner.ok) return inner;
        return ok({ op: 'neg', shape: inner.value.shape, operand: inner.value });
      }

      case 'add': {
        const lifted: TypedExpr[] = [];
        for (const term of node.terms) {
          const l = lift(term);
          if (!l.ok) return l;
          lifted.push(l.value);
        }
        if (lifted.every((t) => isScalar(t.shape))) return buildAdd(lifted);
        const promoted: TypedExpr[] = [];
        for (const term of lifted) {
          if (!isScalar(term.shape)) {
            promoted.push(term);
            continue;
          }
          // 행렬 항들 사이에 낀 순수 스칼라 항(상수)을 `t·I` 로 승격한다.
          const withIdentity = buildMul(term, { op: 'matIdentity', shape: base.shape });
          if (!withIdentity.ok) return withIdentity;
          promoted.push(withIdentity.value);
        }
        return buildAdd(promoted);
      }

      case 'scalarMul': {
        const lifted: TypedExpr[] = [];
        for (const f of node.factors) {
          const l = lift(f);
          if (!l.ok) return l;
          lifted.push(l.value);
        }
        // 스칼라와 행렬로 갈라 **각각 따로 접은 뒤** 마지막에 한 번만 합친다.
        // 순서대로(스칼라 낀 채) 하나씩 buildMul을 접으면, 스칼라*행렬 → `mul` 노드가
        // 나온 다음 그걸 다시 행렬과 곱하려다 `mul` 노드를 행렬곱 인수로 넣는
        // 비정상 중첩(`matMul` 안에 `mul`)이 생겨 뒤따르는 normalize가 이를 잘못
        // 다룬다(실측, 퍼즈가 잡음). 스칼라는 전부 교환 가능하므로 행렬 인수들의
        // **상대 순서만 지키면** 미리 갈라 모아도 값이 같다.
        const scalarParts = lifted.filter((f) => isScalar(f.shape));
        const matrixParts = lifted.filter((f) => !isScalar(f.shape));
        const foldChain = (parts: readonly TypedExpr[]): Result<TypedExpr> | null =>
          parts.length === 0
            ? null
            : parts
                .slice(1)
                .reduce<Result<TypedExpr>>((acc, f) => (acc.ok ? buildMul(acc.value, f) : acc), ok(parts[0]));
        const scalarProduct = foldChain(scalarParts);
        const matrixProduct = foldChain(matrixParts);
        if (scalarProduct !== null && matrixProduct !== null) {
          if (!scalarProduct.ok) return scalarProduct;
          if (!matrixProduct.ok) return matrixProduct;
          return buildMul(scalarProduct.value, matrixProduct.value);
        }
        return (scalarProduct ?? matrixProduct) as Result<TypedExpr>;
      }

      case 'scalarPow': {
        // 밑을 먼저 올려본다 — 밑이 자리표지 자신(`x^2`)이든, 자리표지를 품은 합
        // (`(x+1)^2`, CE factor가 흔히 내는 꼴)이든 여기서 갈린다. 밑이 행렬이 되면
        // `matPow` 로, 아니면(순수 계수의 거듭제곱) `scalarPow` 그대로 재조립한다.
        const liftedBase = lift(node.base);
        if (!liftedBase.ok) return liftedBase;
        if (!isScalar(liftedBase.value.shape)) {
          const n = constantInteger(node.exponent);
          if (n === null || n < 1) {
            return fail('unsupported', '행렬 밑의 거듭제곱 지수가 양의 정수가 아니다');
          }
          return ok({ op: 'matPow', shape: liftedBase.value.shape, base: liftedBase.value, exponent: node.exponent });
        }
        const liftedExponent = lift(node.exponent);
        if (!liftedExponent.ok) return liftedExponent;
        return ok({ op: 'scalarPow', shape: SCALAR, base: liftedBase.value, exponent: liftedExponent.value });
      }

      case 'frac': {
        const numerator = lift(node.numerator);
        if (!numerator.ok) return numerator;
        const denominator = lift(node.denominator);
        if (!denominator.ok) return denominator;
        if (!isScalar(denominator.value.shape)) {
          return fail('unsupported', '행렬을 분모로 되돌릴 수 없다');
        }
        return buildFrac(numerator.value, denominator.value);
      }

      case 'call': {
        const args: TypedExpr[] = [];
        for (const a of node.args) {
          const l = lift(a);
          if (!l.ok) return l;
          if (!isScalar(l.value.shape)) {
            return fail('unsupported', `${node.name} 의 인수를 행렬로 되돌릴 수 없다`);
          }
          args.push(l.value);
        }
        return ok({ op: 'call', shape: SCALAR, name: node.name, args });
      }

      // 순수 스칼라 다항식의 CE factor 결과엔 나타날 수 없는 연산들 — 방어적으로 거절한다.
      // `apply`(사용자 정의 함수)도 같은 이유: 이 경로는 CE 왕복 전용이고 CE는 사용자
      // 함수를 모르므로 그 결과에 `apply` 가 나올 수 없다.
      case 'matrix':
      case 'matMul':
      case 'mul':
      case 'dot':
      case 'cross':
      case 'transpose':
      case 'matPow':
      case 'matIdentity':
      case 'deriv':
      case 'sum':
      case 'prod':
      case 'integral':
      case 'apply':
        return fail('unsupported', `되돌리는 중 예상 밖의 ${node.op} 을 만났다`);
    }
  };
  return lift(scalarResult);
}
