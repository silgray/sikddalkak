import { isFunction, isSymbol } from '@cortex-js/compute-engine';
import type { Expression, MathJsonExpression } from '@cortex-js/compute-engine';
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

function computeNode(node: Node, bindings: Bindings, duplicated: ReadonlySet<string>): Computed {
  try {
    // 여기서 파싱한다. 위상 순서상 선행 정의가 이미 declare된 뒤이므로
    // 행렬 심볼의 곱셈 피연산자 순서가 보존된다. 구조 파악 때의 파싱을
    // 재사용하면 `(2x2) a` 가 `a (2x2)` 로 뒤집힌다 — 행렬곱은 교환법칙이
    // 없으므로 오답이다.
    const parsed = ce.parse(node.input.latex.trim());
    const expr = rewriteBoundApplications(parsed, bindings);
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
      const value = reduce(def.value.subs(bindings));
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
    const result = reduce(base);
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
function rewriteBoundApplications(expr: Expression, bindings: Bindings): Expression {
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
  return changed ? ce.box(rewritten) : expr;
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
        remember(computed, fingerprint, computeNode(node, bindings, duplicated));
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
