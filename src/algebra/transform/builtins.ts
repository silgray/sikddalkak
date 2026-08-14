import { createEngine } from '../ce/engine';
import { elaborate } from '../parse/elaborate';
import { mapChildren } from '../expression/traversal';
import { parseCeJson } from '../parse/parse';
import { cellToJson, matrixLiteralToJson } from './matrixFold';
import { evaluate } from './evaluate';
import { guardCe } from '../ce/budget';
import { failWith, ok, type Result } from '../result/result';
import { SCALAR } from '../shape/shape';
import { intLit } from '../literal/literal';
import type { Env, TypedExpr } from '../expression/node';

/**
 * `evaluate` 의 한 단계 — `det`/`tr`/`Re`/`Im`/`conjugate`(`call` 노드)를 실제 값으로 편다.
 *
 * `functions.ts` 의 `foldFunctions`(사용자 정의 함수)와 같은 규율이다: **접을 수 없으면
 * 오류가 아니라 원래 노드를 그대로 돌려준다.** 대상 노드가 아니면 자식만 재귀한다
 * (`mapChildren` 재사용). 다섯 함수 전부 요청대로 **`evaluate` 에서만** 전개된다 —
 * `transform/delegate.ts` 의 `isPureScalar` 가 이 이름들을 `expand`/`simplify`/`factor`의
 * CE 위임 대상에서 미리 빼놨으므로, 그 전 단계에서는 절대 안 접힌다.
 *
 * **`foldMatrices` 뒤, `foldCalculus` 앞에서 돈다**(`evaluate.ts`) — `det`/`tr` 이 인수를
 * 구체 `matrix` 리터럴로 보려면 행렬 리터럴 산술이 먼저 끝나 있어야 한다.
 */
export function foldBuiltins(e: TypedExpr, env: Env): Result<TypedExpr> {
  if (e.op !== 'call' || CE_HEAD[e.name] === undefined) {
    return mapChildren(e, (child) => foldBuiltins(child, env));
  }
  return foldBuiltinCall(e, env);
}

/** 우리 `call` 이름 → CE 함수 머리. */
const CE_HEAD: Record<string, string> = {
  det: 'Determinant',
  tr: 'Trace',
  Re: 'Real',
  Im: 'Imaginary',
  // ⚠ `OverBar` 가 아니라 `Conjugate` — `OverBar` 는 `.evaluate()` 해도 안 풀린다(실측,
  // `parse/translate.ts` 의 `MATRIX_AWARE_FUNCTIONS` 문서 참고). 파싱은 `OverBar` 를
  // 받고, 계산은 `Conjugate` 로 위임한다.
  conjugate: 'Conjugate',
};

/** 이 파일 전용 CE 인스턴스 (`ce/engine.ts` 참고). */
const ce = createEngine();

/** 되돌아온 결과를 다시 읽을 때 쓰는 env — 결과는 항상 스칼라라 미지 심볼은 스칼라 가정이 맞다. */
const EMPTY_ENV: Env = { shapes: {} };

function foldBuiltinCall(e: Extract<TypedExpr, { op: 'call' }>, env: Env): Result<TypedExpr> {
  const argResults = e.args.map((a) => evaluate(a, env));
  const errors = argResults.flatMap((a) => (a.ok ? [] : a.errors));
  if (errors.length > 0) return failWith(errors);
  const args = argResults.map((a) => (a as { value: TypedExpr }).value);
  const fallback: TypedExpr = { ...e, args };

  const arg = args[0];
  if (arg === undefined) return ok(fallback);

  // `matIdentity` 는 `matrixFold.ts` 의 리터럴 산술이 모르는 노드다(`op !== 'matrix'`) —
  // `det(I_n)=1`, `tr(I_n)=n` 을 직접 처리한다. 모양이 아직 안 정해졌으면(단독 `I`)
  // 손대지 않는다.
  if (arg.op === 'matIdentity') {
    const n = arg.shape.rows;
    if (typeof n !== 'number') return ok(fallback);
    if (e.name === 'det') return ok({ op: 'num', shape: SCALAR, value: intLit(1) });
    if (e.name === 'tr') return ok({ op: 'num', shape: SCALAR, value: intLit(n) });
    return ok(fallback);
  }

  const json = arg.op === 'matrix' ? matrixLiteralToJson(arg) : cellToJson(arg);
  if (json === null) return ok(fallback);
  try {
    const evaluated = guardCe(ce, e.name, () => ce.box([CE_HEAD[e.name], json]).evaluate());
    const syntax = parseCeJson(evaluated.json);
    if (!syntax.ok) return ok(fallback);
    const typed = elaborate(syntax.value, EMPTY_ENV);
    if (!typed.ok) return ok(fallback);
    return ok(typed.value);
  } catch {
    return ok(fallback);
  }
}
