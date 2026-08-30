import { deferEngine } from '../ce/engine';
import { elaborate, withBoundScalars } from '../parse/elaborate';
import { buildAdd, buildMul } from '../expression/builders';
import { parseCeJson } from '../parse/parse';
import { render } from '../render';
import { isPureScalar } from './delegate';
import { mapChildren } from '../expression/traversal';
import { evaluate } from './evaluate';
import { asKnownInteger } from '../expression/key';
import { guardCe } from '../ce/budget';
import { ok, type Result } from '../result/result';
import { SCALAR, isKnownShape, isScalar, type Shape } from '../shape/shape';
import { intLit } from '../literal/literal';
import type { Env, TypedExpr } from '../expression/node';

/**
 * `evaluate` 의 마지막 전 단계 — 미분/적분/`\sum`/`\prod` 를 실제로 계산한다.
 *
 * `matPow`/`matrixFold.ts` 와 같은 규율을 따른다: **접을 수 없으면 오류가 아니라 원래
 * 노드를 그대로 돌려준다.** 대상 노드가 아니면 자식만 재귀한다(`mapChildren` 재사용,
 * `matrixFold.ts` 처럼 이 파일만의 21-case 전체 순회를 새로 안 만든다).
 *
 * 요구사항대로 **바텀업**이다 — 각 노드를 처리하기 전에 그 본문(과 상하한)을 먼저
 * `evaluate` 로 완전히 계산해 값으로 확정짓는다(`evaluate` 자체를 재귀 호출하므로
 * 중첩된 미적분 노드·행렬 리터럴 산술·CE 스칼라 정리가 한 번에 끝난다).
 */
export function foldCalculus(e: TypedExpr, env: Env): Result<TypedExpr> {
  switch (e.op) {
    case 'deriv':
      return foldDeriv(e, env);
    case 'sum':
    case 'prod':
      return foldSumProd(e, env);
    case 'integral':
      return foldIntegral(e, env);
    default:
      return mapChildren(e, (child) => foldCalculus(child, env));
  }
}

/** 이 파일 전용 CE 인스턴스 (`ce/engine.ts` 참고). */
const ce = deferEngine();

/** `\sum`/`\prod` 를 실제로 펼칠 최대 항 수. 폭주 방지용(`matrixFold.ts` 의 크기 상한과 같은 취지). */
const MAX_EXPANSION = 64;

const numAtom = (n: number): TypedExpr => ({ op: 'num', shape: SCALAR, value: intLit(n) });

// ---------------------------------------------------------------------------
// 미분
// ---------------------------------------------------------------------------

/** 순수 스칼라 식 하나를 CE의 `D` 에 위임한다. 실패하면 `null`(원본 유지 규약). */
function ceDerivOnce(body: TypedExpr, variable: string, env: Env): TypedExpr | null {
  try {
    const node: TypedExpr = { op: 'deriv', shape: body.shape, body, vars: [variable], order: 1 };
    const parsed = ce().parse(render(node));
    if (!parsed.isValid) return null;
    const evaluated = guardCe(ce(), 'deriv', () => parsed.evaluate());
    const syntax = parseCeJson(evaluated.json);
    if (!syntax.ok) return null;
    const typed = elaborate(syntax.value, env);
    if (!typed.ok || !isScalar(typed.value.shape)) return null;
    return typed.value;
  } catch {
    return null;
  }
}

function differentiateScalar(body: TypedExpr, variable: string, order: number, env: Env): TypedExpr | null {
  let current = body;
  for (let i = 0; i < order; i += 1) {
    const next = ceDerivOnce(current, variable, env);
    if (next === null) return null;
    current = next;
  }
  return current;
}

/** 본문이 행렬 리터럴이면 원소별로, 순수 스칼라면 그대로 미분한다. 그 밖은 `null`. */
function differentiateElementwise(
  body: TypedExpr,
  variable: string,
  order: number,
  env: Env,
): TypedExpr | null {
  if (body.op === 'matrix') {
    const rows: TypedExpr[][] = [];
    for (const row of body.rows) {
      const newRow: TypedExpr[] = [];
      for (const cell of row) {
        const d = differentiateScalar(cell, variable, order, env);
        if (d === null) return null;
        newRow.push(d);
      }
      rows.push(newRow);
    }
    return { op: 'matrix', shape: body.shape, rows };
  }
  if (isPureScalar(body)) return differentiateScalar(body, variable, order, env);
  return null;
}

