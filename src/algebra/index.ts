import { elaborate } from './parse/elaborate';
import { type Env, type TypedExpr } from './types-TypedExpr';
import { normalize } from './parse/normalize';
import { exprKey } from './parse/normal';
import { fail, failWith, ok, type AlgebraError, type Result } from './types-result';
import { render } from './render';
import { expand, factor, simplify, substitute } from './transform/transform';
import { SCALAR, formatShape, type Shape } from './types-shape';
import { parseSyntax } from './parse/parseSymbol';
import type { SyntaxNode } from './types-SyntaxNode';

/**
 * 모듈 공개 API.
 *
 * 이 모듈이 아는 것은 **식 하나와 심볼 환경**뿐이다. 셀·문서·의존 그래프·React는 모른다.
 * `evaluateGraph` 같은 셀 사이 계산은 바깥에 남되, 이 코어 위에 세운다.
 */

export type { Dim, Shape, ShapeKind } from './types-shape';
export { SCALAR, classify, formatShape, isScalar, isVector, shape } from './types-shape';
export type { AlgebraError, ErrorCode, Result } from './types-result';
export type { Env, TypedExpr } from './types-TypedExpr';
export type { SyntaxNode } from './types-SyntaxNode';
export { render } from './render';
export { expand, factor, simplify, substitute, isPureScalar } from './transform/transform';
export { evalNumeric, matricesClose, type Assignment, type Matrix } from './numeric';
export { sexpSyntax, sexpTyped, sexpTypedWithShapes } from './debug';
export { OP_PROPERTIES, type BinaryOp, type OpProperties } from './opers';
export { normalize } from './parse/normalize';
export { evaluate, freeSymbols, substituteDeep } from './transform/evaluate';

export type TransformOp = 'expand' | 'simplify' | 'factor' | 'substitute';

const OPERATIONS: Record<TransformOp, (e: TypedExpr, env: Env) => Result<TypedExpr>> = {
  expand,
  simplify,
  factor,
  substitute,
};

/**
 * LaTeX → Typed IR. 모양이 안 맞거나 순서가 모호하면 오류를 낸다.
 *
 * elaborate 다음에 `normalize` 를 돌려 늘 정규화된(평탄화·스칼라 호이스팅·정렬) 트리를
 * 돌려준다 — 공개 API를 거친 트리는 중첩된 곱이나 흩어진 스칼라가 남아 있지 않다는 게
 * 이 함수의 계약이다.
 *
 * ⚠ **동류항은 합쳐진다.** `parse("A+A")` 는 `2A`, `parse("1+2")` 는 `3` 이다. 값을
 * 보존하는 재작성이지만 사용자가 쓴 글자 그대로는 아니다 (`normalize.ts` 서두 참고).
 * 분배는 하지 않으므로 `(A+B)C+(A+B)C` 는 `2(A+B)C` 로 남는다. 거듭제곱 접기(`AA`→`A²`)는
 * 여전히 `simplify` 전용이다.
 */
export function parse(latex: string, env: Env): Result<TypedExpr> {
  const syntax = parseSyntax(latex);
  if (!syntax.ok) return syntax;
  const typed = elaborate(syntax.value, env);
  if (!typed.ok) return typed;
  return normalize(typed.value);
}

export const shapeOf = (e: TypedExpr): Shape => e.shape;

/**
 * LaTeX → 변환 → LaTeX. 주 앱이 쓰게 될 형태.
 *
 * 선택 영역 변환이면 **선택된 부분의 LaTeX만** 넘기면 된다. 이 모듈은 문맥을 모르고,
 * 심볼의 모양은 전부 `env` 로 들어온다 — 그게 이번 재설계의 요점이다
 * (기존 `transformSelection` 은 문맥이 없어서 심볼이 행렬인지 알 수 없었다).
 */
export function transform(latex: string, op: TransformOp, env: Env): Result<string> {
  const parsed = parse(latex, env);
  if (!parsed.ok) return parsed;
  const rewritten = OPERATIONS[op](parsed.value, env);
  if (!rewritten.ok) return rewritten;
  return ok(render(rewritten.value));
}

// ---------------------------------------------------------------------------
// 환경 구성
// ---------------------------------------------------------------------------

/** 심볼 이름 → 그 심볼을 정의하는 LaTeX. */
export type Definitions = Readonly<Record<string, string>>;

export type BuiltEnv = {
  readonly env: Env;
  /** 끝내 모양을 정하지 못한 정의들. 순환 참조이거나 정의 자체가 틀린 경우다. */
  readonly unresolved: readonly AlgebraError[];
};

/**
 * LaTeX 정의들로 환경을 만든다.
 *
 * 정의가 서로를 참조할 수 있으므로(`B = A^T` 등) **더 이상 진전이 없을 때까지 반복**한다.
 * 위상 정렬 대신 고정점 반복을 쓰는 건 순환 참조를 자연스럽게 남기기 위해서다 —
 * 남은 것들이 곧 오류 목록이 된다.
 *
 * **두 판으로 나눠 도는 게 요점이다.**
 *  1판: 모르는 심볼을 오류로 취급한다. 그래야 `B = A^T` 가 `A` 를 기다린다. 스칼라로
 *       가정해버리면 `B = 스칼라` 로 굳어버려 나중에 `A` 가 행렬로 밝혀져도 늦는다.
 *  2판: 남은 것들에 스칼라 가정을 허용한다. `D = aB` 처럼 끝내 정의되지 않는 스칼라를
 *       참조하는 정의는 이래야 풀린다.
 *
 * ⚠ **순환 참조는 여기서 잡지 못한다.** `P = Q^T`, `Q = P^T` 는 2판의 스칼라 가정으로
 * 조용히 풀린다. 순환 검출은 셀 사이 의존 그래프의 일이라 이 모듈 밖에 있다 —
 * 이 모듈은 식 하나와 심볼 환경만 안다.
 */
