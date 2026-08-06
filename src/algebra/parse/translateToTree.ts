import { fail, failWith, ok, type AlgebraError, type Result } from '../types-result';
import { DOT_MARKER, CROSS_MARKER, isMarker } from './preprocess';
import type { SyntaxNode } from '../types-SyntaxNode';
import { fromCeJson } from '../literalMath';
import { intLit } from '../types-Literal';


/** 스칼라 전용으로 취급하는 CE 함수 머리 → 우리 `call` 이름. */
const SCALAR_FUNCTIONS: Record<string, string> = {
  Sin: 'sin', Cos: 'cos', Tan: 'tan',
  Arcsin: 'arcsin', Arccos: 'arccos', Arctan: 'arctan',
  Sinh: 'sinh', Cosh: 'cosh', Tanh: 'tanh',
  Exp: 'exp', Ln: 'ln', Log: 'log', Sqrt: 'sqrt', Abs: 'abs',
};

/**
 * `\sin^{-1}` 계열 → 이미 있는 arc- 이름.
 *
 * CE는 이걸 `Apply(InverseFunction(Sin), x)` 로 준다(실측) — 막히던 머리는
 * `InverseFunction` 이 아니라 **`Apply`** 다. `\arcsin` 이 도착하는 곳과 같은 `call` 로
 * 보내면 `numeric`·`render` 테이블을 건드릴 필요가 없고, `\sin^{-1}(x)` 는
 * `\arcsin\left(x\right)` 로 렌더된다 (문자열은 바뀌지만 다시 읽어도 같은 트리라 멱등).
 *
 * **셋뿐인 이유**: `\ln^{-1}`·`\log^{-1}`·`\exp^{-1}` 은 CE가 이미 `Exp`/`Power(10,x)`/`Ln`
 * 으로 풀어줘서 `Apply` 로 오지도 않는다(실측). `\sinh^{-1}` 계열은 우리 테이블에 arsinh가
 * 없으므로 일부러 `unsupported` 로 남긴다 — 조용히 틀린 답을 내느니 못 한다고 하는 게 낫다.
 */
const INVERSE_FUNCTIONS: Record<string, string> = {
  Sin: 'arcsin', Cos: 'arccos', Tan: 'arctan',
};


/** CE가 곱셈에 쓰는 머리들. 그룹 보존 파싱에서는 `InvisibleOperator` 로 온다. */
const MULTIPLY_HEADS = new Set(['InvisibleOperator', 'Multiply']);

// ---------------------------------------------------------------------------
// 미분/적분/합/곱 — 바운드 변수
// ---------------------------------------------------------------------------

/** `\mathrm{d}` 홑글자가 CE로 오면 이 심볼 문자열이 된다(실측). */
const D_UPRIGHT = 'd_upright';

/**
 * 미분 기호로 인정하는 심볼 — `\mathrm{d}`(→`d_upright`)뿐 아니라 **꾸밈 없는 `d`**도
 * 받는다(실측: `\frac{d}{dx}f` 는 이미 CE가 곧장 `D` 로 읽어준다. `\frac{d}{d(x,y)}`
 * 같은 다변수꼴만 `D` 로 안 오고 `Divide` 로 오는데, 그 안의 `d` 도 마찬가지로 그냥
 * 문자열 `"d"`다). 사용자가 `d` 라는 이름의 심볼을 실제로 쓰는 경우와는 원리적으로
 * 구분할 수 없다 — 단일변수 미분에서 이미 감수하고 있는 위험을 다변수에도 그대로
 * 넓히는 것뿐이다.
 */
const isDifferentialSymbol = (s: unknown): s is string => s === D_UPRIGHT || s === 'd';

/**
 * 미분·적분·합·곱의 바운드 변수 자리에 온 JSON이 평범한 심볼 이름인지 확인한다.
 *
 * `i` 는 CE에서 허수단위로 예약돼 있어 `["Complex",0,1]` 로 온다(실측) — 인덱스/미분
 * 변수로 쓰면 조용히 잘못 해석되므로 명시적으로 거절한다.
 */
function boundVariableName(json: unknown): Result<string> {
  if (
    Array.isArray(json) &&
    json.length === 3 &&
    json[0] === 'Complex' &&
    json[1] === 0 &&
    json[2] === 1
  ) {
    return fail('malformed', 'i is reserved for the imaginary unit; use another variable');
  }
  if (typeof json === 'string' && !isDifferentialSymbol(json) && !isMarker(json)) {
    return ok(json);
  }
  return fail('malformed', 'A bound variable must be a plain symbol');
}

/**
 * `D(body, x)` — 단일변수 미분. 같은 변수로 중첩된 `D` 는 즉시 접어 `order` 로 담는다
 * (`\frac{\mathrm{d}^3}{\mathrm{d}x^3}f` → CE가 `D(D(D(f,x),x),x)` 를 주므로, 실측).
 * 변수가 다른 중첩(`D(D(f,x),y)`)은 안 접고 안쪽이 그대로 `diff` 자식 노드가 된다.
 */
