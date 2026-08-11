import {
  SCALAR,
  classify,
  formatShape,
  isScalar,
  isSquare,
  shape,
} from '../shape/shape';
import { fail, failWith, ok, type AlgebraError, type Result } from '../result/result';
import type { SyntaxNode } from '../syntax/node';
import type { TypedExpr, Env, FunctionDef } from '../expr/node';
import {
  buildAdd,
  buildCross,
  buildDeriv,
  buildDot,
  buildFrac,
  buildIntegral,
  buildMul,
  buildProd,
  buildSum,
  shapeMismatch,
} from '../expr/builders';

/**
 * Elaborate — Syntax IR 을 훑으며 노드마다 **어느 연산인지**를 정하고 빌더에 넘긴다.
 *
 * 연산자 해석과 모양 계산을 나눌 수 없는 이유: `\cdot` 이 내적인지 스칼라곱인지는
 * 피연산자 **모양**을 알아야 정해지고, 결과 모양은 **연산자**가 정해져야 나온다.
 * 상호 의존이라 분리하면 어긋난다. 그래서 바닥에서 위로 한 번 훑으며 노드마다
 * `(연산, 모양)` 을 동시에 확정한다.
 *
 * 다만 **노드를 실제로 만드는 일과 모양을 검사하는 일은 `expr/builders.ts` 몫이다.**
 * 여기 남는 건 "Syntax 를 보고 어느 빌더를 부를지 정하는" 부분과, 그러려면 `Env` 가
 * 있어야 하는 것들(사용자 정의 함수 판정, 바운드 변수)이다. 재작성도 같은 빌더를
 * 쓰므로 조립 규칙이 두 벌이 되지 않는다.
 */



/** 전치 표기로 인정하는 지수 심볼. */
const TRANSPOSE_MARKS = new Set(['T', 'top', 'intercal', '\\top', '\\intercal']);

// ---------------------------------------------------------------------------
// 사용자 정의 함수 — `apply` 는 이름 뒤 괄호가 함수 적용인지 곱(행렬곱)인지 여기서 정한다
// ---------------------------------------------------------------------------

/**
 * 함수 인스턴스화 재귀 상한. 상호 재귀(`f(x)=g(x)`, `g(x)=f(x)`)가 무한히 elaborate를
 * 되부르지 않게 막는다 — `transform/evaluate.ts` 의 `MAX_SUBSTITUTION_DEPTH` 와 같은
 * 취지(진짜 순환 검출은 셀 사이 의존 그래프의 몫이라 여기서는 상한만 둔다).
 */
const MAX_APPLY_DEPTH = 64;
let applyDepth = 0;

/**
 * `apply` 노드 하나를 함수 정의로 인스턴스화한다 — 매개변수에 **호출부 인수의 실제
 * 모양**을 걸고 본문을 다시 elaborate한다.
 *
 * `f` 는 고정 시그니처가 없는 모양 다형이다: 같은 본문이 인수 모양에 따라 스칼라가
 * 되기도, 오류가 되기도, 다른 모양의 행렬이 되기도 한다(`types-TypedExpr.ts` 의
 * `apply` 문서, §설계 결정). 그래서 **호출부마다 다시 elaborate하는 게 유일한 방법**
 * 이다 — `apply(f,args)` 에 인스턴스 결과를 캐시로 달아두면 `exprKey`(치환 고정점·
 * 캐시 지문이 쓰는 구조 키)가 오염되고 렌더 왕복도 깨지므로, 재계산을 받아들인다.
 *
 * 이 함수는 elaborate(모양만 필요, 트리는 버린다)와 `evaluate`의 `foldFunctions`
 * (값까지 필요, 이 결과에 `substitute` 를 한 번 더 얹어 실제 인수 **값**을 채운다)가
 * 공유한다 — 인스턴스화 규칙이 두 벌이 되면 어긋난다.
 */
export function instantiateFunction(
  fn: FunctionDef,
  args: readonly TypedExpr[],
  env: Env,
): Result<TypedExpr> {
  if (applyDepth >= MAX_APPLY_DEPTH) {
    return fail('unsupported', 'Function recursion is too deep (possibly a cycle)');
  }
  const shapes = { ...env.shapes };
  for (let i = 0; i < fn.params.length; i += 1) shapes[fn.params[i]] = args[i].shape;
  applyDepth += 1;
  try {
    return elaborate(fn.body, { ...env, shapes });
  } finally {
    applyDepth -= 1;
  }
}

