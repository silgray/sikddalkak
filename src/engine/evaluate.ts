import { isFunction, isSymbol } from '@cortex-js/compute-engine';
import type { Expression, FormOption, MathJsonExpression } from '@cortex-js/compute-engine';
import { ce } from './ce';
import type { CellMode, EvalResult } from '../types';

type Bindings = Record<string, Expression>;

/**
 * `a = 3` 처럼 좌변이 단일 심볼인 Equal 식이면 정의로 본다.
 * `x^2 = 4` 처럼 좌변이 식이면 정의가 아니라 그냥 방정식.
 */
function asDefinition(expr: Expression): { name: string; value: Expression } | null {
  if (expr.operator !== 'Equal' || !isFunction(expr) || expr.nops !== 2) return null;
  const [lhs, rhs] = expr.ops;
  if (!isSymbol(lhs)) return null;
  return { name: lhs.symbol, value: rhs };
}

function isMatrixLike(expr: Expression): boolean {
  return expr.operator === 'Matrix' || String(expr.type).startsWith('matrix');
}

/**
 * 곱셈 순서를 보존하는 축소 정규화 형식. Multiply/Order 정규화를 빼서
 * `b^Tb` 같은 곱이 재배열되지 않게 한다 — CE는 `Transpose(b)`처럼 함수로
 * 감싼 인자를 (b가 matrix로 declare돼 있어도) 행렬로 인정하지 않고
 * 교환법칙 가정으로 정렬해버린다.
 */
const ORDER_PRESERVING_FORMS = [
  'InvisibleOperator',
  'Number',
  'Add',
  'Power',
  'Divide',
  'Flatten',
] as const;

/** JSON 어딘가에 행렬 리터럴이 있는지 (행렬 파이프라인 선택용). */
function jsonHasMatrix(json: unknown): boolean {
  if (json === 'Matrix') return true;
  if (Array.isArray(json)) return json.some(jsonHasMatrix);
  return false;
}

/** 심볼/에러가 없는 순수 리터럴 서브트리인지 (안전하게 미리 평가 가능한지). */
function isLiteralJson(json: unknown): boolean {
  if (typeof json === 'number') return true;
  if (typeof json === 'string') return json === 'List' || json === 'Matrix';
  if (Array.isArray(json)) return json.every(isLiteralJson);
  if (typeof json === 'object' && json !== null && 'num' in json) return true;
  return false;
}

/**
 * `\cdot`/`\times`는 CE 파싱에서 전부 Multiply로 뭉개져 의미가 사라진다.
 * 행렬 경로에서만, 파싱 전에 마커 심볼로 바꿔 어느 연산자였는지 살려둔다.
 * (`\cdots` 같은 다른 커맨드를 건드리지 않게 토큰 경계를 확인한다.)
 */
const DOT_MARKER = 'vecDotMarker';
const CROSS_MARKER = 'vecCrossMarker';
function preprocessVectorOps(latex: string): string {
  return latex
    .replace(/\\cdot(?![a-zA-Z])/g, ` \\mathrm{${DOT_MARKER}} `)
    .replace(/\\times(?![a-zA-Z])/g, ` \\mathrm{${CROSS_MARKER}} `);
}

/** Nx1/1xN 행렬 또는 평평한 List를 평평한 벡터 JSON으로. 벡터가 아니면 null. */
function asFlatVector(json: unknown): MathJsonExpression | null {
  if (!Array.isArray(json) || !isLiteralJson(json)) return null;
  if (json[0] === 'List' && json.slice(1).every((v) => !Array.isArray(v))) {
    return json as unknown as MathJsonExpression; // 이미 평평한 벡터
  }
  const rows: unknown = json[0] === 'Matrix' ? json[1] : json;
  if (!Array.isArray(rows) || rows[0] !== 'List') return null;
  const rowArr = rows.slice(1);
  if (rowArr.every((r) => Array.isArray(r) && r[0] === 'List' && r.length === 2)) {
    // Nx1 열벡터
    return ['List', ...rowArr.map((r) => (r as unknown[])[1])] as unknown as MathJsonExpression;
  }
  if (rowArr.length === 1 && Array.isArray(rowArr[0]) && (rowArr[0] as unknown[])[0] === 'List') {
    // 1xN 행벡터
    return rowArr[0] as unknown as MathJsonExpression;
  }
  return null;
}

