import type { Env, TypedExpr } from '../types-TypedExpr';
import { constantInteger, exprKey } from '../parse/normal';
import { normalize } from '../parse/normalize';
import { foldMatrices } from './matrixFold';
import { foldCalculus } from './calculus';
import { foldFunctions } from './functions';
import { simplify, substitute } from './transform';
import { withCeBudget } from '../ceLimit';
import { fail, ok, type Result } from '../types-result';
import { render } from '../render';
import { SCALAR, isSquare, shape } from '../types-shape';
import { ONE, ZERO } from '../types-Literal';

/**
 * 셀 하나를 값으로 접는다. **치환은 안 한다** — 어떤 이름을 무엇으로 바꿀지는 호출자
 * (그래프 층) 몫이다. 이 함수가 아는 건 식 하나와 그 모양 환경뿐이다.
 *
 * 파이프라인: `normalize` (입력 형태 불문 항상 평탄화된 상태로) → `foldFunctions`
 * (`functions.ts`, 사용자 정의 함수 호출을 값으로) → `foldMatrices`(리터럴 행렬 산술)
 * → `foldCalculus`(`calculus.ts`, 미분/적분/`\sum`/`\prod` 를 값으로) → `simplify`
 * (순수 스칼라는 CE로, 마지막에 거듭제곱 접기까지). 맨 앞의 `normalize` 는 `foldMatrices`
 * 가 n-항 `matMul`/`scalarMul` 이 평탄화돼 있다고 가정하기 때문이다 — `substituteDeep`
 * 처럼 트리를 다시 조립하는 경로를 거친 입력도 안전하게 받으려면 여기서 한 번 더 다져야
 * 한다.
 *
 * **`foldFunctions` 가 `foldMatrices` 보다 먼저인 이유**: `A\cdot f(x)` 에서 `f(x)` 가
 * 행렬 리터럴로 펴지는 게 `foldMatrices` 가 `A` 와 합쳐 접을 수 있으려면 그보다 **먼저**
 * 끝나 있어야 한다 — 순서를 바꾸면 `f(x)` 가 여전히 미펼쳐진 채라 `foldMatrices` 가
 * 이웃 리터럴을 못 알아본다.
 *
 * 이 호출 하나가 **CE 예산의 단위**다(`ceLimit.ts`) — 안에서 CE를 몇 번 부르든 합쳐서
 * 상한을 넘지 않는다. CE 0.90의 적분이 안 끝나는 입력이 있어서, 없으면 앱이 통째로 멈춘다.
 */
export function evaluate(e: TypedExpr, env: Env): Result<TypedExpr> {
  return withCeBudget(() => {
    const normalized = normalize(e);
    if (!normalized.ok) return normalized;
    const badExponent = findNonIntegerMatPow(normalized.value);
    if (badExponent !== null) {
      return fail('unsupported', `A matrix can only be raised to an integer power: ${badExponent}`);
    }
    const expanded = foldFunctions(normalized.value, env);
    if (!expanded.ok) return expanded;
    const folded = foldMatrices(expanded.value);
    if (!folded.ok) return folded;
    const calculated = foldCalculus(folded.value, env);
    if (!calculated.ok) return calculated;
    return simplify(calculated.value, env);
  });
}

/**
 * `A^{0.5}` 처럼 **값이 확정됐는데 정수가 아닌** 행렬 지수를 찾는다.
 *
 * `elaborate` 는 지수가 스칼라 모양인지만 보므로(`A^{1+2}` 를 받으려면 그래야 한다)
 * 여기까지 흘러올 수 있다. 값이 확정된 시점에서 정수가 아니면 뜻이 없으니 정직하게
 * 거절한다 — `A^{n}` 처럼 **아직 미정인 지수는 통과시킨다**(치환 뒤에 정해질 수 있다).
 */
function findNonIntegerMatPow(e: TypedExpr): string | null {
  if (e.op === 'matPow') {
    const lit = e.exponent.op === 'num' ? e.exponent.value : null;
    if (lit !== null && constantInteger(e.exponent) === null) return render(e.exponent);
  }
  for (const child of childrenOf(e)) {
    const found = findNonIntegerMatPow(child);
    if (found !== null) return found;
  }
  return null;
}

