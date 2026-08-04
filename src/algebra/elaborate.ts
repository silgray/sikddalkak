import {
  SCALAR,
  classify,
  formatShape,
  isKnownShape,
  isScalar,
  isSquare,
  isVector,
  sameOrientation,
  shape,
  shapesConflict,
  vectorLength,
  type Shape,
} from './shape';
import { fail, failWith, ok, type AlgebraError, type Result } from './result';
import type { SyntaxNode } from './syntax';

/**
 * Elaborate — **연산자 해석 + 차원 검사 + 모양 계산을 한 패스로** 한다.
 *
 * 셋을 나눌 수 없는 이유: `\cdot` 이 내적인지 스칼라곱인지는 피연산자 **모양**을 알아야
 * 정해지고, 결과 모양은 **연산자**가 정해져야 나온다. 상호 의존이라 분리하면 어긋난다.
 * 그래서 바닥에서 위로 한 번 훑으며 노드마다 `(연산, 모양)` 을 동시에 확정한다.
 *
 * 모양은 `(rows, cols)` 하나뿐이고 `(1,1)` 이 곧 스칼라다. 덕분에 특수 규칙 없이
 * `v^T v` = `(1,n)(n,1)` = `(1,1)` = 스칼라가 나온다.
 */

export type TypedExpr =
  | { readonly op: 'num'; readonly shape: Shape; readonly value: number }
  | { readonly op: 'sym'; readonly shape: Shape; readonly name: string }
  | { readonly op: 'matrix'; readonly shape: Shape; readonly rows: readonly (readonly TypedExpr[])[] }
  | { readonly op: 'add'; readonly shape: Shape; readonly terms: readonly TypedExpr[] }
  | { readonly op: 'neg'; readonly shape: Shape; readonly operand: TypedExpr }
  /**
   * 스칼라끼리의 곱. **n-항** — 이항 트리로 두면 `AABBAAAu` 같은 식이 7겹으로 중첩돼
   * 구조를 알아볼 수 없다. `elaborate` 는 정규화 없이 둘씩만 담고(중첩된 채로 둔다),
   * `normalize` 가 평탄화·정렬·숫자 접기를 한다. 정규화가 끝난 뒤의 불변식: 길이 ≥ 2,
   * 전부 스칼라 모양, 숫자 리터럴은 최대 1개(있다면 맨 앞), 나머지는 `exprKey` 순 정렬.
   */
  | { readonly op: 'scalarMul'; readonly shape: Shape; readonly factors: readonly TypedExpr[] }
  /**
   * 행렬끼리의 곱. **n-항**, 이유는 `scalarMul` 과 같다. 정규화 후 불변식: 길이 ≥ 2,
   * 전부 비스칼라 모양. **순서는 절대 정렬하지 않는다** — 인수 순서가 비가환을 지키는
   * 지점이다 (`ABA` 와 `A²B` 는 같은 인수 열이 될 수 없다).
   */
  | { readonly op: 'matMul'; readonly shape: Shape; readonly factors: readonly TypedExpr[] }
  /**
   * 스칼라 부분과 행렬 부분이 섞인 곱. `scalar` 는 스칼라 모양(단일 심볼이거나
   * `scalarMul` 일 수 있다), `matrix` 는 비스칼라 모양(단일 심볼이거나 `matMul`일 수
   * 있다). 한쪽만 있으면 이 노드를 만들지 않고 `scalarMul`/`matMul` 을 그대로 쓴다.
   */
  | { readonly op: 'mul'; readonly shape: Shape; readonly scalar: TypedExpr; readonly matrix: TypedExpr }
  | { readonly op: 'dot'; readonly shape: Shape; readonly left: TypedExpr; readonly right: TypedExpr }
  | { readonly op: 'cross'; readonly shape: Shape; readonly left: TypedExpr; readonly right: TypedExpr }
  | { readonly op: 'transpose'; readonly shape: Shape; readonly operand: TypedExpr }
  | { readonly op: 'matPow'; readonly shape: Shape; readonly base: TypedExpr; readonly exponent: number }
  | { readonly op: 'scalarPow'; readonly shape: Shape; readonly base: TypedExpr; readonly exponent: TypedExpr }
  | { readonly op: 'call'; readonly shape: Shape; readonly name: string; readonly args: readonly TypedExpr[] }
  /**
   * 항등행렬 `I`. 모양은 미정(`{rows:'unknown',cols:'unknown'}`)일 수 있다 — elaborate가
   * 바닥에서 위로 훑는 동안은 `I` 혼자서 크기를 알 길이 없고, 곱하거나 더하는 **상대**가
   * 알려줘야 한다(`resolveIdentities`). 끝까지 아무도 안 알려주면 normalize가 `(1,1)`
   * (스칼라 1과 같음)로 굳힌다. 전용 노드로 두는 이유는 `sym` 이름 `'I'` 로 흘려보내면
   * TypeScript가 switch 처리를 강제해주지 않아 numeric.ts 같은 곳에서 조용히
   * "값이 없다" 로 새어나가기 때문이다.
   */
  | { readonly op: 'matIdentity'; readonly shape: Shape };

