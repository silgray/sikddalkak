import { instantiateFunction } from '../parse/elaborate';
import { substitute } from './substitute';
import { mapChildren } from '../expression/traversal';
import { evaluate } from './evaluate';
import { failWith, ok, type Result } from '../result/result';
import type { Env, TypedExpr } from '../expression/node';

/**
 * `evaluate` 의 한 단계 — `apply`(사용자 정의 함수 호출)를 실제 값으로 편다.
 *
 * `foldCalculus`(`calculus.ts`)와 같은 규율을 따른다: **접을 수 없으면 오류가 아니라
 * 원래 노드를 그대로 돌려준다.** 대상 노드가 아니면 자식만 재귀한다(`mapChildren` 재사용).
 *
 * **바텀업이다** — 인수를 먼저 완전히 `evaluate` 해 값으로 확정지은 뒤에야 함수 본문에
 * 꽂는다. 재귀 깊이는 `instantiateFunction`(`elaborate.ts`)이 이미 막는다 — 상호
 * 재귀(`f(x)=g(x)`, `g(x)=f(x)`)는 모양 계산 단계에서 먼저 걸린다(같은 이름의 함수를
 * 다시 만나면 그 즉시 재귀가 시작되므로, 값 확장 쪽에 따로 상한을 둘 필요가 없다).
 *
 * ⚠ **자기 자신을 참조하는 재귀 정의(`f(x)=f(x-1)+1`)는 지원하지 않는다.** 모양은
 * 인수의 **값**이 아니라 **모양**만 보고 정해지므로, `x-1` 도 `x` 와 똑같이 스칼라라
 * elaborate가 "언젠가 멈출 근거"를 알 도리가 없다 — 결국 상한에 걸려 오류로 남는다.
 * 이 상한은 재귀를 지원하려는 게 아니라 상호 순환이 무한 루프·스택 오버플로로 앱을
 * 멈추지 않게 막는 안전장치다.
 */
export function foldFunctions(e: TypedExpr, env: Env): Result<TypedExpr> {
  if (e.op !== 'apply') return mapChildren(e, (child) => foldFunctions(child, env));
  return foldApply(e, env);
}

function foldApply(e: Extract<TypedExpr, { op: 'apply' }>, env: Env): Result<TypedExpr> {
  const argResults = e.args.map((a) => evaluate(a, env));
  const errors = argResults.flatMap((a) => (a.ok ? [] : a.errors));
  if (errors.length > 0) return failWith(errors);
  const args = argResults.map((a) => (a as { value: TypedExpr }).value);
  const fallback: TypedExpr = { ...e, args };

  // `env.functions` 에 없으면 이론적으로만 가능하다 — elaborate가 애초에 이 이름을
  // `apply` 로 안 남겼을 것이다(같은 env로 elaborate했다면). 방어적으로만 남겨둔다.
  const fn = env.functions?.[e.name];
  if (fn === undefined) return ok(fallback);

  // 모양 계산과 같은 헬퍼로 본문을 다시 elaborate한다 — 이번엔 **인수 값**을 매개변수에
  // 꽂아야 하므로, 결과 트리(모양만 쓰고 버리던 elaborate 쪽과 달리)를 그대로 쓴다.
  const instantiated = instantiateFunction(fn, args, env);
  if (!instantiated.ok) return ok(fallback);

  const bindings: Record<string, TypedExpr> = { ...env.bindings };
  for (let i = 0; i < fn.params.length; i += 1) bindings[fn.params[i]] = args[i];
  const substituted = substitute(instantiated.value, { ...env, bindings });
  if (!substituted.ok) return ok(fallback);

  // 재귀 evaluate — 중첩된 함수 호출·행렬 리터럴 산술·CE 스칼라 정리가 한 번에 끝난다
  // (`foldCalculus` 의 미적분 본문 평가와 같은 이유, `evaluate` 문서 참고).
  return evaluate(substituted.value, env);
}