function childrenOf(e: TypedExpr): readonly TypedExpr[] {
  switch (e.op) {
    case 'num':
    case 'sym':
    case 'matIdentity':
      return [];
    case 'matrix':
      return e.rows.flat();
    case 'add':
      return e.terms;
    case 'neg':
      return [e.operand];
    case 'scalarMul':
    case 'matMul':
      return e.factors;
    case 'mul':
      return [e.scalar, e.matrix];
    case 'dot':
    case 'cross':
      return [e.left, e.right];
    case 'transpose':
      return [e.operand];
    case 'matPow':
    case 'scalarPow':
      return [e.base, e.exponent];
    case 'call':
    case 'apply':
      return e.args;
    case 'frac':
      return [e.numerator, e.denominator];
    case 'deriv':
      return [e.body];
    case 'sum':
    case 'prod':
    case 'integral':
      return [e.body, ...(e.lower !== null ? [e.lower] : []), ...(e.upper !== null ? [e.upper] : [])];
  }
}

/** 무한 루프 방어용 상한. 진짜 순환 검출(`a=b`, `b=a`)은 그래프 층이 이름 단위로 한다. */
const MAX_SUBSTITUTION_DEPTH = 64;

/** `n×n` 항등행렬을 리터럴 `matrix` 노드로. 대각선만 `1`, 나머지는 `0`. */
function identityMatrixLiteral(n: number): TypedExpr {
  const rows: TypedExpr[][] = [];
  for (let i = 0; i < n; i += 1) {
    const row: TypedExpr[] = [];
    for (let j = 0; j < n; j += 1) {
      row.push({ op: 'num', shape: SCALAR, value: i === j ? ONE : ZERO });
    }
    rows.push(row);
  }
  return { op: 'matrix', shape: shape(n, n), rows };
}

/**
 * **모양이 확정된** `matIdentity` 를 실제 항등행렬 리터럴로 치환한다.
 *
 * `matIdentity` 는 그 자체로 이미 "항등행렬"이라는 뜻이라 값은 안 바뀐다 — 다만
 * `matrixFold.ts` 의 리터럴 산술(`addMatrixLiterals`/`mulMatrixLiterals`/`invertLiteral`
 * 등)은 `op === 'matrix'` 인 노드만 리터럴로 인식한다. 그래서 `A + I` 에서 `A` 가
 * 치환으로 구체 행렬이 돼도 `I` 가 여전히 `matIdentity` 면 원소별 덧셈이 값으로
 * 안 접히고 `add(literal, matIdentity)` 로 남는다.
 *
 * 모양이 아직 안 정해졌으면(`I` 혼자 문맥 없이 쓰인 경우) 손대지 않는다 — 크기를
 * 모르는데 행렬을 지어낼 수는 없다.
 */
function materializeIdentities(e: TypedExpr): TypedExpr {
  switch (e.op) {
    case 'matIdentity': {
      // `(1,1)` 은 제외한다 — 그건 "판명된 항등행렬"이 아니라 문맥 없는 `I` 가 떨어지는
      // 기본값이다(`normalize.ts` "I 혼자 쓰면 … (1,1)=스칼라로 굳는다"). 여기까지
      // 치환하면 셀 에디터의 모든 셀이 거치는 substituteDeep+evaluate 경로에서
      // 단독 `"I"` 가 `\begin{pmatrix}1\end{pmatrix}` 로 보이게 된다.
      const n = e.shape.rows;
      return isSquare(e.shape) && n !== 1 ? identityMatrixLiteral(n as number) : e;
    }
    case 'num':
    case 'sym':
      return e;
    case 'matrix':
      return { ...e, rows: e.rows.map((row) => row.map(materializeIdentities)) };
    case 'add':
      return { ...e, terms: e.terms.map(materializeIdentities) };
    case 'neg':
      return { ...e, operand: materializeIdentities(e.operand) };
    case 'scalarMul':
    case 'matMul':
      return { ...e, factors: e.factors.map(materializeIdentities) };
    case 'mul':
      return {
        ...e,
        scalar: materializeIdentities(e.scalar),
        matrix: materializeIdentities(e.matrix),
      };
    case 'dot':
    case 'cross':
      return { ...e, left: materializeIdentities(e.left), right: materializeIdentities(e.right) };
    case 'transpose':
      return { ...e, operand: materializeIdentities(e.operand) };
    case 'matPow':
    case 'scalarPow':
      return {
        ...e,
        base: materializeIdentities(e.base),
        exponent: materializeIdentities(e.exponent),
      };
    case 'call':
    case 'apply':
      return { ...e, args: e.args.map(materializeIdentities) };
    case 'frac':
      return {
        ...e,
        numerator: materializeIdentities(e.numerator),
        denominator: materializeIdentities(e.denominator),
      };
    case 'deriv':
      return { ...e, body: materializeIdentities(e.body) };
    case 'sum':
    case 'prod':
    case 'integral':
      return {
        ...e,
        body: materializeIdentities(e.body),
        lower: e.lower !== null ? materializeIdentities(e.lower) : null,
        upper: e.upper !== null ? materializeIdentities(e.upper) : null,
      };
  }
}

