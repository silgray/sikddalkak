import {
  evaluate,
  collectFreeSymbols,
  exprKey,
  parse,
  parseSyntax,
  prettify,
  render,
  solveFor as solveEquation,
  substituteDeep,
  SCALAR_SHAPE,
  type Env,
  type FunctionDef,
} from './algebra';
import { buildCellEnv, splitDefinition, splitFunctionDefinition, splitRelation } from './cellEnv';
import { groupsOf } from './cellGroup';
import { scanLatex } from './editor/latexScan';
import { repairLatex } from './editor/wellformed';
import { SOLVE_ENABLED } from './features';
import type { EvalResult, FormulaObject } from './types';

/**
 * 셀 사이 층 — 이름 기반 의존성 그래프로 `src/algebra` 를 셀 목록에 얹는다.
 *
 * algebra는 "식 하나와 심볼 환경"만 안다(index.ts 서두). 위상정렬·순환 감지·중복정의·
 * 캐시는 여기, algebra 밖에 있다.
 *
 * **등식은 `solve for` 가 골라졌을 때만 계산된다.** `2x+1=7` 처럼 정의(변수·함수)가
 * 아닌 최상위 `=` 는 관계(relation) 노드가 된다 — `defName` 이 없어 아무것도 정의하지
 * 않고, 다른 셀에 solve 결과를 전달하지도 않는다(순수 표시용). `<`,`\leq` 같은 부등호는
 * 여전히 오류다. `EvalResult` 의 `boolean` 판정은 그대로 도달 불가로 남는다(부등호를
 * 지원할 때 쓸 자리).
 *
 * **변수와 함수는 한 이름 공간을 공유한다** — `a=3` 다음에 `a(x)=x` 를 쓰면 (또는
 * 그 반대여도) `duplicate definition` 이다. 함수의 매개변수 이름은 별개 규칙 —
 * 워크스페이스 어딘가의 다른 정의와 겹치면 오류지만, 서로 다른 함수끼리는 같은
 * 매개변수 이름을 써도 된다(각자 지역 이름이라서).
 *
 * **`mode`(symbolic/scoped) 는 안 본다 — 항상 치환한다.** UI에 mode 토글이 없어(어디서도
 * `setMode` 를 보내지 않는다) symbolic 모드는 이미 죽은 코드였다.
 */

// ---------------------------------------------------------------------------
// 구조 분류
// ---------------------------------------------------------------------------

type Structure =
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | {
      kind: 'node';
      /** 이 셀이 정의하는 이름 (정의가 아니면 null) */
      defName: string | null;
      /** 함수 정의의 매개변수 이름 (정의가 아니거나 변수 정의면 빈 배열) */
      params: readonly string[];
      /** 실제 평가할 LaTeX — 정의면 우변만, 아니면 식 전체 */
      value: string;
      /** 계산 순서를 정하는 간선 */
      deps: readonly string[];
    }
  | {
      kind: 'relation';
      lhs: string;
      rhs: string;
      /** 양변을 합친 자유 심볼 — solve 시 치환·위상 순서에 쓴다 */
      deps: readonly string[];
    };

type Node = {
  id: string;
  defName: string | null;
  params: readonly string[];
  value: string;
  deps: readonly string[];
  /** 등식 노드일 때만 채워진다. `defName`/`params` 는 등식이면 늘 `null`/`[]`. */
  relation: { lhs: string; rhs: string } | null;
  /** 이 등식을 어느 변수에 대해 풀지. `null` 이면 결과가 비어 있다(버튼 안 누른 상태). */
  solveFor: string | null;
};

/** 관계 기호 한 글자(문자 토큰)로 오는 것들. `=` 는 `splitRelation` 이 따로 본다. */
const RELATION_CHARS = new Set(['<', '>']);
/** 명령어로 오는 관계 기호. `scanLatex` 의 command 토큰은 `\` 를 포함한다. */
const RELATION_COMMANDS = new Set([
  '\\leq', '\\geq', '\\neq', '\\le', '\\ge', '\\ne', '\\leqslant', '\\geqslant', '\\neqslant',
]);

function hasTopLevelRelation(latex: string): boolean {
  return scanLatex(latex).tokens.some(
    (t) =>
      (t.kind === 'char' && RELATION_CHARS.has(t.text)) ||
      (t.kind === 'command' && RELATION_COMMANDS.has(t.text)),
  );
}

