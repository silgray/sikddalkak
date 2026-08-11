import {
  SCALAR,
  formatShape,
  isColumnVector,
  isKnownShape,
  isScalar,
  isSquare,
  isVector,
  sameOrientation,
  shape,
  shapesConflict,
  vectorLengthOf,
  type Shape,
} from '../shape/shape';
import { fail, ok, type Result } from '../result/result';
import type { Literal } from '../literal/literal';
import type { TypedExpr } from './node';

/**
 * Typed IR 스마트 생성자 — 노드 하나를 만들면서 **모양 검사를 같이 한다.**
 *
 * `elaborate` 와 재작성이 **같은 함수**를 쓴다. 조립 규칙이 두 벌이 되면 모양·연산 판정이
 * 어긋나므로 한 곳에만 둔다. 덕분에 재작성이 만든 트리도 자동으로 검사된다 — 곱해 붙였는데
 * 모양이 안 맞으면 여기서 오류가 나온다.
 *
 * **이 파일은 잎이다.** 자료 도메인(`shape/`·`literal/`·`result/`)과 자기 노드 타입
 * (`expr/node`) 밖으로 나가지 않는다 — **`Env` 도 `SyntaxNode` 도 모른다.** 다섯째
 * import 가 붙는다면 그건 여기 있으면 안 되는 코드가 섞여 들어온 것이다.
 * (`literal/` 은 `expr/node` 가 이미 의존하는 곳이라 새로 늘어난 의존이 아니다.)
 *
 * **정규화는 하지 않는다.** 중첩된 곱을 평탄화하거나, `neg`/숫자를 끌어올리거나, 이웃
 * 인수를 거듭제곱으로 접는 건 전부 `normalize` 의 몫이다(별도 패스). 여기서는 주어진 걸
 * 그대로 담기만 한다 — `buildMul(matMul(A,B), C)` 는 `matMul(matMul(A,B), C)` 로 중첩된
 * 채 나온다.
 */

export const failShapeMismatch = (message: string, where?: string): Result<TypedExpr> =>
  fail('shape-mismatch', message, where);

// ---------------------------------------------------------------------------
// 곱 — 세 가지 표기(`·`, `×`, 병치)가 모양에 따라 서로 다른 연산으로 갈린다
// ---------------------------------------------------------------------------

/**
 * `e` 가 (겉으로는 `mul`/`neg` 에 감싸여 있더라도) 안에 **아직 모양이 안 정해진
 * 행렬곱 항등원**을 품고 있는가. `kI`, `-I` 처럼 스칼라와 먼저 결합된 뒤에야 다른 피연산자를
 * 만나는 경우를 잡기 위해서다 — 그러지 않으면 `2 \cdot I \cdot a^{-1} \cdot v` 처럼
 * `I` 가 다른 스칼라와 먼저 묶여버린 식에서 상대(`v`)를 만나도 모양을 못 찾는다.
 */
function hasUnresolvedIdentity(e: TypedExpr): boolean {
  if (e.op === 'matIdentity') return !isKnownShape(e.shape);
  if (e.op === 'neg') return hasUnresolvedIdentity(e.operand);
  if (e.op === 'mul') return !isKnownShape(e.nonScalar.shape) && hasUnresolvedIdentity(e.nonScalar);
  return false;
}

/**
 * 하위 트리의 **미정 행렬곱 항등원을 `target` 모양으로 채운다**.
 *
 * elaborate는 바닥에서 위로 진행하므로 `I` 는 스스로 크기를 알 수 없고, 곱하거나
 * 더하는 상대가 알려줘야 한다. `mul`/`neg` 처럼 `I` 를 그대로 감싸고 있을 수 있는
 * **얇은 래퍼만** 뚫는다 — 이미 완성된 matMul/add는 **그 자체 생성 시점에** 이미
 * 해석이 끝나 있어야 정상이라(`buildMatMul` 이 매번 처리) 더 파고들 필요가 없다.
 */
function resolveIdentities(e: TypedExpr, target: Shape): TypedExpr {
  if (e.op === 'matIdentity') {
    return isKnownShape(e.shape) ? e : { op: 'matIdentity', shape: target };
  }
  if (e.op === 'neg') {
    return { ...e, operand: resolveIdentities(e.operand, target) };
  }
  if (e.op === 'mul' && !isKnownShape(e.nonScalar.shape)) {
    const nonScalar = resolveIdentities(e.nonScalar, target);
    return { ...e, nonScalar, shape: nonScalar.shape };
  }
  return e;
}