/** 인수 개수가 맞는지 보고, 맞으면 인스턴스화해 결과 모양을 확정한다. */
function elaborateApply(
  callee: string,
  fn: FunctionDef,
  args: readonly TypedExpr[],
  env: Env,
): Result<TypedExpr> {
  if (args.length !== fn.params.length) {
    return shapeMismatch(
      `${callee} expects ${fn.params.length} argument${fn.params.length === 1 ? '' : 's'} (got ${args.length})`,
    );
  }
  const instantiated = instantiateFunction(fn, args, env);
  if (!instantiated.ok) {
    // 본문 오류에 호출 맥락을 붙인다 — 안 붙이면 어느 함수 탓인지 안 보인다
    // (`f: sin expects a scalar argument (got 3x3)`, 중첩 호출이면 바깥부터 쌓인다).
    return failWith(instantiated.errors.map((e) => ({ ...e, message: `${callee}: ${e.message}` })));
  }
  return ok({ op: 'apply', shape: instantiated.value.shape, name: callee, args });
}

/**
 * `apply` Syntax 노드를 해소한다 — `callee` 가 정의된 함수인지 `env.functions` 로
 * 판단한다. 이 판단이 여기(elaborate) 있는 이유는 `cdot`/`juxt` 가 내적·스칼라곱·
 * 외적 중 뭔지 모양을 알아야 정해지는 것과 같다 — 함수인지 곱인지도 문맥(env) 없이는
 * 모른다(`types-SyntaxNode.ts` 의 `apply` 문서 참고).
 *
 * **함수가 아니면 병치로 되돌린다** — `A(v+w)` 가 `A` 미정의면 기존 그대로 행렬곱
 * 해석(`buildMul`)에 맡긴다. 인수를 이미 elaborate했으므로(모양이 있어야 함수
 * 여부를 나중에 또 물을 일이 없다) 다시 Syntax로 안 돌아가고 `buildMul` 를
 * 바로 왼쪽부터 접는다 — `f(x,y)` 가 함수가 아니면 `f·x·y` 다.
 */
function elaborateApplyNode(
  node: Extract<SyntaxNode, { kind: 'apply' }>,
  env: Env,
): Result<TypedExpr> {
  const argResults = node.args.map((a) => elaborate(a, env));
  const errors = argResults.flatMap((a) => (a.ok ? [] : a.errors));
  if (errors.length > 0) return failWith(errors);
  const args = argResults.map((a) => (a as { value: TypedExpr }).value);

  const fn = env.functions?.[node.callee];
  if (fn === undefined) {
    const callee = elaborate({ kind: 'sym', name: node.callee }, env);
    if (!callee.ok) return callee;
    return args.reduce<Result<TypedExpr>>(
      (acc, arg) => (acc.ok ? buildMul(acc.value, arg) : acc),
      ok(callee.value),
    );
  }
  return elaborateApply(node.callee, fn, args, env);
}

/**
 * `apply` 바로 위에 후위(`^n`,`^T`)가 얹힌 경우(Syntax IR로는 `pow(apply(...), exp)`)를
 * `callee` 가 함수인지에 따라 갈라 처리한다 — `case 'pow':` 에서 여기로 위임한다.
 *
 * **왜 `case 'pow':` 에서 미리 갈라야 하는가**: `translateToTree` 는 대문자·소문자 두
 * 경로 모두 후위를 "apply 바깥" 꼴로 정규화해 둔다(`types-SyntaxNode.ts` 의 `apply`
 * 문서 참고) — 함수인지 아직 모르니 일단 그렇게 담아둔 것뿐이다. `callee` 가 함수면
 * 그 정규화가 맞다(`f(x)^2` = `(f(x))^2`). 하지만 함수가 **아니면** 기존 행렬 규칙이
 * 후위를 **마지막 인수 안으로** 요구한다(`A(X)^T` = `A·(X^T)`, 설계 §3) — `case 'pow':`
 * 가 먼저 `node.base` 를 평범하게 elaborate해버리면 결과는 이미 `matMul([A,X^T 아닌
 * X])` 같은 값으로 굳어 있어서, 그 뒤에 `elaboratePow` 가 씌우는 지수는 **전체**에
 * 걸릴 수밖에 없다("apply였다"는 사실 자체가 사라졌기 때문) — `(A·X)^2` 가 나와
 * 버려 값이 달라진다(실측, 퍼즈가 잡음). 그래서 `case 'pow':` 가 `node.base` 를
 * elaborate하기 **전에** 갈라야 한다.
 */