/** 평평한 벡터를 열벡터 Matrix로 (Cross 결과 표시용). */
function asColumnMatrix(flat: MathJsonExpression): MathJsonExpression {
  const values = (flat as unknown as unknown[]).slice(1);
  return ['Matrix', ['List', ...values.map((v) => ['List', v])]] as unknown as MathJsonExpression;
}

/**
 * Multiply 인자 속 벡터 연산 마커를 해석한다.
 * 양옆이 벡터 리터럴이면 Dot/Cross로 계산해 결과 리터럴로 치환하고,
 * 아니면(스칼라 곱 등) 마커만 지워 일반 곱셈으로 되돌린다.
 */
function resolveVectorMarkers(args: unknown[]): unknown[] {
  const out = [...args];
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] !== DOT_MARKER && out[i] !== CROSS_MARKER) continue;
    const left = asFlatVector(out[i - 1]);
    const right = asFlatVector(out[i + 1]);
    if (left !== null && right !== null) {
      const op = out[i] === DOT_MARKER ? 'Dot' : 'Cross';
      const result = ce.box([op, left, right] as unknown as MathJsonExpression).evaluate();
      const json: unknown = result.json;
      const replacement =
        op === 'Cross' && Array.isArray(json) && json[0] === 'List'
          ? asColumnMatrix(json as unknown as MathJsonExpression)
          : json;
      out.splice(i - 1, 3, replacement);
      i -= 2; // 치환 지점부터 재검사 (연쇄 a·b·c)
    } else {
      out.splice(i, 1); // 벡터가 아니다 — 일반 곱셈
      i -= 1;
    }
  }
  return out;
}

/**
 * subs를 마친 JSON에서 `Transpose(리터럴)` 같은 행렬 함수를 바닥부터 미리
 * 평가해 리터럴 행렬로 접고, `\cdot`/`\times` 마커를 Dot/Cross로 해석한다.
 * 이걸 안 하면 rebox(재정규화)가 incompatible-type 에러를 내거나 곱을
 * 계산하지 못한다.
 */
function foldMatrixFns(json: MathJsonExpression): MathJsonExpression {
  if (!Array.isArray(json)) return json;
  let walked = json.map((item) => foldMatrixFns(item as MathJsonExpression)) as unknown[];
  const [head] = walked;
  if (head === 'Multiply' && walked.some((a) => a === DOT_MARKER || a === CROSS_MARKER)) {
    walked = ['Multiply', ...resolveVectorMarkers(walked.slice(1))];
    // 인자가 하나만 남으면 곱을 벗긴다: Multiply(x) -> x
    if (walked.length === 2) return walked[1] as MathJsonExpression;
  }
  if (head === 'Transpose' && walked.slice(1).every(isLiteralJson)) {
    const evaluated = ce.box(walked as unknown as MathJsonExpression).evaluate();
    const out: unknown = evaluated.json;
    // 평가 결과가 List-of-List면 Matrix 리터럴로 감싸 곱셈에 참여할 수 있게 한다.
    if (Array.isArray(out) && out[0] === 'List') {
      return ['Matrix', out] as unknown as MathJsonExpression;
    }
    return out as MathJsonExpression;
  }
  return walked as unknown as MathJsonExpression;
}

/**
 * 1×1 행렬 결과를 스칼라로 접는다: `b^Tb` = `[[14]]` → `14`.
 * 표시뿐 아니라 바인딩 값도 스칼라가 되므로 이후 스칼라 연산에 쓸 수 있다.
 */
function collapseOneByOne(expr: Expression): Expression {
  const json: unknown = expr.json;
  if (Array.isArray(json) && json[0] === 'List' && json.length === 2) {
    const row: unknown = json[1];
    if (Array.isArray(row) && row[0] === 'List' && row.length === 2) {
      const cell = row[1];
      if (!Array.isArray(cell) || isLiteralJson(cell)) {
        return ce.box(cell as MathJsonExpression);
      }
    }
  }
  return expr;
}

/**
 * 행렬 연산의 결과는 `Matrix`가 아니라 `List`의 `List`로 나온다.
 * 그대로 두면 `[[4, 4], [4, 4]]` 처럼 렌더되므로 다시 Matrix로 감싼다.
 * 진짜 리스트(`[1, 2, 3]`)는 원소가 List가 아니므로 건드리지 않는다.
 */