/**
 * 행렬곱. `(m,n)(n,p) -> (m,p)`. 안쪽 차원이 **확실히** 다를 때만 오류.
 *
 * 미정 행렬곱 항등원(`I`)이 (겉으로 `mul`/`neg` 에 감싸여 있어도) 한쪽에 있으면 **상대에게서
 * 모양을 유도**한다 — 정사각이므로 한 차원만 알면 결정된다(`AI` → I는 A.cols×A.cols,
 * `IA` → I는 A.rows×A.rows). 둘 다 미정 `I` 면 크기를 정하지 않아도 곱은 여전히 `I` 다.
 */
function buildMatMul(left: TypedExpr, right: TypedExpr, symbol: string): Result<TypedExpr> {
  let a = left.shape;
  let b = right.shape;
  let resolvedLeft = left;
  let resolvedRight = right;

  if (
    left.op === 'matIdentity' &&
    right.op === 'matIdentity' &&
    !isKnownShape(a) &&
    !isKnownShape(b)
  ) {
    return ok(left);
  }
  if (!isKnownShape(a) && isKnownShape(b) && hasUnresolvedIdentity(left)) {
    resolvedLeft = resolveIdentities(left, shape(b.rows, b.rows));
    a = resolvedLeft.shape;
  } else if (!isKnownShape(b) && isKnownShape(a) && hasUnresolvedIdentity(right)) {
    resolvedRight = resolveIdentities(right, shape(a.cols, a.cols));
    b = resolvedRight.shape;
  }

  if (!isKnownShape(a) || !isKnownShape(b)) {
    return fail('unknown-shape', `Cannot determine the shape of a ${symbol} operand`);
  }
  if (a.cols !== b.rows) {
    return failShapeMismatch(
      `Cannot multiply ${formatShape(a)} by ${formatShape(b)}: inner dimensions differ`,
    );
  }
  return ok({
    op: 'matMul',
    shape: shape(a.rows, b.cols),
    factors: [resolvedLeft, resolvedRight],
  });
}

/**
 * `\cdot` — 스칼라가 끼면 스칼라곱, 같은 방향 같은 길이 벡터끼리면 **내적**,
 * 그 밖에는 행렬곱.
 */
export function buildDot(left: TypedExpr, right: TypedExpr): Result<TypedExpr> {
  const a = left.shape;
  const b = right.shape;
  // 곱으로 판명된 경우는 병치와 **같은 경로**를 타야 한다. 렌더는 `·`/`×`/병치를 전부
  // 병치로 내보내므로, 여기서만 묶음 정규화를 건너뛰면 다시 읽었을 때 트리가 달라진다.
  if (isScalar(a) || isScalar(b)) {
    return buildMul(left, right);
  }
  if (isVector(a) && isVector(b)) {
    if (!sameOrientation(a, b)) {
      return failShapeMismatch(
        `Cannot take the dot product of a ${formatShape(a)} and a ${formatShape(b)}`,
      );
    }
    if (vectorLengthOf(a) !== vectorLengthOf(b)) {
      return failShapeMismatch(
        `Dot product needs vectors of equal length (${formatShape(a)} and ${formatShape(b)})`,
      );
    }
    return ok({ op: 'dot', shape: SCALAR, left, right });
  }
  return buildMul(left, right);
}

/** `\times` — 스칼라가 끼면 스칼라곱, 3-벡터끼리면 **외적**, 그 밖에는 행렬곱. */
export function buildCross(left: TypedExpr, right: TypedExpr): Result<TypedExpr> {
  const a = left.shape;
  const b = right.shape;
  if (isScalar(a) || isScalar(b)) {
    return buildMul(left, right);
  }
  if (isVector(a) && isVector(b)) {
    if (vectorLengthOf(a) !== 3 || vectorLengthOf(b) !== 3) {
      return failShapeMismatch(
        `Cross product needs two 3-vectors (got ${formatShape(a)} and ${formatShape(b)})`,
      );
    }
    if (!sameOrientation(a, b)) {
      return failShapeMismatch(
        `Cannot take the cross product of a ${formatShape(a)} and a ${formatShape(b)}`,
      );
    }
    return ok({ op: 'cross', shape: a, left, right });
  }
  return buildMul(left, right);
}

/**
 * 병치(암묵적 곱) — 스칼라·행렬 중 무엇끼리인지에 따라 `scalarMul`/`matMul`/`mul` 셋 중
 * 하나를 고른다.
 */