function translateDiffToTree(bodyJson: unknown, varJson: unknown): Result<SyntaxNode> {
  const varName = boundVariableName(varJson);
  if (!varName.ok) return varName;
  let order = 1;
  let currentBody = bodyJson;
  while (
    Array.isArray(currentBody) &&
    currentBody.length === 3 &&
    currentBody[0] === 'D' &&
    currentBody[2] === varName.value
  ) {
    order += 1;
    currentBody = currentBody[1];
  }
  const body = translateToTree(currentBody);
  if (!body.ok) return body;
  return ok({ kind: 'diff', body: body.value, vars: [varName.value], order });
}

type BoundSpec = { readonly variable: string; readonly lower: unknown | null; readonly upper: unknown | null };

/**
 * `\sum`/`\prod`/`\int` 의 두 번째 인수 파싱. CE 실측 형태:
 *  - 상하한 있음: `["Tuple", 변수, 하한, 상한]`
 *  - 변수만: `["Tuple", 변수]` 또는 (적분은) 맨 문자열 변수
 *  - 없음/`"Nothing"`: 오류
 */
function parseBoundSpec(json: unknown, missingMessage: string): Result<BoundSpec> {
  if (json === undefined || json === 'Nothing') return fail('malformed', missingMessage);
  if (Array.isArray(json) && json[0] === 'Tuple') {
    const v = boundVariableName(json[1]);
    if (!v.ok) return v;
    return ok({
      variable: v.value,
      lower: json.length > 2 ? json[2] : null,
      upper: json.length > 3 ? json[3] : null,
    });
  }
  const v = boundVariableName(json);
  if (!v.ok) return v;
  return ok({ variable: v.value, lower: null, upper: null });
}

/** `\sum`/`\prod`/`\int` 공통 골격 — 본문·바운드 변수·상하한을 합쳐 한 노드로. */
function translateBoundedOp(
  kind: 'sum' | 'prod' | 'int',
  bodyJson: unknown,
  boundsJson: unknown,
  missingMessage: string,
): Result<SyntaxNode> {
  const spec = parseBoundSpec(boundsJson, missingMessage);
  const body = translateToTree(bodyJson);
  const lower = spec.ok && spec.value.lower !== null ? translateToTree(spec.value.lower) : null;
  const upper = spec.ok && spec.value.upper !== null ? translateToTree(spec.value.upper) : null;
  const errors: AlgebraError[] = [
    ...(spec.ok ? [] : spec.errors),
    ...(body.ok ? [] : body.errors),
    ...(lower === null || lower.ok ? [] : lower.errors),
    ...(upper === null || upper.ok ? [] : upper.errors),
  ];
  if (errors.length > 0) return failWith(errors);
  return ok({
    kind,
    body: (body as { value: SyntaxNode }).value,
    variable: (spec as { value: BoundSpec }).value.variable,
    lower: lower === null ? null : (lower as { value: SyntaxNode }).value,
    upper: upper === null ? null : (upper as { value: SyntaxNode }).value,
  });
}

/**
 * `\mathrm{d}(x,y,z)` (또는 `d(x,y,z)`) 자리 하나 — CE는 이걸 `InvisibleOperator(d,
 * Delimiter(Sequence(x,y,z)))` 로 준다(실측). 변수 하나만 괄호로 감싼 경우(`\mathrm{d}(x)`)는
 * `Sequence` 로 안 감싸이고 바로 온다 — 그것도 여기서 받는다.
 *
 * `asMultivarDivide`(분모 전체 자리)와 `asMultivarNumeratorDivide`(분자에 본문이 붙은
 * 경우의 분모 자리)가 공유한다.
 */
function extractMultivarVars(json: unknown): readonly unknown[] | null {
  if (!Array.isArray(json) || json.length !== 3 || json[0] !== 'InvisibleOperator') return null;
  if (!isDifferentialSymbol(json[1])) return null;
  const delim = json[2];
  if (!Array.isArray(delim) || delim[0] !== 'Delimiter') return null;
  const inner = delim[1];
  return Array.isArray(inner) && inner[0] === 'Sequence' ? inner.slice(1) : [inner];
}

/**
 * `\frac{\mathrm{d}}{\mathrm{d}(x,y,z)}` — 다변수 미분 패턴(분자가 그냥 `d` 하나뿐).
 *
 * CE는 이 표기를 `D` 로 안 읽고 `Divide(d, InvisibleOperator(d, Delimiter(Sequence(x,y,z))))`
 * 로 준다(실측).
 *
 * 매치하면 변수 이름들의 원시 JSON 배열을, 아니면 `null` 을 돌려준다.
 */