/**
 * 모양 문맥 없이(빈 `shapes`) 자유 심볼만 뽑는다. **의존 간선 추출 전용** — 실제 연산
 * 해석(내적이냐 행렬곱이냐)은 여기서 안 정해도 된다. 심볼 이름 집합은 모양과 무관하게
 * 항상 같다: `A` 를 스칼라로 잘못 가정해도 `AB` 는 `scalarMul([A,B])` 가 되지 `A`·`B` 라는
 * 이름 자체가 사라지지는 않는다. 오히려 **모양 없는 파싱이 더 관대해서**(행렬 전용
 * 모양 불일치 오류가 안 걸린다) 이 단계에서 실패하는 일은 거의 없다.
 *
 * 여기서 실패하면(정말 파싱이 안 되는 식) 의존 없음으로 본다 — 실제 오류 판정은
 * 아래 `computeNode` 가 진짜 환경으로 다시 파싱할 때 낸다.
 *
 * `exclude` 는 함수 정의의 매개변수를 뺄 때 쓴다 — `f(x)=x^2` 의 `x` 는 지역 이름이라
 * 셀 사이 의존 간선이 아니다. 함수 자신의 이름은 안 뺀다 — `f(x)=f(x-1)+1` 처럼
 * 자기 참조면 `f` 가 스스로의 의존이 되어 기존 순환 감지(`x=x` 와 같은 경로)에 걸린다.
 */
const BLIND_ENV: Env = { shapes: {} };
function dependencyNames(latex: string, exclude: readonly string[] = []): readonly string[] {
  const parsed = parse(latex, BLIND_ENV);
  if (!parsed.ok) return [];
  const names = collectFreeSymbols(parsed.value);
  return exclude.length === 0 ? names : names.filter((n) => !exclude.includes(n));
}

/** 파싱해서 구조만 뽑는다. 식 자체(latex)만으로 정해진다. */
function readStructure(latex: string): Structure {
  // 방어선 2 — 입력 경로가 교정하지 못한 저장본(옛 문서)도 계산되게.
  const repaired = repairLatex(latex.trim()).latex;
  if (repaired === '') return { kind: 'empty' };
  // 채우지 않은 칸이 남아 있으면 미완성이다. CE(algebra 내부의 symbolName도 마찬가지)는
  // `\placeholder{}` 를 파싱하지 못해 엉뚱한 메시지를 내므로 여기서 먼저 잡는다.
  if (repaired.includes('\\placeholder')) {
    return { kind: 'error', message: 'incomplete expression' };
  }

  const def = splitDefinition(repaired);
  if (def !== null) {
    return { kind: 'node', defName: def.name, params: [], value: def.rhs, deps: dependencyNames(def.rhs) };
  }
  // `splitDefinition` 과 `splitFunctionDefinition` 은 좌변 모양이 겹치지 않는다 —
  // 단일 심볼은 `apply` 가 아니다. 순서는 상관없다.
  const fnDef = splitFunctionDefinition(repaired);
  if (fnDef !== null) {
    return {
      kind: 'node',
      defName: fnDef.name,
      params: fnDef.params,
      value: fnDef.rhs,
      deps: dependencyNames(fnDef.rhs, fnDef.params),
    };
  }
  // 정의는 아닌데 최상위 `=` 가 있으면 등식이다 — solve 대상을 고르면 계산된다.
  const rel = splitRelation(repaired);
  if (rel !== null) {
    // ⚠ SOLVE_ENABLED=false 인 동안은 `=`도 부등호와 같은 "아직 지원 안 함" 오류로
    // 떨어뜨린다 — CE 0.90이 초월식을 못 풀고(`\cos(x)=x` 등이 빈 배열로 온다) 뉴턴
    // 시작점을 넘길 API도 없어서다(CE 실측 함정 참고). 조용히 빈 결과보다 정직하다.
    if (!SOLVE_ENABLED) return { kind: 'error', message: 'Relations are not supported yet' };
    // 의존 심볼은 양변을 하나로 합쳐 뽑는다 — 어느 쪽에 있든 solve 전 치환 대상이다.
    const deps = dependencyNames(`${rel.lhs}-\\left(${rel.rhs}\\right)`);
    return { kind: 'relation', lhs: rel.lhs, rhs: rel.rhs, deps };
  }
  // 부등호(`<`,`\leq` 등)는 아직 지원하지 않는다.
  if (hasTopLevelRelation(repaired)) {
    return { kind: 'error', message: 'Relations are not supported yet' };
  }
  return { kind: 'node', defName: null, params: [], value: repaired, deps: dependencyNames(repaired) };
}

