import { isPureScalar, refineScalars, viaCe } from './delegate';
import { combineLikeTerms } from '../polynomial/combine';
import { fromPolynomial, toPolynomial } from '../polynomial/convert';
import { normalize } from '../normalize/normalize';
import { ok, type Result } from '../result/result';
import type { TypedExpr, Env } from '../expression/node';

/**
 * 곱을 합 위로 완전히 분배하고 동류항을 합친다.
 *
 * `v^T(A+B)v` → `v^TAv + v^TBv`, `(A+B)²` → `A² + AB + BA + B²` (순서 유지).
 *
 * `fromPolynomial` 은 `buildMul` 로 좌결합 접기만 하고 평탄화·정렬은 안 한다 — 그 결과가
 * `parse()`(elaborate+normalize)가 같은 값에 대해 내놓는 트리와 **모양이 다를 수 있다**
 * (값은 같은데 구조가 달라 렌더→재파싱 왕복이 깨진다, 퍼즈로 확인). 그래서 끝에
 * `normalize` 를 한 번 더 걸어 어느 경로로 왔든 같은 값이 같은 트리로 수렴하게 한다.
 */
export function expand(e: TypedExpr, env: Env): Result<TypedExpr> {
  const result = expandRaw(e, env);
  if (!result.ok) return result;
  return normalize(result.value);
}

function expandRaw(e: TypedExpr, env: Env): Result<TypedExpr> {
  if (isPureScalar(e)) return ok(viaCe(e, 'expand', env));
  const p = toPolynomial(e);
  if (!p.ok) return p;
  return fromPolynomial(combineLikeTerms(refineScalars(p.value, 'expand', env, true)), e.shape);
}