/**
 * 다변수 미분(그래디언트/야코비안). 본문이 **리터럴**이어야 성분에 접근할 수 있다 —
 * 기호 벡터(`v`)는 성분을 모르므로 미평가로 남긴다.
 */
function differentiateMultivar(
  vars: readonly string[],
  body: TypedExpr,
  env: Env,
): TypedExpr | null {
  if (isScalar(body.shape)) {
    const cells: TypedExpr[] = [];
    for (const v of vars) {
      const d = differentiateScalar(body, v, 1, env);
      if (d === null) return null;
      cells.push(d);
    }
    return { op: 'matrix', shape: { rows: 1, cols: vars.length }, rows: [cells] };
  }
  if (body.op !== 'matrix') return null;
  const rows: TypedExpr[][] = [];
  for (const row of body.rows) {
    const cell = row[0];
    const newRow: TypedExpr[] = [];
    for (const v of vars) {
      const d = differentiateScalar(cell, v, 1, env);
      if (d === null) return null;
      newRow.push(d);
    }
    rows.push(newRow);
  }
  return { op: 'matrix', shape: { rows: body.shape.rows, cols: vars.length }, rows };
}

function foldDeriv(e: Extract<TypedExpr, { op: 'deriv' }>, env: Env): Result<TypedExpr> {
  const bodyResult = evaluate(e.body, withBoundScalars(env, e.vars));
  if (!bodyResult.ok) return bodyResult;
  const body = bodyResult.value;
  const fallback: TypedExpr = { op: 'deriv', shape: e.shape, body, vars: e.vars, order: e.order };

  if (e.vars.length === 1) {
    const d = differentiateElementwise(body, e.vars[0], e.order, env);
    return ok(d ?? fallback);
  }
  const d = differentiateMultivar(e.vars, body, env);
  return ok(d ?? fallback);
}

// ---------------------------------------------------------------------------
// 적분
// ---------------------------------------------------------------------------

function ceIntegrateOnce(
  body: TypedExpr,
  variable: string,
  lower: TypedExpr | null,
  upper: TypedExpr | null,
  env: Env,
): TypedExpr | null {
  try {
    const node: TypedExpr = { op: 'integral', shape: SCALAR, body, variable, lower, upper };
    const parsed = ce().parse(render(node));
    if (!parsed.isValid) return null;
    // CE 0.90은 어떤 적분에서 안 돌아온다 — 상한을 걸고, 걸리면 미평가로 남긴다
    // (`ce/budget.ts` 서두에 실측 사례).
    const evaluated = guardCe(ce(), 'integral', () => parsed.evaluate());
    const syntax = parseCeJson(evaluated.json);
    if (!syntax.ok) return null;
    const typed = elaborate(syntax.value, env);
    if (!typed.ok || !isScalar(typed.value.shape)) return null;
    return typed.value;
  } catch {
    return null;
  }
}

function integrateElementwise(
  body: TypedExpr,
  variable: string,
  lower: TypedExpr | null,
  upper: TypedExpr | null,
  env: Env,
): TypedExpr | null {
  if (body.op === 'matrix') {
    const rows: TypedExpr[][] = [];
    for (const row of body.rows) {
      const newRow: TypedExpr[] = [];
      for (const cell of row) {
        const r = ceIntegrateOnce(cell, variable, lower, upper, env);
        if (r === null) return null;
        newRow.push(r);
      }
      rows.push(newRow);
    }
    return { op: 'matrix', shape: body.shape, rows };
  }
  if (isPureScalar(body)) return ceIntegrateOnce(body, variable, lower, upper, env);
  return null;
}

function foldIntegral(e: Extract<TypedExpr, { op: 'integral' }>, env: Env): Result<TypedExpr> {
  const bodyResult = evaluate(e.body, withBoundScalars(env, [e.variable]));
  if (!bodyResult.ok) return bodyResult;
  const body = bodyResult.value;

  const lowerResult = e.lower !== null ? evaluate(e.lower, env) : null;
  if (lowerResult !== null && !lowerResult.ok) return lowerResult;
  const upperResult = e.upper !== null ? evaluate(e.upper, env) : null;
  if (upperResult !== null && !upperResult.ok) return upperResult;
  const lower = lowerResult === null ? null : lowerResult.value;
  const upper = upperResult === null ? null : upperResult.value;

  const fallback: TypedExpr = { op: 'integral', shape: e.shape, body, variable: e.variable, lower, upper };
  const integrated = integrateElementwise(body, e.variable, lower, upper, env);
  return ok(integrated ?? fallback);
}