function asMatrixIfRows(expr: Expression): Expression {
  if (expr.operator !== 'List') return expr;
  const json: unknown = expr.json;
  if (!Array.isArray(json) || json.length < 2) return expr;
  const rows: unknown[] = json.slice(1);
  if (!rows.every((row) => Array.isArray(row) && row[0] === 'List')) return expr;
  return ce.box(['Matrix', expr.json]);
}

/**
 * 관계식(등식/부등식). 이 위에서는 simplify를 돌리면 안 된다 — CE 0.90의
 * simplify가 `x+1=1+x` 를 `NaN=NaN` 으로 망가뜨리고, 그러면 evaluate가
 * 참인 항등식을 거짓으로 판정한다. evaluate만 쓰면 올바르게 참이 나온다.
 */
const RELATIONS = new Set([
  'Equal',
  'NotEqual',
  'Less',
  'LessEqual',
  'Greater',
  'GreaterEqual',
]);

/**
 * simplify는 심볼릭 정리(약분, 삼각 항등식)를, evaluate는 실제 연산(행렬 곱/거듭제곱,
 * 유리수 계산)을 한다. 둘 다 필요하다. 순서가 중요한데, evaluate를 먼저 돌리면
 * `\frac{x^2-1}{x-1}` 이 약분되지 않고 `\sin^2+\cos^2` 도 1이 되지 않는다.
 *
 * 단, **행렬이 관여하면 simplify를 건너뛴다.** CE 0.90의 simplify는 곱셈 인자를
 * 교환법칙 가정으로 재배열·멱집계해서 `ABA` 를 `A^2·B` 로 만들어버린다 —
 * 순열행렬이면 A^2=I라 결과가 그냥 B가 되는 오답. evaluate는 순서를 지킨다.
 * 행렬 관여는 표현식의 타입으로 감지한다(subs 전 심볼 곱이어도 declare 덕에
 * type이 matrix로 잡힌다).
 */
function reduce(expr: Expression): Expression {
  const reduced =
    RELATIONS.has(expr.operator) || isMatrixLike(expr)
      ? expr.evaluate()
      : expr.simplify().evaluate();
  return asMatrixIfRows(collapseOneByOne(reduced));
}

/**
 * 행렬이 관여하는 표현식의 평가 경로. `expr`는 축소 정규화 형식으로 파싱돼
 * 곱셈 순서가 보존된 상태여야 한다.
 *
 * subs로 심볼이 리터럴 행렬이 된 뒤 → Transpose 등을 미리 접고 →
 * rebox(재정규화)한다. 리터럴 행렬은 정규화가 재배열하지 않으므로(기존 검증)
 * 이 시점의 canonical화는 안전하고, evaluate가 올바른 순서로 곱을 계산한다.
 */
function reduceMatrixExpr(subbed: Expression): Expression {
  const folded = foldMatrixFns(subbed.json);
  const evaluated = ce.box(folded).evaluate();
  return asMatrixIfRows(collapseOneByOne(evaluated));
}

/** 관계식을 평가하면 CE는 `True` / `False` 심볼(`\top` / `\bot`)을 돌려준다. */
function asBoolean(expr: Expression): boolean | null {
  if (expr.json === 'True') return true;
  if (expr.json === 'False') return false;
  return null;
}

/** `["Error", "'unexpected-operator'", …]` 에서 코드만 뽑아 읽을 만한 문자열로. */
function errorMessage(expr: Expression): string {
  const codes = expr.errors.map((e) => {
    const json = e.json as unknown;
    if (Array.isArray(json) && typeof json[1] === 'string') {
      return json[1].replace(/^'|'$/g, '');
    }
    return 'invalid-expression';
  });
  return codes.length > 0 ? [...new Set(codes)].join(', ') : 'invalid-expression';
}

const asMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * 엔진이 보는 최소 단위. 뷰(셀 스택, 캔버스)의 타입에 의존하지 않는다 —
 * 배치 정보(순서, 좌표)는 의미에 영향을 주지 않으므로 여기 없다.
 */
export type EvalInput = {
  id: string;
  latex: string;
  mode: CellMode;
};

/** 파싱해서 알아낸 그래프 구조. 식 자체(latex, mode)만으로 정해진다. */
type Structure =
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | {
      kind: 'node';
      /** 이 오브젝트가 정의하는 이름 (정의가 아니면 null) */
      defName: string | null;
      /** 계산 순서를 정하는 간선. 정의는 우변만, symbolic 모드는 없음. */
      deps: readonly string[];
    };

type Node = { input: EvalInput; defName: string | null; deps: readonly string[] };