/**
 * 심볼 환경.
 *
 * elaborate 자신은 `shapes` 만 본다. `bindings` 는 치환이, `functions` 는 나중에 들어올
 * 심볼릭 함수 전개 패스가 쓴다 — **레코드 형태를 미리 잡아두는** 이유는 나중에 시그니처를
 * 전부 고치지 않기 위해서다 (설계 §11).
 *
 * 값이 `TypedExpr` 인 건 이 모듈의 내부 통화가 그것이기 때문이다. LaTeX을 받는 건
 * 바깥 경계(`index.ts`)의 몫이다.
 */
export type Env = {
  readonly shapes: Readonly<Record<string, Shape>>;
  /** 심볼 → 그 심볼이 정의된 식. 치환이 쓴다. */
  readonly bindings?: Readonly<Record<string, TypedExpr>>;
  /** 심볼릭 함수 정의 자리 — 지금은 비어 있다 (설계 §11). */
  readonly functions?: Readonly<Record<string, unknown>>;
  /**
   * 모르는 심볼을 스칼라로 볼 것인가 (기본 `true`).
   *
   * 사용자 식에는 참이어야 한다 — 처음 쓰는 문자마다 오류를 낼 수는 없다. 하지만
   * **정의들끼리 모양을 풀어나갈 때는 거짓이어야** 한다. `B = A^T` 를 `A` 보다 먼저
   * 만나면 스칼라 가정이 곧바로 `B = 스칼라` 로 굳어버려, 나중에 `A` 가 행렬로 밝혀져도
   * 되돌릴 수 없다 (`buildEnv` 참고).
   */
  readonly assumeScalarForUnknown?: boolean;
};

/** 전치 표기로 인정하는 지수 심볼. */
const TRANSPOSE_MARKS = new Set(['T', 'top', 'intercal', '\\top', '\\intercal']);

const shapeMismatch = (message: string, where?: string): Result<TypedExpr> =>
  fail('shape-mismatch', message, where);

// ---------------------------------------------------------------------------
// 곱 — 세 가지 표기(`·`, `×`, 병치)가 모양에 따라 서로 다른 연산으로 갈린다
// ---------------------------------------------------------------------------

/**
 * `e` 가 (겉으로는 `mul`/`neg` 에 감싸여 있더라도) 안에 **아직 모양이 안 정해진
 * 항등원**을 품고 있는가. `kI`, `-I` 처럼 스칼라와 먼저 결합된 뒤에야 다른 피연산자를
 * 만나는 경우를 잡기 위해서다 — 그러지 않으면 `2 \cdot I \cdot a^{-1} \cdot v` 처럼
 * `I` 가 다른 스칼라와 먼저 묶여버린 식에서 상대(`v`)를 만나도 모양을 못 찾는다.
 */
function hasUnresolvedIdentity(e: TypedExpr): boolean {
  if (e.op === 'matIdentity') return !isKnownShape(e.shape);
  if (e.op === 'neg') return hasUnresolvedIdentity(e.operand);
  if (e.op === 'mul') return !isKnownShape(e.matrix.shape) && hasUnresolvedIdentity(e.matrix);
  return false;
}

/**
 * 행렬곱. `(m,n)(n,p) -> (m,p)`. 안쪽 차원이 **확실히** 다를 때만 오류.
 *
 * 미정 항등원(`I`)이 (겉으로 `mul`/`neg` 에 감싸여 있어도) 한쪽에 있으면 **상대에게서
 * 모양을 유도**한다 — 정사각이므로 한 차원만 알면 결정된다(`AI` → I는 A.cols×A.cols,
 * `IA` → I는 A.rows×A.rows). 둘 다 미정 `I` 면 크기를 정하지 않아도 곱은 여전히 `I` 다.
 */