// ---------------------------------------------------------------------------
// 캐시 (지문 = 식 + 의존 대상들의 지문)
// ---------------------------------------------------------------------------

type Computed = { result: EvalResult };

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
export function clearCellGraphCache(): void {
  structures.clear();
  computed.clear();
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

// ---------------------------------------------------------------------------
// 평가
// ---------------------------------------------------------------------------

/**
 * 함수 정의 셀(`f(x)=x^2`)의 결과 행. **계산하지 않고 원문을 그대로 되뇐다** —
 * 인수가 없어 모양을 모르니 진짜로 계산할 수가 없다(호출부마다 모양이 달라지는
 * 모양 다형, `elaborate.ts` 의 `instantiateFunction` 참고). 매개변수를 스칼라로
 * 가정해 정리해 보이는 것도 일부러 안 한다 — `f(x)=x^Tx` 같은 행렬 함수가 정의
 * 셀에서만 엉뚱한 꼴(스칼라 지수 `T`)이나 오류로 보이게 된다.
 *
 * 본문의 **구문 오류**는 여기서 그대로 낸다(`parseSyntax` 로 파싱은 하니까) — 모양
 * 오류만 호출부로 미뤄진다.
 */
function computeFunctionNode(node: Node): Computed {
  const syntax = parseSyntax(node.value);
  if (!syntax.ok) {
    return { result: { kind: 'error', message: syntax.errors[0].message } };
  }
  if (node.defName === null) {
    // 함수 노드는 항상 이름이 있다(`splitFunctionDefinition` 이 보장) — 방어적으로만.
    return { result: { kind: 'error', message: 'internal error: missing function name' } };
  }
  // 좌변(`f(x) =`)은 붙이지 않는다 — 결과 행은 정리된 우변만 보여준다(셀 그룹 규칙).
  // 본문을 그대로 되뇌는 것뿐이라 언제나 "안 바뀐" 결과다 — 상시 표시에서 숨을 대상.
  return {
    result: { kind: 'ok', latex: node.value, definitionName: node.defName, unchanged: true },
  };
}

/**
 * 등식 셀(`2x+1=7`)의 결과 행. `evaluateCells` 가 `solveFor === null` 인 관계 노드는
 * 애초에 그래프에 안 넣으므로(아래 참고) 여기 도달하면 항상 풀 대상이 있다 — `null`
 * 분기는 방어적으로만 남긴다.
 *
 * `lhs - \left(rhs\right)` 를 만들어 `parse` 한 뒤 algebra의 `solveFor` 에 넘긴다.
 * **풀 대상 심볼은 치환에서 뺀다** — 안 빼면 다른 셀의 `x=5` 같은 정의가 먼저 먹어버려
 * 풀 게 남지 않는다. 나머지 심볼은 평소처럼 다 치환한다 — 그래야 `ax=b` 가 `a`·`b` 둘
 * 다 정의돼 있으면 수치로, 아니면 수식으로 나온다(algebra가 알아서 가른다,
 * `transform/solve.ts` 문서의 실측 표 참고).
 */
function computeRelationNode(node: Node, env: Env): Computed {
  const symbol = node.solveFor;
  if (node.relation === null || symbol === null) {
    return { result: { kind: 'empty' } };
  }

  const diff = parse(`${node.relation.lhs}-\\left(${node.relation.rhs}\\right)`, env);
  if (!diff.ok) {
    return { result: { kind: 'error', message: diff.errors[0].message } };
  }

  const bindings = env.bindings ?? {};
  const freeBindings = Object.fromEntries(
    Object.entries(bindings).filter(([name]) => name !== symbol),
  );
  const substituted = substituteDeep(diff.value, { ...env, bindings: freeBindings });
  if (!substituted.ok) {
    return { result: { kind: 'error', message: substituted.errors[0].message } };
  }

  const solved = solveEquation(substituted.value, symbol, env);
  if (!solved.ok) {
    return { result: { kind: 'error', message: solved.errors[0].message } };
  }

  // 근이 여럿이면(`x^2=4` → 2, -2) 한 줄에 모은다 — 결과 행이 표시용이라 하나로 족하다.
  const symbolLatex = render({ op: 'sym', shape: SCALAR_SHAPE, name: symbol });
  const latex = solved.value
    .map((root) => `${symbolLatex} = ${render(prettify(root))}`)
    .join(',\\ ');
  // solve 결과는 항상 보여줄 값이다 — "안 바뀐 식" 판정이 애초에 안 맞는다(등식 자체와
  // 근의 표현은 형태가 다르다).
  return { result: { kind: 'ok', latex, definitionName: null, unchanged: false } };
}

/**
 * 셀 하나를 실제 환경으로 다시 파싱해 계산한다. `readStructure` 의 파싱(BLIND_ENV)을
 * 재사용하지 않는다 — 모양을 모르고 판단한 연산(스칼라곱 vs 행렬곱)이 실제와 다를 수
 * 있어서다.
 *
 * **정의 셀도 치환·평가를 거친다** — 결과 행에는 `B=A^T` 의 `A` 까지 실제로 풀린 값이
 * 보여야 한다(정의를 그때까지의 바인딩으로 치환한 값을 보여준다).
 * **함수 정의 셀은 예외다** — `computeFunctionNode` 로 갈라진다(위 문서 참고).
 * **등식 셀도 예외다** — `computeRelationNode` 로 갈라진다.
 */
function computeNode(node: Node, env: Env): Computed {
  if (node.relation !== null) return computeRelationNode(node, env);
  if (node.params.length > 0) return computeFunctionNode(node);

  const parsed = parse(node.value, env);
  if (!parsed.ok) {
    return { result: { kind: 'error', message: parsed.errors[0].message } };
  }
  const substituted = substituteDeep(parsed.value, env);
  if (!substituted.ok) {
    return { result: { kind: 'error', message: substituted.errors[0].message } };
  }
  const evaluated = evaluate(substituted.value, env);
  if (!evaluated.ok) {
    return { result: { kind: 'error', message: evaluated.errors[0].message } };
  }
  // `prettify` 는 **렌더 직전에만** 건다 — 사람이 읽기 좋은 순서는 출력용이고, 아래
  // `unchanged` 나 캐시 지문이 보는 건 정규화 순서 그대로여야 한다(`transform/prettify.ts`).
  const latex = render(prettify(evaluated.value));
  // 좌변(`a =`)은 붙이지 않는다 — 결과 행은 정리된 우변/식 자체만 보여준다.
  // "안 바뀐 식" 판정은 원본 파스 트리와 최종 평가 트리를 구조 비교한다 — `parse` 가
  // 이미 정규화를 하므로(`A+A`→`2A`) 그 지점부터 안 바뀐 것만 "unchanged"로 본다.
  const unchanged = exprKey(parsed.value) === exprKey(evaluated.value);
  return { result: { kind: 'ok', latex, definitionName: node.defName, unchanged } };
}

export type EvaluateCellsOptions = {
  /**
   * 셀 하나의 실제 계산(`computeNode`)을 시작하기 **직전**마다 부른다(캐시 적중이든
   * 아니든). `worker/algebra.worker.ts` 가 이걸로 "지금 어느 셀을 계산 중인가"를
   * 메인 스레드에 보고한다 — CE가 안 끝나 워커를 강제 종료해야 할 때 범인 셀을
   * 지목하는 유일한 방법이다(워커가 죽으면 지역 상태는 통째로 사라진다).
   */
  onCellStart?: (id: string) => void;
  /**
   * 이 id들은 `computeNode` 를 아예 안 부르고 곧장 타임아웃 오류로 채운다. 워커가
   * 어떤 셀에서 멈춰 강제 종료됐을 때, 재시도가 **같은 셀에서 다시 멈추는 무한
   * 재시도**를 막는 장치다(`worker/client.ts`) — 그 셀의 latex가 그대로인 한 계속
   * 막힌 채로 있고, 사용자가 고치면(=latex가 바뀌면) 클라이언트가 다시 기회를 준다.
   */
  forceTimeoutIds?: ReadonlySet<string>;
};

/**
 * 오브젝트 집합을 이름 기반 의존성 그래프로 평가한다. 배열 순서가 아니라 "누가 무엇을
 * 정의하고 누가 그 이름을 참조하는가"로 계산 순서가 정해진다.
 *
 * **환경은 한 번만 만든다.** algebra의 `buildEnv`/`substituteDeep` 은 순수 함수라 유효한
 * 정의를 한 번에 몰아넣고 끝이다 — 위상정렬은 **순환 감지 전용**과 캐시 지문(상류 지문이
 * 하류로 전파되게) 용도로만 쓴다.
 *
 * 선택 변환(`cellSelection.ts`)이 쓰는 환경과 결과 계산이 쓰는 환경이 어긋나면 안 되므로
 * `env` 를 같이 돌려준다 — `worker/algebra.worker.ts` 가 다음 선택 변환 요청에 그대로 쓴다.
 */
export function evaluateCells(
  objects: readonly FormulaObject[],
  options: EvaluateCellsOptions = {},
): { results: Map<string, EvalResult>; env: Env } {
  const results = new Map<string, EvalResult>();

  // --- 1단계: 그래프 구조 (안 바뀐 식은 캐시에서 꺼내 파싱을 건너뛴다) ---
  // 정의(defName 있음)는 셀 그룹 최상단에서만 허용한다 — 그룹 안 셀들은 계산상 서로
  // 무관해야 하는데(§CLAUDE.md 셀 그룹 규칙), 2번째 이하에서도 정의를 허용하면 그룹
  // 순서에 따라 이름 공간이 뒤바뀐다.
  const groupTops = new Set(groupsOf(objects).map((g) => objects[g.start].id));
  const nodes: Node[] = [];
  for (const object of objects) {
    // 꺼진 셀은 그래프에 아예 안 들어간다 — 정의도 안 하고 계산도 안 된다. 지운
    // 것처럼 취급하되 latex는 그대로 남는다(꺼졌다 켜지면 원래 식이 다시 보인다).
    if (!object.enabled) {
      results.set(object.id, { kind: 'empty' });
      continue;
    }
    const key = object.latex.trim();
    const structure = structures.get(key) ?? remember(structures, key, readStructure(object.latex));
    if (structure.kind === 'empty' || structure.kind === 'error') {
      results.set(object.id, structure);
      continue;
    }
    if (structure.kind === 'relation') {
      // solve 대상을 아직 안 골랐으면 그래프에 안 넣는다 — `defName` 이 없어 정의도
      // 안 하므로(아무도 이 셀에 의존하지 않는다) 빼도 다른 셀에 영향이 없고, 결과는
      // 버튼을 누르기 전이니 어차피 비어 있어야 한다.
      if (object.solveFor === null) {
        results.set(object.id, { kind: 'empty' });
        continue;
      }
      nodes.push({
        id: object.id,
        defName: null,
        params: [],
        value: `${structure.lhs}=${structure.rhs}`,
        deps: structure.deps,
        relation: { lhs: structure.lhs, rhs: structure.rhs },
        solveFor: object.solveFor,
      });
      continue;
    }
    if (structure.defName !== null && !groupTops.has(object.id)) {
      results.set(object.id, {
        kind: 'error',
        message: 'definitions are only allowed at the top of a cell group',
      });
      continue;
    }
    nodes.push({
      id: object.id,
      defName: structure.defName,
      params: structure.params,
      value: structure.value,
      deps: structure.deps,
      relation: null,
      solveFor: null,
    });
  }

  // --- 2단계: 이름 -> 정의한 오브젝트 ---
  //
  // **변수와 함수가 한 이름 공간을 공유한다** — `defName` 은 어느 쪽이든 같은 필드라
  // `a=3` 과 `a(x)=x` 가 여기서 자동으로 같은 이름을 다투는 것으로 잡힌다(추가 분기 없이).
  const definers = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.defName !== null) pushTo(definers, node.defName, node.id);
  }
  const duplicated = new Set<string>();
  const resolvable = new Map<string, string>();
  for (const [name, ids] of definers) {
    if (ids.length > 1) duplicated.add(name);
    else resolvable.set(name, ids[0]);
  }

  // --- 2.5단계: 함수 매개변수 이름이 다른 정의와 충돌하는지 ---
  //
  // "매개변수 이름이 이미 다른 곳에서 정의되어 있으면 오류. 서로 다른 함수끼리는
  // 같은 매개변수 이름을 써도 된다" — 그래서 **`definers`(전역 정의 이름 집합)** 하고만
  // 비교한다. 다른 함수의 매개변수는 그 함수 안에서만 존재하는 지역 이름이라
  // `definers` 에 없다(함수 정의는 `defName` 만 올라가고 `params` 는 안 올라간다).
  const paramCollision = new Map<string, string>();
  for (const node of nodes) {
    if (node.params.length === 0) continue;
    const collided = node.params.find((p) => definers.has(p));
    if (collided !== undefined) paramCollision.set(node.id, collided);
  }

  // --- 3단계: 위상정렬 (Kahn) — 순환 감지 + 캐시 지문 전파용 ---
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    const deps = new Set(
      node.deps
        .map((name) => resolvable.get(name))
        .filter((id): id is string => id !== undefined && byId.has(id)),
    );
    for (const dep of deps) {
      indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
      pushTo(dependents, dep, node.id);
    }
  }

  const queue = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
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

  // 위상정렬에 들어가지 못한 것들이 순환에 걸린 노드다. `x=x` 같은 자기 참조도 여기
  // 포함된다 — 자기 자신으로 정의하는 건 의미가 없으므로 순환으로 보는 게 맞다.
  const placed = new Set(ordered);
  const stuck = nodes.filter((n) => !placed.has(n.id));
  const stuckIds = new Set(stuck.map((n) => n.id));
  if (stuck.length > 0) {
    const names = stuck.map((n) => n.defName).filter((n): n is string => n !== null);
    const detail = names.length > 0 ? `: ${[...new Set(names)].sort().join(', ')}` : '';
    for (const node of stuck) {
      results.set(node.id, { kind: 'error', message: `cyclic reference${detail}` });
    }
  }

  // --- 4단계: 환경 구성 — 순환·중복·매개변수 충돌이 아닌 정의만 (한 번에) ---
  const definitions: Record<string, string> = {};
  const functionDefinitions: Record<string, FunctionDef> = {};
  for (const node of nodes) {
    if (node.defName === null) continue;
    if (duplicated.has(node.defName)) continue;
    if (stuckIds.has(node.id)) continue;
    if (paramCollision.has(node.id)) continue;
    if (node.params.length > 0) {
      // 본문 파싱 실패는 여기서 조용히 빠뜨린다(env에 안 들어가면 호출부는 "정의
      // 없음"으로 본다) — 사용자가 보는 구체적인 구문 오류는 `computeFunctionNode`
      // 가 이 정의 셀 자신의 결과 행에 낸다.
      const syntax = parseSyntax(node.value);
      if (syntax.ok) functionDefinitions[node.defName] = { params: node.params, body: syntax.value };
      continue;
    }
    definitions[node.defName] = node.value;
  }
  const env = buildCellEnv(definitions, functionDefinitions);

  // --- 5단계: 캐시 지문 — 위상 순서대로 전파한다(상류 지문이 하류에 자동 반영) ---
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
    // defName을 지문에 넣어야 한다 — `node.value`는 정의 셀이면 **우변뿐**이라
    // (`a=M`, `q=M`처럼) 이름만 다른 두 정의가 같은 우변 텍스트를 쓰면 지문이 겹친다.
    // 결과 latex(`"a = …"` vs `"q = …"`)가 이름을 담고 있으니 지문도 담아야 한다.
    // solveFor도 넣는다 — 안 넣으면 같은 등식에서 solve 대상만 바꿔도(또는 껐다 켜도)
    // 캐시가 옛 결과를 그대로 돌려준다.
    fingerprints.set(
      id,
      `${node.defName ?? ''}|${node.value}|${node.solveFor ?? ''}|${depPrints.join('&')}`,
    );
  }

  // --- 6단계: 평가 (순환 아닌 노드만, 순서는 무관 — env가 이미 완성돼 있다) ---
  for (const node of nodes) {
    if (stuckIds.has(node.id)) continue; // 3단계에서 이미 결과를 채웠다.
    if (node.defName !== null && duplicated.has(node.defName)) {
      results.set(node.id, { kind: 'error', message: `duplicate definition: ${node.defName}` });
      continue;
    }
    const collidedParam = paramCollision.get(node.id);
    if (collidedParam !== undefined) {
      results.set(node.id, {
        kind: 'error',
        message: `parameter ${collidedParam} is already defined elsewhere`,
      });
      continue;
    }
    if (options.forceTimeoutIds?.has(node.id)) {
      results.set(node.id, { kind: 'error', message: 'Computation timed out' });
      continue;
    }
    options.onCellStart?.(node.id);
    const fingerprint =
      fingerprints.get(node.id) ?? `${node.defName ?? ''}|${node.value}|${node.solveFor ?? ''}|`;
    const entry = computed.get(fingerprint) ?? remember(computed, fingerprint, computeNode(node, env));
    results.set(node.id, entry.result);
  }

  return { results, env };
}
