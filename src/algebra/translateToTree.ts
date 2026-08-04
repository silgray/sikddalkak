import { fail, failWith, ok, type AlgebraError, type Result } from './types-result';
import { DOT_MARKER, CROSS_MARKER, isMarker } from './preprocess';
import type { SyntaxNode } from './types-SyntaxNode';


/** 스칼라 전용으로 취급하는 CE 함수 머리 → 우리 `call` 이름. */
const SCALAR_FUNCTIONS: Record<string, string> = {
  Sin: 'sin', Cos: 'cos', Tan: 'tan',
  Arcsin: 'arcsin', Arccos: 'arccos', Arctan: 'arctan',
  Sinh: 'sinh', Cosh: 'cosh', Tanh: 'tanh',
  Exp: 'exp', Ln: 'ln', Log: 'log', Sqrt: 'sqrt', Abs: 'abs',
};


/** CE가 곱셈에 쓰는 머리들. 그룹 보존 파싱에서는 `InvisibleOperator` 로 온다. */
const MULTIPLY_HEADS = new Set(['InvisibleOperator', 'Multiply']);

// ---------------------------------------------------------------------------
// 곱셈 런(run) 해석 — 우선순위와 모호성이 결정되는 곳
// ---------------------------------------------------------------------------

/**
 * 하나의 평평한 곱셈 인수열을 Syntax 트리로 접는다.
 *
 * 우선순위(좁은 것부터): 후위(`^`) > **병치** > `·`,`×` > `+`,`-`
 * 병치가 `·`/`×` 보다 강하게 묶이므로 `A v · w` 는 `(Av)·w` 가 된다.
 * CE의 인수열에서 **마커가 없는 인접**이 곧 병치다.
 *
 * 그리고 같은 순위(`·`,`×`)에서의 모호성은 **좌결합으로 조용히 처리하지 않고 오류**다:
 *  - 혼합 `u·v×w` — 좌결합이면 `(u·v)×w` 로 읽혀 타입은 통과하지만 스칼라 삼중곱
 *    `u·(v×w)` 와 **다른 답이 조용히** 나온다.
 *  - 비결합 반복 `u×v×w` — `(u×v)×w ≠ u×(v×w)` 라 임의 선택이 오답을 만든다.
 * (`·` 반복은 결합 순서가 답을 바꾸지 않으므로 허용한다.)
 */
function foldMultiplyRun(items: readonly SyntaxNode[], markers: readonly (string | null)[]): Result<SyntaxNode> {
  // markers[i] 는 items[i] 와 items[i+1] 사이의 연산자 (null이면 병치)
  const explicit = markers.filter((m): m is string => m !== null);
  const hasDot = explicit.includes(DOT_MARKER);
  const hasCross = explicit.includes(CROSS_MARKER);

  if (hasDot && hasCross) {
    return fail(
      'ambiguous-order',
      'Mixed dot and cross products need parentheses to fix the order',
    );
  }
  if (explicit.filter((m) => m === CROSS_MARKER).length >= 2) {
    return fail(
      'ambiguous-order',
      'Repeated cross products need parentheses (cross product is not associative)',
    );
  }

  // 병치를 먼저 묶는다 (더 강한 우선순위).
  const chains: SyntaxNode[] = [];
  const ops: string[] = [];
  let current = items[0];
  for (let i = 0; i < markers.length; i += 1) {
    const next = items[i + 1];
    const marker = markers[i];
    if (marker === null) {
      current = { kind: 'juxt', left: current, right: next };
    } else {
      chains.push(current);
      ops.push(marker);
      current = next;
    }
  }
  chains.push(current);

  // 남은 명시적 곱은 좌결합으로 접는다 (위에서 모호한 조합은 이미 걸렀다).
  let acc = chains[0];
  for (let i = 0; i < ops.length; i += 1) {
    acc =
      ops[i] === DOT_MARKER
        ? { kind: 'cdot', left: acc, right: chains[i + 1] }
        : { kind: 'times', left: acc, right: chains[i + 1] };
  }
  return ok(acc);
}

// ---------------------------------------------------------------------------
// CE JSON -> Syntax IR
// ---------------------------------------------------------------------------

