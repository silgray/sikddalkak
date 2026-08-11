import {
  evaluate,
  collectFreeSymbols,
  parse,
  parseSyntax,
  render,
  substituteDeep,
  type Env,
  type FunctionDef,
} from './algebra';
import { buildCellEnv, splitDefinition, splitFunctionDefinition } from './cellEnv';
import { scanLatex } from './editor/latexScan';
import { repairLatex } from './editor/wellformed';
import type { EvalResult, FormulaObject } from './types';

/**
 * 셀 사이 층 — 이름 기반 의존성 그래프로 `src/algebra` 를 셀 목록에 얹는다.
 *
 * algebra는 "식 하나와 심볼 환경"만 안다(index.ts 서두). 위상정렬·순환 감지·중복정의·
 * 캐시는 여기, algebra 밖에 있다.
 *
 * **관계식은 아직 없다.** `a=3`(변수)·`f(x)=x^2`(함수) 같은 정의만 지원하고,
 * `1=1`·`x^2=4`·`2<1` 처럼 최상위에 관계 기호가 있는데 정의가 아니면 오류로 표시한다.
 * `EvalResult` 의 `boolean` 판정은 나중에 쓴다 — 지금은 이 경로로 갈 방법이 없을 뿐,
 * 타입은 그대로 둔다.
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
    };

type Node = {
  id: string;
  defName: string | null;
  params: readonly string[];
  value: string;
  deps: readonly string[];
};

/** 관계 기호 한 글자(문자 토큰)로 오는 것들. `=` 는 `splitDefinition` 이 따로 본다. */
const RELATION_CHARS = new Set(['<', '>']);
/** 명령어로 오는 관계 기호. `scanLatex` 의 command 토큰은 `\` 를 포함한다. */
const RELATION_COMMANDS = new Set([
  '\\leq', '\\geq', '\\neq', '\\le', '\\ge', '\\ne', '\\leqslant', '\\geqslant', '\\neqslant',
]);

function hasTopLevelEquals(latex: string): boolean {
  return scanLatex(latex).tokens.some((t) => t.kind === 'char' && t.text === '=');
}

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
  // 채우지 않은 칸이 남아 있으면 미완성이다. CE(algebra 내부의 parseSymbol도 마찬가지)는
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
  // 정의가 아닌데 최상위에 관계 기호가 있으면 관계식이다 — 이번 라운드는 지원하지 않는다.
  if (hasTopLevelEquals(repaired) || hasTopLevelRelation(repaired)) {
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
  const lhs = `${node.defName}\\left(${node.params.join(',')}\\right)`;
  return {
    result: { kind: 'ok', latex: `${lhs} = ${node.value}`, json: null, definitionName: node.defName },
  };
}

/**
 * 셀 하나를 실제 환경으로 다시 파싱해 계산한다. `readStructure` 의 파싱(BLIND_ENV)을
 * 재사용하지 않는다 — 모양을 모르고 판단한 연산(스칼라곱 vs 행렬곱)이 실제와 다를 수
 * 있어서다.
 *
 * **정의 셀도 치환·평가를 거친다** — 결과 행에는 `B=A^T` 의 `A` 까지 실제로 풀린 값이
 * 보여야 한다(정의를 그때까지의 바인딩으로 치환한 값을 보여준다).
 * **함수 정의 셀은 예외다** — `computeFunctionNode` 로 갈라진다(위 문서 참고).
 */
function computeNode(node: Node, env: Env): Computed {
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
  const latex = render(evaluated.value);
  // json은 아무도 안 읽는다(EvalResult 정의부 참고) — algebra의 정본은 TypedExpr지
  // MathJSON이 아니라서 채울 게 없다. null로 정직하게 둔다.
  return node.defName === null
    ? { result: { kind: 'ok', latex, json: null, definitionName: null } }
    : { result: { kind: 'ok', latex: `${node.defName} = ${latex}`, json: null, definitionName: node.defName } };
}

/**
 * 오브젝트 집합을 이름 기반 의존성 그래프로 평가한다. 배열 순서가 아니라 "누가 무엇을
 * 정의하고 누가 그 이름을 참조하는가"로 계산 순서가 정해진다.
 *
 * **환경은 한 번만 만든다.** algebra의 `buildEnv`/`substituteDeep` 은 순수 함수라 유효한
 * 정의를 한 번에 몰아넣고 끝이다 — 위상정렬은 **순환 감지 전용**과 캐시 지문(상류 지문이
 * 하류로 전파되게) 용도로만 쓴다.
 *
 * 선택 변환(`Cell.tsx`)이 쓰는 환경과 결과 계산이 쓰는 환경이 어긋나면 안 되므로
 * `env` 를 같이 돌려준다 — 호출자가 그대로 `Cell` 에 내려준다.
 */
export function evaluateCells(
  objects: readonly FormulaObject[],
): { results: Map<string, EvalResult>; env: Env } {
  const results = new Map<string, EvalResult>();

  // --- 1단계: 그래프 구조 (안 바뀐 식은 캐시에서 꺼내 파싱을 건너뛴다) ---
  const nodes: Node[] = [];
  for (const object of objects) {
    const key = object.latex.trim();
    const structure = structures.get(key) ?? remember(structures, key, readStructure(object.latex));
    if (structure.kind !== 'node') {
      results.set(object.id, structure);
      continue;
    }
    nodes.push({
      id: object.id,
      defName: structure.defName,
      params: structure.params,
      value: structure.value,
      deps: structure.deps,
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
    fingerprints.set(id, `${node.defName ?? ''}|${node.value}|${depPrints.join('&')}`);
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
    const fingerprint = fingerprints.get(node.id) ?? `${node.defName ?? ''}|${node.value}|`;
    const entry = computed.get(fingerprint) ?? remember(computed, fingerprint, computeNode(node, env));
    results.set(node.id, entry.result);
  }

  return { results, env };
}