/** 한 노드를 평가한 결과와, 하류가 쓰려면 필요한 부산물. */
type Computed = {
  result: EvalResult;
  /** 정의라면 바인딩 값. 스코프를 넘겨 보관하려고 Expression이 아니라 JSON으로 둔다. */
  valueJson: MathJsonExpression | null;
  isMatrix: boolean;
};

/**
 * 캐시 두 개로 재계산을 실제로 바뀐 것에만 한정한다.
 *
 * 한 셀을 고칠 때 나머지 전부를 다시 파싱하고 계산하는 게 비용의 대부분이었다.
 * (100개 기준 41ms 중 CE 파싱·계산이 33.6ms)
 *
 * - `structures`: latex+mode -> 파싱 구조. 식이 안 바뀌면 파싱 자체를 건너뛴다.
 * - `computed`: 지문 -> 계산 결과. 지문에 의존 대상의 지문이 들어가므로
 *   상류가 바뀌면 하류 지문도 자동으로 달라져 무효화된다. 별도의 무효화
 *   로직이나 버전 스탬프가 필요 없다.
 *
 * 캐시는 순수 함수의 메모이제이션이므로 오래된 항목이 틀린 답을 줄 수 없다.
 * 메모리만 관리하면 되어서 오래된 것부터 버린다.
 */
const CACHE_LIMIT = 2000;
const structures = new Map<string, Structure>();
const computed = new Map<string, Computed>();

function remember<T>(cache: Map<string, T>, key: string, value: T): T {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return value;
}