function translateMultiplyToTree(args: readonly unknown[]): Result<SyntaxNode> {
  // 인수열을 [피연산자, 마커, 피연산자, …] 로 읽는다. 마커가 없는 인접은 병치.
  const items: SyntaxNode[] = [];
  const markers: (string | null)[] = [];
  let pendingMarker: string | null = null;
  let expectOperand = true;
  const errors: AlgebraError[] = [];

  for (const arg of args) {
    if (isMarker(arg)) {
      if (expectOperand) {
        return fail('malformed', 'A product operator is missing its left operand');
      }
      if (pendingMarker !== null) {
        return fail('malformed', 'Two product operators in a row');
      }
      pendingMarker = arg;
      expectOperand = true;
      continue;
    }
    const node = translateToTree(arg);
    if (!node.ok) {
      errors.push(...node.errors);
      continue;
    }
    if (items.length > 0) markers.push(pendingMarker);
    items.push(node.value);
    pendingMarker = null;
    expectOperand = false;
  }

  if (errors.length > 0) return failWith(errors);
  if (pendingMarker !== null) {
    return fail('malformed', 'A product operator is missing its right operand');
  }
  if (items.length === 0) return fail('malformed', 'Empty product');
  if (items.length === 1) return ok(items[0]);
  return foldMultiplyRun(items, markers);
}

function translateMatrixToTree(body: unknown): Result<SyntaxNode> {
  if (!Array.isArray(body) || body[0] !== 'List') {
    return fail('malformed', 'Malformed matrix');
  }
  const rows: SyntaxNode[][] = [];
  const errors: AlgebraError[] = [];
  for (const row of body.slice(1)) {
    if (!Array.isArray(row) || row[0] !== 'List') {
      // 1열 행렬은 셀이 List로 감싸이지 않고 바로 올 수 있다.
      const cell = translateToTree(row);
      if (cell.ok) rows.push([cell.value]);
      else errors.push(...cell.errors);
      continue;
    }
    const cells: SyntaxNode[] = [];
    for (const cell of row.slice(1)) {
      const node = translateToTree(cell);
      if (node.ok) cells.push(node.value);
      else errors.push(...node.errors);
    }
    rows.push(cells);
  }
  if (errors.length > 0) return failWith(errors);
  if (rows.length === 0) return fail('malformed', 'Empty matrix');
  const width = rows[0].length;
  if (rows.some((r) => r.length !== width)) {
    return fail('malformed', 'Matrix rows have different lengths');
  }
  return ok({ kind: 'matrix', rows });
}

/**
 * CE가 **홑 대문자 + 괄호**를 함수 적용으로 읽어버린 흔적인가 (실측: `A(v)` → `["A","v"]`).
 * 우리 도메인에서 그건 함수가 아니라 곱이다.
 */
function asUppercaseApplication(json: unknown): { head: string; args: unknown[] } | null {
  if (!Array.isArray(json)) return null;
  const [head, ...args] = json as [unknown, ...unknown[]];
  return typeof head === 'string' && /^[A-Z]$/.test(head) && args.length > 0
    ? { head, args }
    : null;
}

/** `A`, `B`, … 뒤에 붙은 인수들을 병치 사슬로 되돌린다. */
function foldUppercaseApplicationToTree(
  head: string,
  args: readonly unknown[],
  wrapLast: (node: SyntaxNode) => SyntaxNode = (n) => n,
): Result<SyntaxNode> {
  const parsed = args.map(translateToTree);
  const errors = parsed.flatMap((a) => (a.ok ? [] : a.errors));
  if (errors.length > 0) return failWith(errors);
  const values = parsed.map((a) => (a as { value: SyntaxNode }).value);
  return ok(
    values.reduce<SyntaxNode>(
      (left, arg, i) => ({
        kind: 'juxt',
        left,
        right: i === values.length - 1 ? wrapLast(arg) : arg,
      }),
      { kind: 'sym', name: head },
    ),
  );
}

/**
 * 후위 연산자(`^T`, `^n`)를 붙인다.
 *
 * 밑이 위의 "대문자 함수 적용"이면 **후위를 괄호 안으로 밀어 넣는다.** CE는
 * `A\left(X\right)^T` 를 "A 호출의 전치"로 읽지만, 우리 우선순위표에서는 후위가 병치보다
 * 강하므로 `A·(X^T)` 다 (설계 §3). 이걸 안 하면 `A\left(B+C\right)^2` 같은 식이
 * 조용히 다른 뜻으로 읽힌다.
 */
function translatePostfixToTree(
  baseJson: unknown,
  wrap: (base: SyntaxNode) => SyntaxNode,
): Result<SyntaxNode> {
  const application = asUppercaseApplication(baseJson);
  if (application !== null) {
    return foldUppercaseApplicationToTree(application.head, application.args, wrap);
  }
  const base = translateToTree(baseJson);
  return base.ok ? ok(wrap(base.value)) : base;
}