export function buildMul(left: TypedExpr, right: TypedExpr): Result<TypedExpr> {
  const a = left.shape;
  const b = right.shape;
  const aScalar = isScalar(a);
  const bScalar = isScalar(b);

  if (aScalar && bScalar) {
    return ok({ op: 'scalarMul', shape: SCALAR, factors: [left, right] });
  }
  if (aScalar !== bScalar) {
    // 정확히 한쪽만 스칼라 — `mul(scalar, nonScalar)`. 스칼라는 자유롭게 움직이므로
    // 어느 쪽에 썼는지(`kA` 든 `Ak` 든)는 `scalar`/`nonScalar` 필드 배정에 영향을 주지
    // 않는다 — 값이 아니라 **모양**으로 역할을 정한다.
    const [scalar, nonScalar] = aScalar ? [left, right] : [right, left];
    return ok({ op: 'mul', shape: nonScalar.shape, scalar, nonScalar });
  }
  // 둘 다 비스칼라 — 행렬곱. (좌결합 재결합은 하지 않는다: 결과가 `matMul(A,B)` 처럼
  // 중첩돼도 normalize가 나중에 평탄화한다.)
  return buildMatMul(left, right, 'product');
}

/**
 * 인수 열을 병치로 **왼쪽부터** 접는다. 하나라도 모양이 안 맞으면 거기서 실패한다.
 * `parts` 는 비어 있으면 안 된다.
 */
export const buildMulAll = (parts: readonly TypedExpr[]): Result<TypedExpr> =>
  parts
    .slice(1)
    .reduce<Result<TypedExpr>>((acc, p) => (acc.ok ? buildMul(acc.value, p) : acc), ok(parts[0]));

// ---------------------------------------------------------------------------
// 그 밖의 노드
// ---------------------------------------------------------------------------

/** 부호 반전. 모양이 그대로라 실패할 수 없다 — `Result` 를 안 쓰는 빌더 둘 중 하나. */
export const buildNeg = (operand: TypedExpr): TypedExpr => ({
  op: 'neg',
  shape: operand.shape,
  operand,
});

/** 숫자 리터럴 노드. 리터럴은 늘 스칼라라 검사할 게 없다. */
export const buildNum = (value: Literal): TypedExpr => ({
  op: 'num',
  shape: SCALAR,
  value,
});

/** 전치. 모양을 뒤집는다. 스칼라에는 쓰지 않는다 (그건 일반 지수다). */
export function buildTranspose(operand: TypedExpr): Result<TypedExpr> {
  // I^T = I — 미정이어도 정사각이 전제라 뒤집어도 그대로다.
  if (operand.op === 'matIdentity') return ok(operand);
  if (isScalar(operand.shape)) return ok(operand);
  const s = operand.shape;
  return ok({ op: 'transpose', shape: shape(s.cols, s.rows), operand });
}

/**
 * `\frac{numerator}{denominator}`. 분모는 스칼라여야 한다 — 행렬 나눗셈은 정의하지
 * 않는다(역행렬을 명시적으로 쓰게 한다).
 */
export function buildFrac(numerator: TypedExpr, denominator: TypedExpr): Result<TypedExpr> {
  if (!isScalar(denominator.shape)) {
    return failShapeMismatch(
      `Cannot divide by a ${formatShape(denominator.shape)}: use an inverse instead`,
    );
  }
  return ok({ op: 'frac', shape: numerator.shape, numerator, denominator });
}

/** 이미 elaborate된 항들을 더한다. */
export function buildAdd(values: readonly TypedExpr[]): Result<TypedExpr> {
  if (values.length === 0) return fail('malformed', 'Empty sum');
  if (values.length === 1) return ok(values[0]);
  // 덧셈은 결합법칙이 있으므로 중첩을 편다. CE는 `x-y-z` 를 중첩 `Subtract` 로 주는데,
  // 그대로 두면 안쪽 덧셈이 항으로 취급돼 렌더에 없던 괄호가 생긴다.
  const flat = values.flatMap((v) => (v.op === 'add' ? v.terms : [v]));
  if (flat.length !== values.length) return buildAdd(flat);

  // 항 중 **정사각으로 확정된** 모양이 있으면, 그걸 기준으로 미정 행렬곱 항등원(`I`)을 채운다.
  // 정사각만 보는 이유: `I` 는 정사각이어야만 뜻이 있다 — `M+I`(M이 2×3 직사각)에서
  // M의 모양으로 I를 억지로 맞추면 "2×3 행렬곱 항등원"이라는 말이 안 되는 게 조용히 통과한다.
  // 정사각 기준이 없으면 미정인 채로 두고, 끝내 아무도 안 알려주면 normalize가
  // (1,1)로 굳힌다 — 그러면 M(2×3)과 모양이 안 맞아 정상적으로 오류가 난다.
  const known = flat.find((v) => isKnownShape(v.shape) && isSquare(v.shape));
  const values2 = known === undefined ? flat : flat.map((v) => resolveIdentities(v, known.shape));

  const head = values2[0].shape;
  for (const term of values2.slice(1)) {
    // 모양이 **정확히 같아야** 한다. 행렬 + 스칼라는 오류다 (브로드캐스트하지 않는다).
    if (shapesConflict(head, term.shape) || isScalar(head) !== isScalar(term.shape)) {
      return failShapeMismatch(
        `Cannot add ${formatShape(head)} and ${formatShape(term.shape)}`,
      );
    }
  }
  return ok({ op: 'add', shape: head, terms: values2 });
}