export function buildEnv(definitions: Definitions): BuiltEnv {
  const shapes: Record<string, Shape> = {};
  const bindings: Record<string, TypedExpr> = {};
  let pending = Object.entries(definitions);

  // 1판: 모르는 심볼은 오류다(아래 docstring). 성공한 항목은 그 시점에 이미 **완전히
  // 확정된** 심볼들만으로 만들어졌으므로 다시 안 바뀐다 — 곧장 확정해도 안전하다.
  {
    let progressed = true;
    while (progressed && pending.length > 0) {
      progressed = false;
      const stillPending: [string, string][] = [];
      for (const [name, latex] of pending) {
        const parsed = parse(latex, { shapes, assumeScalarForUnknown: false });
        if (parsed.ok) {
          shapes[name] = parsed.value.shape;
          bindings[name] = parsed.value;
          progressed = true;
        } else {
          stillPending.push([name, latex]);
        }
      }
      pending = stillPending;
    }
  }

  // 2판: 스칼라 가정을 허용한다. 여기서는 **"파싱이 성공했다" != "확정됐다"** —
  // `w=Av` 가 아직 안 풀린 `A` 를 스칼라로 가정한 채 먼저 성공해버리면, 같은 판 안에서
  // `A` 자신이 뒤늦게 (진짜 모양으로) 풀려도 `w` 의 바인딩은 갱신할 기회가 없다.
  // 그래서 한 번 성공한 항목도 **전체 스윕에서 아무것도 안 바뀔 때까지** 계속 다시 판다
  // (`pending` 을 줄이지 않는다) — `shape`만 비교하면 놓친다: 잘못 가정된 `mul(A,v)`
  // 와 올바른 `matMul(A,v)` 는 모양이 우연히 같을 수 있어서(둘 다 (3,1)) `exprKey` 로
  // 구조까지 비교한다.
  {
    let changed = true;
    while (changed) {
      changed = false;
      const failing: [string, string][] = [];
      for (const [name, latex] of pending) {
        const parsed = parse(latex, { shapes, assumeScalarForUnknown: true });
        if (!parsed.ok) {
          failing.push([name, latex]);
          continue;
        }
        const prev = bindings[name];
        if (
          prev === undefined ||
          exprKey(prev) !== exprKey(parsed.value) ||
          formatShape(shapes[name]) !== formatShape(parsed.value.shape)
        ) {
          shapes[name] = parsed.value.shape;
          bindings[name] = parsed.value;
          changed = true;
        }
      }
      if (!changed) pending = failing;
    }
  }

  return {
    env: { shapes, bindings },
    unresolved: pending.map(([name]) => ({
      code: 'unknown-shape' as const,
      message: `Could not determine a shape for ${name}`,
      where: name,
    })),
  };
}

// ---------------------------------------------------------------------------
// 진단 — 랩 UI가 눈으로 확인하는 것들
// ---------------------------------------------------------------------------

export type Diagnostics = {
  readonly latex: string;
  readonly syntax: SyntaxNode | null;
  readonly typed: TypedExpr | null;
  readonly shape: Shape | null;
  readonly errors: readonly AlgebraError[];
};

/**
 * 한 식을 단계별로 뜯어본다. **어느 단계에서 무엇이 정해졌는지**를 보이는 게 목적이다:
 * 구조(우선순위·그룹) → 연산 해석과 모양 → 오류.
 *
 * `typed` 는 `parse()` 가 실제로 내보내는 것과 같은 정규화된 트리다 — elaborate 직후의
 * 중첩된 모습을 보여주면 진단 패널이 `transform()` 이 실제로 받는 입력과 달라진다.
 */
export function analyze(latex: string, env: Env): Diagnostics {
  const syntax = parseSyntax(latex);
  if (!syntax.ok) {
    return { latex, syntax: null, typed: null, shape: null, errors: syntax.errors };
  }
  const elaborated = elaborate(syntax.value, env);
  if (!elaborated.ok) {
    return { latex, syntax: syntax.value, typed: null, shape: null, errors: elaborated.errors };
  }
  const typed = normalize(elaborated.value);
  if (!typed.ok) {
    return { latex, syntax: syntax.value, typed: null, shape: null, errors: typed.errors };
  }
  return {
    latex,
    syntax: syntax.value,
    typed: typed.value,
    shape: typed.value.shape,
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// 자리만 마련해 둔 것 (설계 §8·§11)
// ---------------------------------------------------------------------------

/**
 * 미지수에 대해 푼다 — **아직 구현하지 않았다.**
 *
 * 자리를 미리 잡아두는 이유는, 나중에 붙일 때 호출부 시그니처가 흔들리지 않게 하기
 * 위해서다. 여러 해가 나올 수 있으므로 결과는 목록이다.
 */
export function solveFor(
  _expression: TypedExpr,
  _symbol: string,
  _env: Env,
): Result<readonly TypedExpr[]> {
  return fail('unsupported', 'Solving is not implemented yet');
}

/** 오류 여러 개를 하나로 모으는 편의 (호출부가 결과를 합칠 때 쓴다). */
export const collectErrors = <T,>(results: readonly Result<T>[]): Result<T[]> => {
  const values: T[] = [];
  const errors: AlgebraError[] = [];
  for (const r of results) {
    if (r.ok) values.push(r.value);
    else errors.push(...r.errors);
  }
  return errors.length > 0 ? failWith(errors) : ok(values);
};

/** 스칼라 모양 상수 재노출 — 환경을 손으로 만들 때 자주 쓴다. */
export const SCALAR_SHAPE = SCALAR;