function asMultivarDivide(json: unknown): readonly unknown[] | null {
  if (!Array.isArray(json) || json[0] !== 'Divide' || json.length !== 3) return null;
  if (!isDifferentialSymbol(json[1])) return null;
  return extractMultivarVars(json[2]);
}

/**
 * `\frac{\mathrm{d}x}{\mathrm{d}(x,y,z)}` — 다변수 미분인데 **분자에 본문이 이미 붙은**
 * 경우. CE는 `Divide(InvisibleOperator(d, body), InvisibleOperator(d, Delimiter(Sequence(
 * x,y,z))))` 로 준다(실측) — 단일변수(`\frac{\mathrm{d}x}{\mathrm{d}x}`)는 CE가 이미
 * `D` 로 바로 주므로 이 경로를 안 탄다.
 */
function asMultivarNumeratorDivide(
  json: unknown,
): { readonly body: unknown; readonly vars: readonly unknown[] } | null {
  if (!Array.isArray(json) || json[0] !== 'Divide' || json.length !== 3) return null;
  const numerator = json[1];
  if (!Array.isArray(numerator) || numerator.length !== 3 || numerator[0] !== 'InvisibleOperator') {
    return null;
  }
  if (!isDifferentialSymbol(numerator[1])) return null;
  const vars = extractMultivarVars(json[2]);
  return vars === null ? null : { body: numerator[2], vars };
}