// ---------------------------------------------------------------------------
// 바운드 변수를 갖는 노드 — 미분/합/적분/곱
// ---------------------------------------------------------------------------

/**
 * 미분. `vars.length === 1` 이면 원소별(모양 불변). 다변수는 numerator layout —
 * 스칼라 본문은 그래디언트(`(1,n)` 행벡터), 열벡터 본문은 야코비안(`(m,n)`). 행벡터·
 * 일반 행렬 본문은 3-텐서가 되어 표현할 수 없으므로 오류다.
 */
export function buildDeriv(
  body: TypedExpr,
  vars: readonly string[],
  order: number,
): Result<TypedExpr> {
  if (vars.length === 1) {
    return ok({ op: 'deriv', shape: body.shape, body, vars, order });
  }
  if (order > 1) {
    return fail('unsupported', 'Repeated multivariable differentiation is not supported');
  }
  if (!isKnownShape(body.shape)) {
    return fail('unknown-shape', 'Cannot determine the shape of the differentiation body');
  }
  if (isScalar(body.shape)) {
    return ok({ op: 'deriv', shape: shape(1, vars.length), body, vars, order });
  }
  if (isColumnVector(body.shape)) {
    return ok({ op: 'deriv', shape: shape(body.shape.rows, vars.length), body, vars, order });
  }
  return failShapeMismatch(
    `Cannot take a multivariable derivative of a ${formatShape(body.shape)} body (need a scalar or a column vector)`,
  );
}

/** `\sum` — 본문 모양을 그대로 물려받는다(원소별 합). 상하한은 스칼라여야 한다. */
export function buildSum(
  body: TypedExpr,
  variable: string,
  lower: TypedExpr | null,
  upper: TypedExpr | null,
): Result<TypedExpr> {
  if (lower !== null && !isScalar(lower.shape)) return failShapeMismatch('A lower bound must be a scalar');
  if (upper !== null && !isScalar(upper.shape)) return failShapeMismatch('An upper bound must be a scalar');
  return ok({ op: 'sum', shape: body.shape, body, variable, lower, upper });
}

/** `\int` — `sum` 과 같은 모양 규약. */
export function buildIntegral(
  body: TypedExpr,
  variable: string,
  lower: TypedExpr | null,
  upper: TypedExpr | null,
): Result<TypedExpr> {
  if (lower !== null && !isScalar(lower.shape)) return failShapeMismatch('A lower bound must be a scalar');
  if (upper !== null && !isScalar(upper.shape)) return failShapeMismatch('An upper bound must be a scalar');
  return ok({ op: 'integral', shape: body.shape, body, variable, lower, upper });
}

/** `\prod` — 본문이 **정사각**이어야 한다(행렬곱이 되므로). 스칼라(1,1)도 정사각이다. */
export function buildProd(
  body: TypedExpr,
  variable: string,
  lower: TypedExpr | null,
  upper: TypedExpr | null,
): Result<TypedExpr> {
  if (lower !== null && !isScalar(lower.shape)) return failShapeMismatch('A lower bound must be a scalar');
  if (upper !== null && !isScalar(upper.shape)) return failShapeMismatch('An upper bound must be a scalar');
  if (!isKnownShape(body.shape)) {
    return fail('unknown-shape', 'Cannot determine the shape of a product body');
  }
  if (!isSquare(body.shape)) {
    return failShapeMismatch(`A product needs a square body (got ${formatShape(body.shape)})`);
  }
  return ok({ op: 'prod', shape: body.shape, body, variable, lower, upper });
}