// ---------------------------------------------------------------------------
// \sum / \prod
// ---------------------------------------------------------------------------

/**
 * 인덱스 하나를 값으로 치환한다. 공용 `substitute`(`substitute.ts`) 를 안 쓰는 이유는
 * **섀도잉** 때문이다 — `\sum_k(\sum_k(k))` 처럼 안쪽 바인더가 같은 이름을 다시 쓰면
 * 바깥 치환이 안쪽까지 새어 들어가면 안 된다. 여기서는 안쪽 바인더가 같은 이름을 다시
 * 선언한 서브트리를 만나면 그 자리에서 멈춘다(상하한은 바깥 스코프이므로 계속 치환한다).
 */
function substituteIndex(e: TypedExpr, name: string, value: TypedExpr): TypedExpr {
  if (e.op === 'sym') return e.name === name ? value : e;
  if (e.op === 'deriv' && e.vars.includes(name)) return e;
  if ((e.op === 'sum' || e.op === 'prod' || e.op === 'integral') && e.variable === name) {
    return {
      ...e,
      lower: e.lower !== null ? substituteIndex(e.lower, name, value) : null,
      upper: e.upper !== null ? substituteIndex(e.upper, name, value) : null,
    };
  }
  const mapped = mapChildren(e, (child) => ok(substituteIndex(child, name, value)));
  return mapped.ok ? mapped.value : e;
}

/** 빈 범위(하한 > 상한)의 값 — `\sum` 은 영, `\prod` 은 항등원. */
function emptyRangeValue(op: 'sum' | 'prod', target: Shape): TypedExpr {
  if (!isKnownShape(target) || isScalar(target)) return numAtom(op === 'sum' ? 0 : 1);
  const n = target.rows as number;
  const m = target.cols as number;
  const rows: TypedExpr[][] = [];
  for (let i = 0; i < n; i += 1) {
    const row: TypedExpr[] = [];
    for (let j = 0; j < m; j += 1) row.push(numAtom(op === 'prod' && i === j ? 1 : 0));
    rows.push(row);
  }
  return { op: 'matrix', shape: target, rows };
}

function foldSumProd(
  e: Extract<TypedExpr, { op: 'sum' | 'prod' }>,
  env: Env,
): Result<TypedExpr> {
  const lowerResult = e.lower !== null ? evaluate(e.lower, env) : null;
  if (lowerResult !== null && !lowerResult.ok) return lowerResult;
  const upperResult = e.upper !== null ? evaluate(e.upper, env) : null;
  if (upperResult !== null && !upperResult.ok) return upperResult;
  const lower = lowerResult === null ? null : lowerResult.value;
  const upper = upperResult === null ? null : upperResult.value;

  const fallback = (): Result<TypedExpr> => {
    const bodyResult = evaluate(e.body, withBoundScalars(env, [e.variable]));
    if (!bodyResult.ok) return bodyResult;
    return ok({ op: e.op, shape: e.shape, body: bodyResult.value, variable: e.variable, lower, upper });
  };

  const lo = lower !== null ? asKnownInteger(lower) : null;
  const hi = upper !== null ? asKnownInteger(upper) : null;
  if (lo === null || hi === null || hi - lo + 1 > MAX_EXPANSION) return fallback();
  if (hi < lo) return ok(emptyRangeValue(e.op, e.shape));

  const terms: TypedExpr[] = [];
  for (let i = lo; i <= hi; i += 1) {
    const substituted = substituteIndex(e.body, e.variable, numAtom(i));
    const evaluated = evaluate(substituted, env);
    if (!evaluated.ok) return evaluated;
    terms.push(evaluated.value);
  }

  if (e.op === 'sum') {
    const combined = buildAdd(terms);
    if (!combined.ok) return combined;
    return evaluate(combined.value, env);
  }
  const combined = terms
    .slice(1)
    .reduce<Result<TypedExpr>>((acc, t) => (acc.ok ? buildMul(acc.value, t) : acc), ok(terms[0]));
  if (!combined.ok) return combined;
  return evaluate(combined.value, env);
}
