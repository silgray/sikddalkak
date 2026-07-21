import { isFunction, isSymbol } from '@cortex-js/compute-engine';
import type { Expression } from '@cortex-js/compute-engine';
import { ce } from './ce';
import type { Cell, CellMode, EvalResult } from '../types';

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
 */
function reduce(expr: Expression): Expression {
  const reduced = RELATIONS.has(expr.operator)
    ? expr.evaluate()
    : expr.simplify().evaluate();
  return asMatrixIfRows(reduced);
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

/** 1단계 파싱으로 얻은 그래프 구조. */
type Node = {
  input: EvalInput;
  /** 1단계 파싱 결과. 행렬 심볼을 참조하지 않으면 그대로 재사용한다. */
  expr: Expression;
  /** 이 오브젝트가 정의하는 이름 (정의가 아니면 null) */
  defName: string | null;
  /** 계산 순서를 정하는 간선. 정의는 우변만, symbolic 모드는 없음. */
  deps: readonly string[];
  /** 식 전체의 자유 변수. 재파싱이 필요한지 판단하는 데 쓴다. */
  refs: readonly string[];
};

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function evaluateNode(
  node: Node,
  bindings: Bindings,
  duplicated: ReadonlySet<string>,
  /** 지금까지 행렬로 선언된 이름. 이 함수가 정의를 만나면 여기 추가한다. */
  matrixNames: Set<string>,
): EvalResult {
  try {
    // 행렬로 선언된 심볼을 참조할 때만 다시 파싱한다.
    //
    // 1단계 파싱 시점에는 선행 정의가 아직 declare되지 않았다. 그 상태에서는
    // CE가 행렬 심볼을 스칼라로 보고 곱셈 피연산자를 정렬해 `(2x2) a` 를
    // `a (2x2)` 로 뒤집는다 — 행렬곱은 교환법칙이 없으므로 오답이다.
    // 위상 순서상 여기서는 선행 정의가 declare된 뒤이므로 재파싱이 올바르다.
    //
    // 반대로 행렬이 안 걸린 식은 1단계 결과가 이미 정확하므로 재파싱은
    // 순수한 낭비다. 행렬을 안 쓰는 문서에서는 파싱이 노드당 한 번으로 끝난다.
    const needsReparse = node.refs.some((name) => matrixNames.has(name));
    const expr = needsReparse ? ce.parse(node.input.latex.trim()) : node.expr;
    const def = asDefinition(expr);

    if (def !== null) {
      if (duplicated.has(def.name)) {
        return { kind: 'error', message: `duplicate definition: ${def.name}` };
      }
      // 선행 정의는 위상 순서에 의해 이미 bindings에 있다.
      const value = reduce(def.value.subs(bindings));
      bindings[def.name] = value;
      if (isMatrixLike(value)) {
        ce.declare(def.name, 'matrix');
        matrixNames.add(def.name);
      }
      return {
        kind: 'ok',
        latex: `${def.name} = ${value.latex}`,
        json: value.json,
        definitionName: def.name,
      };
    }

    const base = node.input.mode === 'scoped' ? expr.subs(bindings) : expr;
    const result = reduce(base);
    const bool = asBoolean(result);
    if (bool !== null) return { kind: 'boolean', value: bool };
    return { kind: 'ok', latex: result.latex, json: result.json, definitionName: null };
  } catch (err) {
    return { kind: 'error', message: asMessage(err) };
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
    // --- 1단계: 파싱해서 그래프 구조만 뽑는다 ---
    // 여기서의 파싱은 정의 이름과 참조 이름을 얻기 위한 것이다. 곱셈 피연산자
    // 순서는 아직 틀릴 수 있지만 freeVariables와 Equal 판정에는 영향이 없다.
    const nodes: Node[] = [];
    for (const input of inputs) {
      const latex = input.latex.trim();
      if (latex === '') {
        results.set(input.id, { kind: 'empty' });
        continue;
      }
      let expr: Expression;
      try {
        expr = ce.parse(latex);
      } catch (err) {
        results.set(input.id, { kind: 'error', message: asMessage(err) });
        continue;
      }
      if (!expr.isValid) {
        results.set(input.id, { kind: 'error', message: errorMessage(expr) });
        continue;
      }
      const def = asDefinition(expr);
      nodes.push({
        input,
        expr,
        defName: def?.name ?? null,
        // 정의는 우변만 참조한다 (`a=3` 이 자기 자신을 참조하지 않도록).
        // symbolic 모드는 치환하지 않으므로 의존성도 없다.
        deps: def !== null ? def.value.freeVariables
            : input.mode === 'scoped' ? expr.freeVariables
            : [],
        refs: expr.freeVariables,
      });
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
    const bindings: Bindings = {};
    const matrixNames = new Set<string>();
    for (const id of ordered) {
      const node = byId.get(id);
      if (node !== undefined) {
        results.set(id, evaluateNode(node, bindings, duplicated, matrixNames));
      }
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

/**
 * 셀 스택 뷰용 어댑터. 미확정 셀을 거르고 결과를 입력 순서 배열로 되돌린다.
 * 엔진 자체는 스택을 모른다.
 */
export function evaluateCells(cells: readonly Cell[]): EvalResult[] {
  const live = cells.filter((cell) => cell.committed);
  const results = evaluateGraph(
    live.map((cell) => ({ id: cell.id, latex: cell.input, mode: cell.mode })),
  );
  return cells.map((cell) =>
    cell.committed ? (results.get(cell.id) ?? { kind: 'empty' }) : { kind: 'empty' },
  );
}