function elaborateMatMul(left: TypedExpr, right: TypedExpr, symbol: string): Result<TypedExpr> {
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
    return shapeMismatch(
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
function elaborateCDot(left: TypedExpr, right: TypedExpr): Result<TypedExpr> {
  const a = left.shape;
  const b = right.shape;
  // 곱으로 판명된 경우는 병치와 **같은 경로**를 타야 한다. 렌더는 `·`/`×`/병치를 전부
  // 병치로 내보내므로, 여기서만 묶음 정규화를 건너뛰면 다시 읽었을 때 트리가 달라진다.
  if (isScalar(a) || isScalar(b)) {
    return elaborateJuxt(left, right);
  }
  if (isVector(a) && isVector(b)) {
    if (!sameOrientation(a, b)) {
      return shapeMismatch(
        `Cannot take the dot product of a ${formatShape(a)} and a ${formatShape(b)}`,
      );
    }
    if (vectorLength(a) !== vectorLength(b)) {
      return shapeMismatch(
        `Dot product needs vectors of equal length (${formatShape(a)} and ${formatShape(b)})`,
      );
    }
    return ok({ op: 'dot', shape: SCALAR, left, right });
  }
  return elaborateJuxt(left, right);
}

/** `\times` — 스칼라가 끼면 스칼라곱, 3-벡터끼리면 **외적**, 그 밖에는 행렬곱. */
function elaborateTimes(left: TypedExpr, right: TypedExpr): Result<TypedExpr> {
  const a = left.shape;
  const b = right.shape;
  if (isScalar(a) || isScalar(b)) {
    return elaborateJuxt(left, right);
  }
  if (isVector(a) && isVector(b)) {
    if (vectorLength(a) !== 3 || vectorLength(b) !== 3) {
      return shapeMismatch(
        `Cross product needs two 3-vectors (got ${formatShape(a)} and ${formatShape(b)})`,
      );
    }
    if (!sameOrientation(a, b)) {
      return shapeMismatch(
        `Cannot take the cross product of a ${formatShape(a)} and a ${formatShape(b)}`,
      );
    }
    return ok({ op: 'cross', shape: a, left, right });
  }
  return elaborateJuxt(left, right);
}

/**
 * 병치(암묵적 곱) — 스칼라·행렬 중 무엇끼리인지에 따라 `scalarMul`/`matMul`/`mul` 셋 중
 * 하나를 고른다. 재작성이 인수를 다시 곱해 조립할 때도 이 함수를 쓴다 (`mulTyped` 로
 * 내보낸다). 조립 규칙이 두 벌이 되면 모양·연산 판정이 어긋나므로 한 곳에 둔다.
 *
 * **정규화는 하지 않는다.** 중첩된 곱을 평탄화하거나, `neg`/숫자를 끌어올리거나,
 * 이웃 인수를 거듭제곱으로 접는 건 전부 `normalize` 의 몫이다 (별도 패스). 여기서는
 * 둘을 그대로 담기만 한다 — `elaborateJuxt(matMul(A,B), C)` 는 `matMul(matMul(A,B), C)`
 * 로 중첩된 채 나온다.
 */
function elaborateJuxt(left: TypedExpr, right: TypedExpr): Result<TypedExpr> {
  const a = left.shape;
  const b = right.shape;
  const aScalar = isScalar(a);
  const bScalar = isScalar(b);

  if (aScalar && bScalar) {
    return ok({ op: 'scalarMul', shape: SCALAR, factors: [left, right] });
  }
  if (aScalar !== bScalar) {
    // 정확히 한쪽만 스칼라 — `mul(scalar, matrix)`. 스칼라는 자유롭게 움직이므로
    // 어느 쪽에 썼는지(`kA` 든 `Ak` 든)는 `scalar`/`matrix` 필드 배정에 영향을 주지
    // 않는다 — 값이 아니라 **모양**으로 역할을 정한다.
    const [scalar, matrix] = aScalar ? [left, right] : [right, left];
    return ok({ op: 'mul', shape: matrix.shape, scalar, matrix });
  }
  // 둘 다 비스칼라 — 행렬곱. (좌결합 재결합은 하지 않는다: 결과가 `matMul(A,B)` 처럼
  // 중첩돼도 normalize가 나중에 평탄화한다.)
  return elaborateMatMul(left, right, 'product');
}

/**
 * 재작성이 쓰는 조립 생성자들 — elaborate가 쓰는 것과 **같은 함수**다.
 * 곱해 붙였는데 모양이 안 맞으면 오류가 나오므로, 재작성이 만든 트리도 자동으로 검사된다.
 */
export const mulTyped = elaborateJuxt;
export const dotTyped = elaborateCDot;
export const crossTyped = elaborateTimes;

/** 전치. 모양을 뒤집는다. 스칼라에는 쓰지 않는다 (그건 일반 지수다). */
export function transposeTyped(operand: TypedExpr): Result<TypedExpr> {
  // I^T = I — 미정이어도 정사각이 전제라 뒤집어도 그대로다.
  if (operand.op === 'matIdentity') return ok(operand);
  if (isScalar(operand.shape)) return ok(operand);
  const s = operand.shape;
  return ok({ op: 'transpose', shape: shape(s.cols, s.rows), operand });
}

// ---------------------------------------------------------------------------
// 거듭제곱 — `^T` 는 모양에 따라 전치 또는 일반 지수
// ---------------------------------------------------------------------------

function elaboratePow(base: TypedExpr, exponent: SyntaxNode, env: Env): Result<TypedExpr> {
  // `^T`: 비스칼라면 전치, **스칼라면 그냥 지수연산**(사용자 요구).
  if (exponent.kind === 'sym' && TRANSPOSE_MARKS.has(exponent.name)) {
    // I^T = I 그 자체 — 미정(unknown)이어도 정사각이 전제이므로 전치해도 안 바뀐다.
    // 이 분기가 없으면 isScalar(unknown)이 false로 나와 아래에서 transpose(I) 를 만들고,
    // 나중에 I가 스칼라로 굳어버릴 때(다른 문맥이 없으면) 안이 통째로 비어 모양이 깨진다.
    if (base.op === 'matIdentity') return ok(base);
    if (!isScalar(base.shape)) {
      const s = base.shape;
      return ok({ op: 'transpose', shape: shape(s.cols, s.rows), operand: base });
    }
    const marker = elaborate(exponent, env);
    if (!marker.ok) return marker;
    return ok({ op: 'scalarPow', shape: SCALAR, base, exponent: marker.value });
  }

  const exp = elaborate(exponent, env);
  if (!exp.ok) return exp;
  if (!isScalar(exp.value.shape)) {
    return shapeMismatch('An exponent must be a scalar');
  }
  if (isScalar(base.shape)) {
    return ok({ op: 'scalarPow', shape: SCALAR, base, exponent: exp.value });
  }
  // 비스칼라 밑 — 정사각 행렬의 정수 거듭제곱만 뜻이 있다.
  if (exp.value.op !== 'num' || !Number.isInteger(exp.value.value)) {
    return shapeMismatch('A matrix can only be raised to an integer power');
  }
  // 항등행렬은 미정이어도 정사각이 전제다 — 어떤 정수 지수든 I^n = I.
  if (base.op === 'matIdentity') {
    return ok(base);
  }
  if (!isSquare(base.shape)) {
    return shapeMismatch(`Cannot raise a ${formatShape(base.shape)} to a power: not square`);
  }
  // A^0 은 그 자체로 항등원이다 — matPow(A,0) 으로 남겨두면 다른 데서 또 판단해야 한다.
  if (exp.value.value === 0) {
    return ok({ op: 'matIdentity', shape: base.shape });
  }
  return ok({ op: 'matPow', shape: base.shape, base, exponent: exp.value.value });
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

function elaborateAdd(terms: readonly SyntaxNode[], env: Env): Result<TypedExpr> {
  const parsed = terms.map((t) => elaborate(t, env));
  const errors = parsed.flatMap((p) => (p.ok ? [] : p.errors));
  if (errors.length > 0) return failWith(errors);
  return addTyped(parsed.map((p) => (p as { value: TypedExpr }).value));
}

/**
 * 하위 트리의 **미정 항등원을 `target` 모양으로 채운다**.
 *
 * elaborate는 바닥에서 위로 진행하므로 `I` 는 스스로 크기를 알 수 없고, 곱하거나
 * 더하는 상대가 알려줘야 한다. `mul`/`neg` 처럼 `I` 를 그대로 감싸고 있을 수 있는
 * **얇은 래퍼만** 뚫는다 — 이미 완성된 matMul/add는 **그 자체 생성 시점에** 이미
 * 해석이 끝나 있어야 정상이라(elaborateMatMul이 매번 처리) 더 파고들 필요가 없다.
 */
function resolveIdentities(e: TypedExpr, target: Shape): TypedExpr {
  if (e.op === 'matIdentity') {
    return isKnownShape(e.shape) ? e : { op: 'matIdentity', shape: target };
  }
  if (e.op === 'neg') {
    return { ...e, operand: resolveIdentities(e.operand, target) };
  }
  if (e.op === 'mul' && !isKnownShape(e.matrix.shape)) {
    const matrix = resolveIdentities(e.matrix, target);
    return { ...e, matrix, shape: matrix.shape };
  }
  return e;
}

/**
 * 이미 elaborate된 항들을 더한다. 재작성이 항을 재조립할 때 **같은 규칙**을 쓰도록
 * 내보낸다 — 규칙이 두 벌이 되면 어긋난다.
 */
export function addTyped(values: readonly TypedExpr[]): Result<TypedExpr> {
  if (values.length === 0) return fail('malformed', 'Empty sum');
  if (values.length === 1) return ok(values[0]);
  // 덧셈은 결합법칙이 있으므로 중첩을 편다. CE는 `x-y-z` 를 중첩 `Subtract` 로 주는데,
  // 그대로 두면 안쪽 덧셈이 항으로 취급돼 렌더에 없던 괄호가 생긴다.
  const flat = values.flatMap((v) => (v.op === 'add' ? v.terms : [v]));
  if (flat.length !== values.length) return addTyped(flat);

  // 항 중 **정사각으로 확정된** 모양이 있으면, 그걸 기준으로 미정 항등원(`I`)을 채운다.
  // 정사각만 보는 이유: `I` 는 정사각이어야만 뜻이 있다 — `M+I`(M이 2×3 직사각)에서
  // M의 모양으로 I를 억지로 맞추면 "2×3 항등원"이라는 말이 안 되는 게 조용히 통과한다.
  // 정사각 기준이 없으면 미정인 채로 두고, 끝내 아무도 안 알려주면 normalize가
  // (1,1)로 굳힌다 — 그러면 M(2×3)과 모양이 안 맞아 정상적으로 오류가 난다.
  const known = flat.find((v) => isKnownShape(v.shape) && isSquare(v.shape));
  const values2 = known === undefined ? flat : flat.map((v) => resolveIdentities(v, known.shape));

  const head = values2[0].shape;
  for (const term of values2.slice(1)) {
    // 모양이 **정확히 같아야** 한다. 행렬 + 스칼라는 오류다 (브로드캐스트하지 않는다).
    if (shapesConflict(head, term.shape) || isScalar(head) !== isScalar(term.shape)) {
      return shapeMismatch(
        `Cannot add ${formatShape(head)} and ${formatShape(term.shape)}`,
      );
    }
  }
  return ok({ op: 'add', shape: head, terms: values2 });
}

function elaborateMatrixLit(
  rows: readonly (readonly SyntaxNode[])[],
  env: Env,
): Result<TypedExpr> {
  const errors: AlgebraError[] = [];
  const typedRows: TypedExpr[][] = [];
  for (const row of rows) {
    const cells: TypedExpr[] = [];
    for (const cell of row) {
      const t = elaborate(cell, env);
      if (!t.ok) {
        errors.push(...t.errors);
        continue;
      }
      // 행렬 안에 행렬/벡터는 넣을 수 없다.
      if (!isScalar(t.value.shape)) {
        errors.push({
          code: 'shape-mismatch',
          message: 'A matrix entry must be a scalar',
        });
        continue;
      }
      cells.push(t.value);
    }
    typedRows.push(cells);
  }
  if (errors.length > 0) return failWith(errors);
  if (typedRows.length === 0 || typedRows[0].length === 0) {
    return fail('malformed', 'A matrix needs at least one entry');
  }
  const colCount = typedRows[0].length;
  if (typedRows.some((r) => r.length !== colCount)) {
    return shapeMismatch('All matrix rows must have the same number of entries');
  }
  // 1x1 행렬은 스칼라와 같다 — 모양 도메인이 그렇게 정의돼 있다.
  return ok({ op: 'matrix', shape: shape(typedRows.length, colCount), rows: typedRows });
}

/** Syntax IR -> Typed IR. 실패하면 발견한 오류를 **모두** 모아서 돌려준다. */
export function elaborate(node: SyntaxNode, env: Env): Result<TypedExpr> {
  switch (node.kind) {
    case 'num':
      return ok({ op: 'num', shape: SCALAR, value: node.value });

    case 'sym': {
      const known = env.shapes[node.name];
      // `I` 는 예약어처럼 다루되, env에 사용자 정의가 있으면 그쪽이 이긴다.
      if (node.name === 'I' && known === undefined) {
        return ok({ op: 'matIdentity', shape: shape('unknown', 'unknown') });
      }
      // 정의되지 않은 자유 심볼은 **스칼라로 가정**한다 (환경이 끄지 않는 한).
      if (known === undefined && env.assumeScalarForUnknown === false) {
        return fail('unknown-shape', `The shape of ${node.name} is not known yet`, node.name);
      }
      return ok({ op: 'sym', shape: known ?? SCALAR, name: node.name });
    }

    case 'matrix':
      return elaborateMatrixLit(node.rows, env);

    case 'add':
      return elaborateAdd(node.terms, env);

    case 'neg': {
      const inner = elaborate(node.operand, env);
      return inner.ok ? ok({ op: 'neg', shape: inner.value.shape, operand: inner.value }) : inner;
    }

    case 'juxt':
    case 'cdot':
    case 'times': {
      const left = elaborate(node.left, env);
      const right = elaborate(node.right, env);
      if (!left.ok || !right.ok) {
        return failWith([...(left.ok ? [] : left.errors), ...(right.ok ? [] : right.errors)]);
      }
      if (node.kind === 'cdot') return elaborateCDot(left.value, right.value);
      if (node.kind === 'times') return elaborateTimes(left.value, right.value);
      return elaborateJuxt(left.value, right.value);
    }

    case 'pow': {
      const base = elaborate(node.base, env);
      if (!base.ok) return base;
      return elaboratePow(base.value, node.exponent, env);
    }

    case 'frac': {
      const numerator = elaborate(node.numerator, env);
      const denominator = elaborate(node.denominator, env);
      if (!numerator.ok || !denominator.ok) {
        return failWith([
          ...(numerator.ok ? [] : numerator.errors),
          ...(denominator.ok ? [] : denominator.errors),
        ]);
      }
      // 행렬 나눗셈은 정의하지 않는다 — 역행렬을 명시적으로 쓰게 한다.
      if (!isScalar(denominator.value.shape)) {
        return shapeMismatch(
          `Cannot divide by a ${formatShape(denominator.value.shape)}: use an inverse instead`,
        );
      }
      const reciprocal: TypedExpr = {
        op: 'scalarPow',
        shape: SCALAR,
        base: denominator.value,
        exponent: { op: 'num', shape: SCALAR, value: -1 },
      };
      // `\frac{1}{x}` 을 `1·x^{-1}` 로 두면 곱 안에 의미 없는 `1` 이 남아 렌더가 지저분해진다.
      if (numerator.value.op === 'num' && numerator.value.value === 1) return ok(reciprocal);
      return mulTyped(numerator.value, reciprocal);
    }

    case 'call': {
      const args = node.args.map((a) => elaborate(a, env));
      const errors = args.flatMap((a) => (a.ok ? [] : a.errors));
      if (errors.length > 0) return failWith(errors);
      const values = args.map((a) => (a as { value: TypedExpr }).value);
      const nonScalar = values.find((v) => !isScalar(v.shape));
      if (nonScalar !== undefined) {
        // 심볼릭 함수가 들어오면 elaborate 이전 전개 패스에서 이미 펼쳐져 있다.
        // 여기까지 온 비스칼라 인자는 `\sin(행렬)` 처럼 뜻이 정해지지 않은 경우다.
        return shapeMismatch(
          `${node.name} expects a scalar argument (got ${classify(nonScalar.shape)})`,
        );
      }
      return ok({ op: 'call', shape: SCALAR, name: node.name, args: values });
    }
  }
}