function elaboratePowOverApply(
  applyNode: Extract<SyntaxNode, { kind: 'apply' }>,
  exponent: SyntaxNode,
  env: Env,
): Result<TypedExpr> {
  const argResults = applyNode.args.map((a) => elaborate(a, env));
  const errors = argResults.flatMap((a) => (a.ok ? [] : a.errors));
  if (errors.length > 0) return failWith(errors);
  const args = argResults.map((a) => (a as { value: TypedExpr }).value);

  const callee = elaborate({ kind: 'sym', name: applyNode.callee }, env);
  if (!callee.ok) return callee;

  const last = args[args.length - 1];
  const wrappedLast = elaboratePow(last, exponent, env);
  if (!wrappedLast.ok) return wrappedLast;
  const allArgs = [...args.slice(0, -1), wrappedLast.value];
  return allArgs.reduce<Result<TypedExpr>>(
    (acc, arg) => (acc.ok ? buildMul(acc.value, arg) : acc),
    ok(callee.value),
  );
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
  // 비스칼라 밑 — 정사각 행렬만 거듭제곱할 수 있다.
  //
  // **여기서는 "정수인가"를 보지 않는다.** `A^{1+2}` 처럼 지수가 식일 수 있어야 하고,
  // 그 값은 정리·치환을 거쳐야 확정되기 때문이다. 판정은 값이 확정된 뒤에(`normalize`
  // 의 `constantInteger`) 한다.
  //
  // ⚠ 그 대가로 `A^{0.5}`·`A^{x}` 같은 **뜻이 정해지지 않은 식이 여기를 통과한다.**
  // 조용히 틀리지는 않는다 — `numeric`/`matrixFold` 가 상수 정수가 아니면 각각
  // `unsupported`/무변경으로 빠지고, `evaluate` 가 상수 비정수 지수를 걸러낸다.
  // **`I^n → I` 와 `A^0 → I` 는 여기서 하지 않는다** — 둘 다 `normalize` 의 matPow
  // 케이스가 이미 하고 있어서 규칙이 두 벌이었다. 접기는 normalize 한 곳으로 모은다.
  //
  // 항등행렬은 미정 모양이어도 **정사각이 전제**이므로 `isSquare` 관문만 비켜준다
  // (그러지 않으면 `isSquare(unknown)` 이 false 라 `I^3` 이 "not square" 로 막힌다).
  if (base.op !== 'matIdentity' && !isSquare(base.shape)) {
    return shapeMismatch(`Cannot raise a ${formatShape(base.shape)} to a power: not square`);
  }
  return ok({ op: 'matPow', shape: base.shape, base, exponent: exp.value });
}

// ---------------------------------------------------------------------------
// 미분/적분/합/곱 — 바운드 변수
// ---------------------------------------------------------------------------

/**
 * 바운드 변수 이름이 **이미 셀에 정의돼 있으면** 오류로 낸다. 조용히 가려버리지 않는다
 * (설계 결정 — 처음엔 가리고 계산 후 원상복구하는 안도 검토했지만, `x=3` 정의가 나중에
 * 추가돼도 미분 셀이 갱신되지 않는 등 놀라운 동작이 나올 수 있어 정직한 오류로 바꿨다).
 *
 * `env.shapes` 가 아니라 **`env.bindings` 로만** 판정한다 — `buildEnv` 는 정의를 풀 때
 * `shapes` 와 `bindings` 를 항상 같이 채우므로 이게 "진짜 셀 정의"의 정확한 표식이다.
 * `shapes` 로 판정하면 바로 아래에서 바운드 변수에 주입하는 스칼라 모양 자체가,
 * 그리고 `\sum_k(\sum_k(k))` 같은 중첩 바인더가 자기 자신에 걸려 오탐이 난다.
 */
function freshBoundNameErrors(names: readonly string[], env: Env): AlgebraError[] {
  const bindings = env.bindings;
  if (bindings === undefined) return [];
  return names
    .filter((name) => name in bindings)
    .map((name) => ({
      code: 'malformed' as const,
      message: `${name} is already defined; a bound variable must be a fresh name`,
      where: name,
    }));
}

/**
 * 본문을 elaborate할 때 쓰는 env — 바운드 이름에 스칼라 모양을 **선언**한다.
 *
 * 차단이 아니라 선언이다: 이게 없으면 `y = \frac{\mathrm{d}}{\mathrm{d}x}(x^2)` 같은
 * 정의 셀이 `buildEnv` 1판(`assumeScalarForUnknown:false`)에서 `x` 를 못 찾아 죽는다.
 * `bindings` 는 그대로 둔다 — `freshBoundNameErrors` 가 이미 그 이름이 없음을 보장한다.
 */