/** `\frac{\mathrm{d}}{\mathrm{d}(x,y,z)}` 뒤에 본문이 붙은 경우(`restArgs`)를 `diff` 노드로. */
function translateMultivarDiffToTree(
  varsRaw: readonly unknown[],
  restArgs: readonly unknown[],
): Result<SyntaxNode> {
  const names: string[] = [];
  const errors: AlgebraError[] = [];
  for (const v of varsRaw) {
    const r = boundVariableName(v);
    if (r.ok) names.push(r.value);
    else errors.push(...r.errors);
  }
  if (errors.length > 0) return failWith(errors);
  if (new Set(names).size !== names.length) {
    return fail('malformed', 'Differentiation variables must be distinct');
  }
  if (restArgs.length === 0) {
    return fail('malformed', 'A derivative operator needs an expression to differentiate');
  }
  const bodyJson = restArgs.length === 1 ? restArgs[0] : ['InvisibleOperator', ...restArgs];
  const body = translateToTree(bodyJson);
  if (!body.ok) return body;
  return ok({ kind: 'diff', body: body.value, vars: names, order: 1 });
}

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
  // 숫자 리터럴은 `literalMath` 가 단독으로 판정한다 — 정수/소수/`{num:}`/`Rational` 이
  // 전부 여기로 들어온다. 우리가 못 담는 것(무한대, 안전 정수 밖)은 `null` 이 오므로
  // 아래로 흘려보내지 않고 정직하게 거절한다.
  if (typeof json === 'number' || (typeof json === 'object' && json !== null && 'num' in json)) {
    const value = fromCeJson(json);
    return value !== null
      ? ok({ kind: 'num', value })
      : fail('unsupported', 'Unsupported number literal');
  }
  if (typeof json === 'string') {
    if (isMarker(json)) return fail('malformed', 'A product operator is missing its operands');
    // CE가 계산 불능을 심볼로 준다(`1/0` → `ComplexInfinity`, `0/0` → `NaN`, 실측).
    // 안 막으면 "ComplexInfinity 라는 변수" 가 되어 조용한 오답이 된다.
    if (json === 'ComplexInfinity' || json === 'NaN') {
      return fail('unsupported', `Not a number: ${json}`);
    }
    return ok({ kind: 'sym', name: json });
  }
  if (!Array.isArray(json)) return fail('unsupported', 'Unsupported expression');

  const [head, ...args] = json as [unknown, ...unknown[]];
  if (typeof head !== 'string') return fail('unsupported', 'Unsupported expression head');

  // 괄호는 트리 구조로 이미 표현되므로 껍데기만 벗긴다.
  if (head === 'Delimiter') {
    return args.length >= 1 ? translateToTree(args[0]) : fail('malformed', 'Empty parentheses');
  }
  if (MULTIPLY_HEADS.has(head)) {
    // `\frac{\mathrm{d}}{\mathrm{d}(x,y,z)}(...)` 는 다변수 미분 표기가 병치의 첫
    // 인수 자리에 앉은 모습으로 온다(실측) — 병치로 잘못 읽기 전에 여기서 가로챈다.
    const multivarVars = args.length > 0 ? asMultivarDivide(args[0]) : null;
    if (multivarVars !== null) return translateMultivarDiffToTree(multivarVars, args.slice(1));
    return translateMultiplyToTree(args);
  }
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
  // CE는 **리터럴 행렬**(`\begin{pmatrix}...\end{pmatrix}^{-1}`)의 밑을 `Power(M,-1)`
  // 대신 `Inverse(M)` 로 정규화한다(실측) — 심볼 밑(`A^{-1}`)은 이 경로를 안 타고
  // 그냥 `Power` 로 온다. `pow(base, -1)` 로 되돌려 elaborate가 똑같이 처리하게 한다.
  if (head === 'Inverse' && args.length === 1) {
    return translatePostfixToTree(args[0], (base) => ({
      kind: 'pow',
      base,
      exponent: { kind: 'num', value: intLit(-1) },
    }));
  }
  // `Rational` 은 **숫자 리터럴**이지 나눗셈 표기가 아니다.
  //
  // CE가 `form:['Number']` 에서 이미 우리가 원하는 선을 그어준다(실측):
  //   정수/정수 → `Rational` (기약·부호 분자까지 CE가 해준다)  → 리터럴
  //   그 외 전부 → `Divide` (`\frac{x+1}{x-1}`, `\frac{A}{a}`)  → frac 노드
  // 덕분에 "이 분수가 값인가 표기인가" 를 우리가 판정할 필요가 없다.
  // `Complex` 도 **숫자 리터럴**이다 (연산 머리가 아니라 2-인수 리터럴, 실측).
  // `3+4i` 는 `Add(3, InvisibleOperator(4, Complex(0,1)))` 로 오므로 `i` 하나가 여기 걸리고,
  // `4·i` 는 평범한 곱으로 남아 `normalize` 의 숫자 접기가 `Complex(0,4)` 로 만든다.
  // 덕분에 `i·i → -1` 도 별도 규칙 없이 계수 곱셈에서 떨어진다.
  if ((head === 'Rational' || head === 'Complex') && args.length === 2) {
    const value = fromCeJson(json);
    return value !== null
      ? ok({ kind: 'num', value })
      : fail('unsupported', 'Unsupported number literal');
  }
  if (head === 'Divide' && args.length === 2) {
    // `\frac{\mathrm{d}x}{\mathrm{d}(x,y,z)}` — 분자에 본문이 이미 붙은 다변수 미분.
    const numeratorDiff = asMultivarNumeratorDivide(json);
    if (numeratorDiff !== null) {
      return translateMultivarDiffToTree(numeratorDiff.vars, [numeratorDiff.body]);
    }
    // `\frac{\mathrm{d}}{\mathrm{d}(x,y,z)}` 홀로(뒤에 곱할 본문 없이) 쓰인 경우 — 병치
    // 위치가 아니라 바로 `Divide` 머리 자체로 온다. 본문이 없으므로 오류다.
    if (asMultivarDivide(json) !== null) {
      return fail('malformed', 'A derivative operator needs an expression to differentiate');
    }
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

  // 단일변수 미분. `D` 는 홑 대문자라 아래 "홑 대문자 함수 적용 되돌리기" 에 먼저
  // 걸리면 안 되므로 그보다 앞에서 가로챈다. `D(x,y)` 처럼 2-인수 함수 호출로 읽힐 만한
  // 다른 뜻은 이 도메인에 없다 — 행렬 곱은 괄호 안에 인수 하나만 오는 병치로 표현된다.
  if (head === 'D' && args.length === 2) {
    return translateDiffToTree(args[0], args[1]);
  }
  if (head === 'Sum' || head === 'Product') {
    const label = head === 'Sum' ? 'sum' : 'product';
    return translateBoundedOp(
      head === 'Sum' ? 'sum' : 'prod',
      args[0],
      args[1],
      `A ${label} needs an index variable`,
    );
  }
  if (head === 'Integrate') {
    return translateBoundedOp('int', args[0], args[1], 'An integral needs a differential (dx)');
  }

  // `\sin^{-1}(x)` — CE는 `Apply(InverseFunction(Sin), x)` 로 준다(실측).
  // **여기서 반드시 끊는다** — 아래 홑 대문자 되돌리기로 새면 `Apply` 가 곱으로 둔갑한다.
  if (head === 'Apply') {
    const [callee, ...callArgs] = args;
    const inverseOf =
      Array.isArray(callee) && callee.length === 2 && callee[0] === 'InverseFunction'
        ? callee[1]
        : null;
    const invName = typeof inverseOf === 'string' ? INVERSE_FUNCTIONS[inverseOf] : undefined;
    if (invName === undefined) {
      return fail('unsupported', `Unsupported operation: ${head}`);
    }
    const parsed = callArgs.map(translateToTree);
    const errors = parsed.flatMap((a) => (a.ok ? [] : a.errors));
    if (errors.length > 0) return failWith(errors);
    return ok({
      kind: 'call',
      name: invName,
      args: parsed.map((a) => (a as { value: SyntaxNode }).value),
    });
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
