import { mapChildren } from '../expression/traversal';
import { normalize } from '../normalize/normalize';
import { ok, type Result } from '../result/result';
import type { TypedExpr, Env } from '../expression/node';

/**
 * 정의된 심볼을 그 정의로 바꾼다. **한 단계만** — 치환한 결과 안의 심볼은 다시 치환하지
 * 않는다. 반복은 호출자가 결정한다 (그래야 사용자가 한 단계씩 눈으로 볼 수 있다).
 */
export function substitute(e: TypedExpr, env: Env): Result<TypedExpr> {
  const bindings = env.bindings;
  if (bindings === undefined) return ok(e);

  const step = (node: TypedExpr): Result<TypedExpr> => {
    if (node.op === 'sym') {
      const bound = bindings[node.name];
      return bound === undefined ? ok(node) : ok(bound);
    }
    return mapChildren(node, step);
  };
  const result = step(e);
  if (!result.ok) return result;
  // 치환된 심볼의 정의가 이미 중첩된 곱일 수 있다 (`D=AB` 를 `Dv` 에 꽂으면 그 자체가
  // matMul 안의 matMul이 된다) — 다른 변환들과 같은 이유로 여기도 정규화한다.
  return normalize(result.value);
}