export function withBoundScalars(env: Env, names: readonly string[]): Env {
  const shapes = { ...env.shapes };
  for (const name of names) shapes[name] = SCALAR;
  return { ...env, shapes };
}

function elaborateDiff(
  node: Extract<SyntaxNode, { kind: 'diff' }>,
  env: Env,
): Result<TypedExpr> {
  const nameErrors = freshBoundNameErrors(node.vars, env);
  const body = elaborate(node.body, withBoundScalars(env, node.vars));
  const errors = [...nameErrors, ...(body.ok ? [] : body.errors)];
  if (errors.length > 0) return failWith(errors);
  return buildDeriv((body as { value: TypedExpr }).value, node.vars, node.order);
}

function elaborateBounded(
  node: {
    readonly body: SyntaxNode;
    readonly variable: string;
    readonly lower: SyntaxNode | null;
    readonly upper: SyntaxNode | null;
  },
  env: Env,
  build: (
    body: TypedExpr,
    variable: string,
    lower: TypedExpr | null,
    upper: TypedExpr | null,
  ) => Result<TypedExpr>,
): Result<TypedExpr> {
  const nameErrors = freshBoundNameErrors([node.variable], env);
  const lower = node.lower !== null ? elaborate(node.lower, env) : null;
  const upper = node.upper !== null ? elaborate(node.upper, env) : null;
  const body = elaborate(node.body, withBoundScalars(env, [node.variable]));
  const errors = [
    ...nameErrors,
    ...(lower !== null && !lower.ok ? lower.errors : []),
    ...(upper !== null && !upper.ok ? upper.errors : []),
    ...(body.ok ? [] : body.errors),
  ];
  if (errors.length > 0) return failWith(errors);
  return build(
    (body as { value: TypedExpr }).value,
    node.variable,
    lower === null ? null : (lower as { value: TypedExpr }).value,
    upper === null ? null : (upper as { value: TypedExpr }).value,
  );
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

function elaborateAdd(terms: readonly SyntaxNode[], env: Env): Result<TypedExpr> {
  const parsed = terms.map((t) => elaborate(t, env));
  const errors = parsed.flatMap((p) => (p.ok ? [] : p.errors));
  if (errors.length > 0) return failWith(errors);
  return buildAdd(parsed.map((p) => (p as { value: TypedExpr }).value));
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
      if (node.kind === 'cdot') return buildDot(left.value, right.value);
      if (node.kind === 'times') return buildCross(left.value, right.value);
      return buildMul(left.value, right.value);
    }

    case 'pow': {
      // `apply` 바로 위의 **꽉 묶인**(`tightPostfix`) 후위는 함수인지 먼저 갈라야
      // 한다 — `elaboratePowOverApply` 문서 참고. 느슨한 후위(사용자가 명시적으로
      // 한 번 더 괄호를 쳐서 후위 범위를 이미 통째로 정한 경우, `types-SyntaxNode.ts`
      // 의 `pow.tightPostfix` 문서 참고)는 여기서 안 갈라야 한다 — `base` 를 통째로
      // elaborate한 뒤 후위를 씌우는 아래 일반 경로가 정확히 "괄호 친 전체"를 감싼다.
      if (
        node.base.kind === 'apply' &&
        node.tightPostfix === true &&
        env.functions?.[node.base.callee] === undefined
      ) {
        return elaboratePowOverApply(node.base, node.exponent, env);
      }
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
      return buildFrac(numerator.value, denominator.value);
    }

    case 'call': {
      const args = node.args.map((a) => elaborate(a, env));
      const errors = args.flatMap((a) => (a.ok ? [] : a.errors));
      if (errors.length > 0) return failWith(errors);
      const values = args.map((a) => (a as { value: TypedExpr }).value);
      const nonScalar = values.find((v) => !isScalar(v.shape));
      if (nonScalar !== undefined) {
        // `\sin(행렬)` 처럼 내장 스칼라 함수에 비스칼라 인자가 들어온 경우 — 뜻이
        // 정해지지 않았으므로 오류다.
        return shapeMismatch(
          `${node.name} expects a scalar argument (got ${classify(nonScalar.shape)})`,
        );
      }
      return ok({ op: 'call', shape: SCALAR, name: node.name, args: values });
    }

    case 'apply':
      return elaborateApplyNode(node, env);

    case 'diff':
      return elaborateDiff(node, env);

    case 'sum':
      return elaborateBounded(node, env, buildSum);

    case 'prod':
      return elaborateBounded(node, env, buildProd);

    case 'int':
      return elaborateBounded(node, env, buildIntegral);
  }
}