/** CE JSON 한 노드를 Syntax IR로. */
export function translateToTree(json: unknown): Result<SyntaxNode> {
  if (typeof json === 'number') return ok({ kind: 'num', value: json });
  if (typeof json === 'object' && json !== null && 'num' in json) {
    const value = Number((json as { num: unknown }).num);
    return Number.isFinite(value)
      ? ok({ kind: 'num', value })
      : fail('unsupported', 'Unsupported number literal');
  }
  if (typeof json === 'string') {
    if (isMarker(json)) return fail('malformed', 'A product operator is missing its operands');
    return ok({ kind: 'sym', name: json });
  }
  if (!Array.isArray(json)) return fail('unsupported', 'Unsupported expression');

  const [head, ...args] = json as [unknown, ...unknown[]];
  if (typeof head !== 'string') return fail('unsupported', 'Unsupported expression head');

  // 괄호는 트리 구조로 이미 표현되므로 껍데기만 벗긴다.
  if (head === 'Delimiter') {
    return args.length >= 1 ? translateToTree(args[0]) : fail('malformed', 'Empty parentheses');
  }
  if (MULTIPLY_HEADS.has(head)) return translateMultiplyToTree(args);
  if (head === 'Matrix') return translateMatrixToTree(args[0]);
  if (head === 'List') return translateMatrixToTree(json);

  if (head === 'Add') {
    const terms = args.map(translateToTree);
    const errors = terms.flatMap((t) => (t.ok ? [] : t.errors));
    if (errors.length > 0) return failWith(errors);
    return ok({ kind: 'add', terms: terms.map((t) => (t as { value: SyntaxNode }).value) });
  }
  if (head === 'Subtract' && args.length === 2) {
    const left = translateToTree(args[0]);
    const right = translateToTree(args[1]);
    if (!left.ok || !right.ok) {
      return failWith([...(left.ok ? [] : left.errors), ...(right.ok ? [] : right.errors)]);
    }
    return ok({ kind: 'add', terms: [left.value, { kind: 'neg', operand: right.value }] });
  }
  if (head === 'Negate' && args.length === 1) {
    const inner = translateToTree(args[0]);
    return inner.ok ? ok({ kind: 'neg', operand: inner.value }) : inner;
  }
  // CE는 `v^T` 를 `Transpose` 로 알아본다(실측) — 스칼라든 아니든 똑같이. 하지만 스칼라의
  // `a^T` 는 전치가 아니라 **일반 지수연산**이어야 하므로, 여기서는 `^T` 라는 표기 그대로
  // 되돌려두고 의미 판단은 모양을 아는 elaborate에 맡긴다.
  if (head === 'Transpose' && args.length === 1) {
    return translatePostfixToTree(args[0], (base) => ({
      kind: 'pow',
      base,
      exponent: { kind: 'sym', name: 'T' },
    }));
  }
  if (head === 'Power' && args.length === 2) {
    const exponent = translateToTree(args[1]);
    if (!exponent.ok) return exponent;
    return translatePostfixToTree(args[0], (base) => ({
      kind: 'pow',
      base,
      exponent: exponent.value,
    }));
  }
  if ((head === 'Divide' || head === 'Rational') && args.length === 2) {
    const numerator = translateToTree(args[0]);
    const denominator = translateToTree(args[1]);
    if (!numerator.ok || !denominator.ok) {
      return failWith([
        ...(numerator.ok ? [] : numerator.errors),
        ...(denominator.ok ? [] : denominator.errors),
      ]);
    }
    return ok({ kind: 'frac', numerator: numerator.value, denominator: denominator.value });
  }
  const fnName = SCALAR_FUNCTIONS[head];
  if (fnName !== undefined) {
    const parsed = args.map(translateToTree);
    const errors = parsed.flatMap((a) => (a.ok ? [] : a.errors));
    if (errors.length > 0) return failWith(errors);
    return ok({
      kind: 'call',
      name: fnName,
      args: parsed.map((a) => (a as { value: SyntaxNode }).value),
    });
  }

  // CE는 **홑 대문자** 뒤에 괄호가 오면 함수 적용으로 읽는다 (실측: `A(v)` → `["A","v"]`,
  // 그런데 `g(v)`·`\Gamma(v)`·`A_1(v)` 는 병치로 온다). 우리 도메인에서 `A(v+w)` 는
  // 함수가 아니라 **행렬 곱**이므로 병치로 되돌린다.
  //
  // 되돌리는 범위를 홑 대문자로 좁게 잡은 건, `Sum`·`Integrate` 처럼 진짜 모르는 머리까지
  // 곱으로 둔갑시켜 조용한 오답을 만들지 않기 위해서다.
  //
  // 심볼릭 함수(`f(x)=x^2`)를 도입할 때 손볼 곳이 여기다 — 그때는 `f` 가 정의된 함수인지
  // 보고 갈라야 하는데, 그 판단은 parse 다음의 전개 패스 몫이다.
  const application = asUppercaseApplication(json);
  if (application !== null) {
    return foldUppercaseApplicationToTree(application.head, application.args);
  }

  return fail('unsupported', `Unsupported operation: ${head}`);
}