/**
 * 정의된 심볼을 그 정의로 **끝까지** 바꾼다.
 *
 * [`substitute`](./rewrite.ts) 는 한 단계만 한다 — `bindings` 가 전이적으로 안 풀려
 * 있어서(`B = A^T` 는 `transpose(sym A)` 로 저장된다) `Bv` 같은 식은 한 번 치환으로
 * `A^Tv` 가 안 되고 그대로 남을 수 있다. 고정점(더 바뀌지 않을 때)까지 반복한다.
 *
 * `exprKey` 로 구조가 안 바뀌었는지 본다 — 값을 비교하는 게 아니라 **더 치환할 게
 * 없다**는 뜻이라 정확하다.
 *
 * **끝에 `materializeIdentities` 를 한 번 건다** — `evaluate` 가 바로 뒤따르므로,
 * 여기서 모양이 확정된 `I` 를 실제 행렬로 미리 박아둬야 `foldMatrices` 의 리터럴
 * 산술이 그걸 붙잡을 수 있다.
 */
export function substituteDeep(e: TypedExpr, env: Env): Result<TypedExpr> {
  let current = e;
  for (let i = 0; i < MAX_SUBSTITUTION_DEPTH; i += 1) {
    const next = substitute(current, env);  // TODO: optimize
    if (!next.ok) return next;
    if (exprKey(next.value) === exprKey(current)) return ok(materializeIdentities(next.value));
    current = next.value;
  }
  // 상한에 닿았다 — 순환일 가능성이 높지만, 순환 판정은 이름 단위 그래프의 몫이라
  // 여기서는 지금까지 치환된 상태를 조용히 돌려준다 (무한 루프만 막으면 된다).
  return ok(materializeIdentities(current));
}

/** `sym` 노드 이름을 전부 모은다. 그래프 층의 의존 간선이 될 값이다. */
export function freeSymbols(e: TypedExpr): readonly string[] {
  const names = new Set<string>();
  const walk = (node: TypedExpr): void => {
    switch (node.op) {
      case 'num':
      case 'matIdentity':
        return;
      case 'sym':
        names.add(node.name);
        return;
      case 'matrix':
        node.rows.forEach((row) => row.forEach(walk));
        return;
      case 'add':
        node.terms.forEach(walk);
        return;
      case 'neg':
        walk(node.operand);
        return;
      case 'scalarMul':
      case 'matMul':
        node.factors.forEach(walk);
        return;
      case 'mul':
        walk(node.scalar);
        walk(node.matrix);
        return;
      case 'dot':
      case 'cross':
        walk(node.left);
        walk(node.right);
        return;
      case 'transpose':
        walk(node.operand);
        return;
      case 'matPow':
        walk(node.base);
        // 지수도 식이 될 수 있다 (`A^{n}`) — 그 심볼도 셀 의존 간선이다.
        walk(node.exponent);
        return;
      case 'scalarPow':
        walk(node.base);
        walk(node.exponent);
        return;
      case 'call':
        node.args.forEach(walk);
        return;
      // `call` 과 달리 **함수 이름도 넣는다** — 셀 의존 간선이 여기서 나온다(`sym` 을
      // 위 주석에서 굳이 뺄 이유가 없다는 것과 같은 논리: 함수 정의 셀이 바뀌면 이
      // 셀도 무효화돼야 한다).
      case 'apply':
        names.add(node.name);
        node.args.forEach(walk);
        return;
      case 'frac':
        walk(node.numerator);
        walk(node.denominator);
        return;
      // 바운드 이름도 **포함시킨다** — 직관과 반대지만 필연이다. `freeSymbols` 는
      // `cellGraph.ts` 의 캐시 지문(`node.deps`)이 되는데, 빼면 사용자가 나중에 `x=3`
      // 셀을 추가해도 이 미분 셀의 지문이 안 바뀌어 캐시가 옛 결과를 그대로 돌려주고
      // "이미 정의됨" 오류가 안 뜬다 — 간선을 남겨야 무효화되고 오류가 뜬다.
      case 'deriv':
        walk(node.body);
        node.vars.forEach((v) => names.add(v));
        return;
      case 'sum':
      case 'prod':
      case 'integral':
        walk(node.body);
        names.add(node.variable);
        if (node.lower !== null) walk(node.lower);
        if (node.upper !== null) walk(node.upper);
        return;
    }
  };
  walk(e);
  return [...names].sort();
}