/** 테스트용. 캐시가 결과에 영향을 주지 않는지 확인할 때 쓴다. */
export function clearEvaluationCache(): void {
  structures.clear();
  computed.clear();
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/**
 * 파싱해서 구조만 뽑는다. 이 시점에는 아직 아무것도 declare되지 않았지만,
 * 정의 이름과 자유 변수는 곱셈 피연산자 순서와 무관하므로 안전하다.
 */
function readStructure(input: EvalInput): Structure {
  const latex = input.latex.trim();
  if (latex === '') return { kind: 'empty' };

  let expr: Expression;
  try {
    expr = ce.parse(latex);
  } catch (err) {
    return { kind: 'error', message: asMessage(err) };
  }
  if (!expr.isValid) return { kind: 'error', message: errorMessage(expr) };

  const def = asDefinition(expr);
  return {
    kind: 'node',
    defName: def?.name ?? null,
    // 정의는 우변만 참조한다 (`a=3` 이 자기 자신을 참조하지 않도록).
    // symbolic 모드는 치환하지 않으므로 의존성도 없다.
    deps:
      def !== null
        ? def.value.freeVariables
        : input.mode === 'scoped'
          ? expr.freeVariables
          : [],
  };
}

function computeNode(
  node: Node,
  bindings: Bindings,
  duplicated: ReadonlySet<string>,
  /** 지금까지 행렬로 declare된 이름 — 행렬 파이프라인 선택에 쓴다. */
  matrixNames: ReadonlySet<string>,
): Computed {
  try {
    // 여기서 파싱한다. 위상 순서상 선행 정의가 이미 declare된 뒤이므로
    // 행렬 심볼의 곱셈 피연산자 순서가 보존된다. 구조 파악 때의 파싱을
    // 재사용하면 `(2x2) a` 가 `a (2x2)` 로 뒤집힌다 — 행렬곱은 교환법칙이
    // 없으므로 오답이다.
    const latex = node.input.latex.trim();
    const parsed = ce.parse(latex);

    // 행렬 관여 감지: 행렬 심볼 참조 / 행렬 리터럴 / 표현식 타입.
    // 행렬 경로에선 곱셈 순서를 보존하는 축소 정규화 파싱으로 갈아탄다 —
    // canonical 파싱은 Transpose(b) 같은 함수 감싼 인자를 정렬해버린다.
    const usesMatrix =
      node.deps.some((name) => matrixNames.has(name)) ||
      jsonHasMatrix(parsed.json) ||
      isMatrixLike(parsed);
    const expr = usesMatrix
      ? rewriteBoundApplications(
          ce.parse(preprocessVectorOps(latex), { form: [...ORDER_PRESERVING_FORMS] }),
          bindings,
          [...ORDER_PRESERVING_FORMS],
        )
      : rewriteBoundApplications(parsed, bindings);
    const evaluateExpr = usesMatrix ? reduceMatrixExpr : reduce;
    const def = asDefinition(expr);

    if (def !== null) {
      if (duplicated.has(def.name)) {
        return {
          result: { kind: 'error', message: `duplicate definition: ${def.name}` },
          valueJson: null,
          isMatrix: false,
        };
      }
      // 선행 정의는 위상 순서에 의해 이미 bindings에 있다.
      const value = evaluateExpr(def.value.subs(bindings));
      return {
        result: {
          kind: 'ok',
          latex: `${def.name} = ${value.latex}`,
          json: value.json,
          definitionName: def.name,
        },
        valueJson: value.json,
        isMatrix: isMatrixLike(value),
      };
    }

    const base = node.input.mode === 'scoped' ? expr.subs(bindings) : expr;
    const result = evaluateExpr(base);
    const bool = asBoolean(result);
    return {
      result:
        bool !== null
          ? { kind: 'boolean', value: bool }
          : { kind: 'ok', latex: result.latex, json: result.json, definitionName: null },
      valueJson: null,
      isMatrix: false,
    };
  } catch (err) {
    return { result: { kind: 'error', message: asMessage(err) }, valueJson: null, isMatrix: false };
  }
}

/**
 * 정의된 값 이름의 "함수 적용"을 곱셈으로 되돌린다.
 *
 * `A(BA)` 를 파싱하면 A가 matrix로 declare돼 있어도 CE는 함수 적용
 * `["A", ["Multiply","B","A"]]` 로 읽는다. 그러면 subs가 연산자 자리의 A를
 * 치환하지 못해 `A([[…]])` 가 미평가로 남는다. 우리 문서에서 정의는 전부
 * **값**(함수가 아님)이므로, 정의된 이름이 머리에 오는 적용은 곱셈이 맞다.
 */
function rewriteBoundApplications(
  expr: Expression,
  bindings: Bindings,
  /** 지정하면 rebox 때 이 축소 형식을 유지한다 (행렬 경로 — 재정렬 방지). */
  form?: FormOption,
): Expression {
  const bound = Object.keys(bindings);
  if (bound.length === 0) return expr;
  const boundSet = new Set(bound);
  let changed = false;

  const walk = (json: MathJsonExpression): MathJsonExpression => {
    if (!Array.isArray(json)) return json;
    const [head, ...args] = json as [MathJsonExpression, ...MathJsonExpression[]];
    const mappedArgs = args.map(walk);
    if (typeof head === 'string' && boundSet.has(head) && mappedArgs.length > 0) {
      changed = true;
      return ['Multiply', head, ...mappedArgs] as unknown as MathJsonExpression;
    }
    return [walk(head), ...mappedArgs] as unknown as MathJsonExpression;
  };

  const rewritten = walk(expr.json);
  if (!changed) return expr;
  return form !== undefined ? ce.box(rewritten, { form }) : ce.box(rewritten);
}

/** 계산 결과를 하류가 볼 수 있도록 스코프에 반영한다. 캐시 적중 시에도 필요하다. */
function applyBinding(
  node: Node,
  entry: Computed,
  bindings: Bindings,
  matrixNames: Set<string>,
): void {
  if (node.defName === null || entry.valueJson === null) return;
  bindings[node.defName] = ce.box(entry.valueJson);
  if (entry.isMatrix) {
    ce.declare(node.defName, 'matrix');
    matrixNames.add(node.defName);
  }
}

/**
 * 오브젝트 집합을 이름 기반 의존성 그래프로 평가한다.
 *
 * 배열 순서가 아니라 "누가 어떤 이름을 정의하고 누가 그 이름을 참조하는가"로
 * 계산 순서가 정해진다. 따라서 오브젝트를 옮기거나 순서를 바꿔도 결과가
 * 달라지지 않는다 — 평면에 자유 배치하는 캔버스에서 필수인 성질이다.
 *
 * 순서에 의존하지 않는 대가로 두 가지가 새로 생긴다:
 *   - 순환 참조 (`a=b+1`, `b=a+1`)가 가능해지므로 감지해서 에러로 표시한다.
 *   - 같은 이름을 두 곳에서 정의할 수 있다. "나중"이 없으므로 어느 쪽도
 *     이기지 않고 양쪽 다 에러로 표시한다.
 *
 * 결과는 id로 찾는 Map이다. 위상 순서는 입력 순서와 다르고, 두 뷰 모두
 * 배열 인덱스가 아니라 id로 결과를 찾기 때문이다.
 */
export function evaluateGraph(inputs: readonly EvalInput[]): Map<string, EvalResult> {
  const results = new Map<string, EvalResult>();

  // ce.declare가 엔진 전역을 건드리므로 평가 패스를 스코프로 가둔다.
  // (ce.forget()은 선언을 되돌리지 못한다.)
  ce.pushScope();
  try {
    // --- 1단계: 그래프 구조 (안 바뀐 식은 캐시에서 꺼내 파싱을 건너뛴다) ---
    const nodes: Node[] = [];
    for (const input of inputs) {
      const key = `${input.mode}|${input.latex.trim()}`;
      const structure = structures.get(key) ?? remember(structures, key, readStructure(input));
      if (structure.kind !== 'node') {
        results.set(input.id, structure);
        continue;
      }
      nodes.push({ input, defName: structure.defName, deps: structure.deps });
    }

    // --- 2단계: 이름 -> 정의한 오브젝트 ---
    const definers = new Map<string, string[]>();
    for (const node of nodes) {
      if (node.defName !== null) pushTo(definers, node.defName, node.input.id);
    }
    const duplicated = new Set<string>();
    const resolvable = new Map<string, string>();
    for (const [name, ids] of definers) {
      if (ids.length > 1) duplicated.add(name);
      else resolvable.set(name, ids[0]);
    }

    // --- 3단계: 위상정렬 (Kahn) ---
    const byId = new Map(nodes.map((n) => [n.input.id, n]));
    const indegree = new Map<string, number>(nodes.map((n) => [n.input.id, 0]));
    const dependents = new Map<string, string[]>();
    for (const node of nodes) {
      const deps = new Set(
        node.deps
          .map((name) => resolvable.get(name))
          .filter((id): id is string => id !== undefined && byId.has(id)),
      );
      for (const dep of deps) {
        indegree.set(node.input.id, (indegree.get(node.input.id) ?? 0) + 1);
        pushTo(dependents, dep, node.input.id);
      }
    }

    const queue = nodes.filter((n) => indegree.get(n.input.id) === 0).map((n) => n.input.id);
    const ordered: string[] = [];
    for (let i = 0; i < queue.length; i += 1) {
      const id = queue[i];
      ordered.push(id);
      for (const dependent of dependents.get(id) ?? []) {
        const left = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, left);
        if (left === 0) queue.push(dependent);
      }
    }

    // --- 4단계: 위상 순서대로 평가 ---
    // 지문 = (모드, 식, 의존 대상들의 지문). 상류가 바뀌면 하류 지문이 자동으로
    // 달라지므로 무효화 로직 없이 딱 필요한 만큼만 다시 계산된다.
    const bindings: Bindings = {};
    const matrixNames = new Set<string>();
    const fingerprints = new Map<string, string>();

    for (const id of ordered) {
      const node = byId.get(id);
      if (node === undefined) continue;

      const depPrints = node.deps
        .map((name) => {
          const depId = resolvable.get(name);
          return depId !== undefined ? `${name}=${fingerprints.get(depId) ?? '?'}` : null;
        })
        .filter((part): part is string => part !== null)
        .sort();
      const duplicateMark = node.defName !== null && duplicated.has(node.defName) ? '!dup' : '';
      const fingerprint = `${node.input.mode}|${node.input.latex.trim()}|${depPrints.join('&')}${duplicateMark}`;
      fingerprints.set(id, fingerprint);

      const entry =
        computed.get(fingerprint) ??
        remember(computed, fingerprint, computeNode(node, bindings, duplicated, matrixNames));
      applyBinding(node, entry, bindings, matrixNames);
      results.set(id, entry.result);
    }

    // 위상정렬에 들어가지 못한 것들이 순환에 걸린 노드다.
    // `x=x` 같은 자기 참조도 여기 포함된다 — 자기 자신으로 정의하는 건
    // 의미가 없으므로 순환으로 보는 게 맞다.
    const placed = new Set(ordered);
    const stuck = nodes.filter((n) => !placed.has(n.input.id));
    if (stuck.length > 0) {
      const names = stuck.map((n) => n.defName).filter((n): n is string => n !== null);
      const detail = names.length > 0 ? `: ${[...new Set(names)].sort().join(', ')}` : '';
      for (const node of stuck) {
        results.set(node.input.id, { kind: 'error', message: `cyclic reference${detail}` });
      }
    }

    return results;
  } finally {
    ce.popScope();
  }
}
