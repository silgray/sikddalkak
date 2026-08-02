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
  | { readonly op: 'scalarMul'; readonly shape: Shape; readonly left: TypedExpr; readonly right: TypedExpr }
  | { readonly op: 'matMul'; readonly shape: Shape; readonly left: TypedExpr; readonly right: TypedExpr }
  | { readonly op: 'dot'; readonly shape: Shape; readonly left: TypedExpr; readonly right: TypedExpr }
  | { readonly op: 'cross'; readonly shape: Shape; readonly left: TypedExpr; readonly right: TypedExpr }
  | { readonly op: 'transpose'; readonly shape: Shape; readonly operand: TypedExpr }
  | { readonly op: 'matPow'; readonly shape: Shape; readonly base: TypedExpr; readonly exponent: number }
  | { readonly op: 'scalarPow'; readonly shape: Shape; readonly base: TypedExpr; readonly exponent: TypedExpr }
  | { readonly op: 'call'; readonly shape: Shape; readonly name: string; readonly args: readonly TypedExpr[] };

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

/** 두 피연산자 중 스칼라가 아닌 쪽을 고른다 (스칼라곱의 결과 모양). */
const nonScalarShape = (a: Shape, b: Shape): Shape => (isScalar(a) ? b : a);

/** 성공한 결과에 부호를 씌운다. */
const negated = (result: Result<TypedExpr>): Result<TypedExpr> =>
  result.ok ? ok({ op: 'neg', shape: result.value.shape, operand: result.value }) : result;

// ---------------------------------------------------------------------------
// 곱 — 세 가지 표기(`·`, `×`, 병치)가 모양에 따라 서로 다른 연산으로 갈린다
// ---------------------------------------------------------------------------

/** 행렬곱. `(m,n)(n,p) -> (m,p)`. 안쪽 차원이 **확실히** 다를 때만 오류. */
function elaborateMatMul(left: TypedExpr, right: TypedExpr, symbol: string): Result<TypedExpr> {
  const a = left.shape;
  const b = right.shape;
  if (!isKnownShape(a) || !isKnownShape(b)) {
    return fail('unknown-shape', `Cannot determine the shape of a ${symbol} operand`);
  }
  if (a.cols !== b.rows) {
    return shapeMismatch(
      `Cannot multiply ${formatShape(a)} by ${formatShape(b)}: inner dimensions differ`,
    );
  }
  return ok({ op: 'matMul', shape: shape(a.rows, b.cols), left, right });
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
 * 병치(암묵적 곱) — 스칼라가 끼면 스칼라곱, 아니면 행렬곱.
 *
 * 재작성이 인수를 다시 곱해 조립할 때도 이 함수를 쓴다 (`mulTyped` 로 내보낸다).
 * 조립 규칙이 두 벌이 되면 모양·연산 판정이 어긋나므로 한 곳에 둔다.
 */
function elaborateJuxt(left: TypedExpr, right: TypedExpr): Result<TypedExpr> {
  // 부호는 곱 **밖으로** 끌어올린다. `A(-B)` = `-(AB)` 다 (부호는 스칼라라 자유롭게
  // 움직인다). 이렇게 해두면 곱 안에 `neg` 가 남지 않아 아래 묶음 정규화가 걸리지 않고,
  // 렌더도 `-AB` 한 가지로 수렴한다.
  if (left.op === 'neg') return negated(elaborateJuxt(left.operand, right));
  if (right.op === 'neg') return negated(elaborateJuxt(left, right.operand));

  // 곱은 **결합법칙이 있으므로** 왼쪽으로 모아 정규화한다. `A(BC)` 와 `(AB)C` 가 같은
  // 트리가 되어 렌더가 안정된다. (비가환과 혼동하지 말 것 — 인수의 **순서**는 그대로
  // 두고 **묶음**만 편다. `AB ≠ BA` 는 여전히 지켜진다.)
  //
  // 단, **모양이 맞을 때만** 편다. `C(ru)` 에서 `ru` 가 `(1,3)(3,1)` = 스칼라라면
  // `(Cr)u` 의 `Cr` 은 `(3,3)(1,3)` 이라 아예 존재하지 않는 곱이다. 차원이 맞아떨어질
  // 때 결합법칙이 성립한다는 뜻이므로, 안 맞으면 원래 묶음 그대로 두는 게 옳다.
  if (right.op === 'matMul' || right.op === 'scalarMul') {
    const merged = elaborateJuxt(left, right.left);
    if (merged.ok) {
      const reassociated = elaborateJuxt(merged.value, right.right);
      if (reassociated.ok) return reassociated;
    }
  }
  const a = left.shape;
  const b = right.shape;
  if (isScalar(a) || isScalar(b)) {
    return ok({ op: 'scalarMul', shape: nonScalarShape(a, b), left, right });
  }
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
  if (!isSquare(base.shape)) {
    return shapeMismatch(`Cannot raise a ${formatShape(base.shape)} to a power: not square`);
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
  const head = values[0].shape;
  for (const term of values.slice(1)) {
    // 모양이 **정확히 같아야** 한다. 행렬 + 스칼라는 오류다 (브로드캐스트하지 않는다).
    if (shapesConflict(head, term.shape) || isScalar(head) !== isScalar(term.shape)) {
      return shapeMismatch(
        `Cannot add ${formatShape(head)} and ${formatShape(term.shape)}`,
      );
    }
  }
  return ok({ op: 'add', shape: head, terms: values });
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
      // 정의되지 않은 자유 심볼은 **스칼라로 가정**한다 (환경이 끄지 않는 한).
      const known = env.shapes[node.name];
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
