import { isPureScalar, refineScalars, viaCe } from './delegate';
import { mapChildren } from '../expression/traversal';
import { combineLikeTerms } from '../polynomial/combine';
import { fromPolynomial, toPolynomial } from '../polynomial/convert';
import type { Monomial } from '../polynomial/polynomial';
import { normalize } from '../normalize/normalize';
import { ONE as ONE_LIT } from '../literal/literal';
import { ok, type Result } from '../result/result';
import { isScalar } from '../shape/shape';
import type { TypedExpr, Env } from '../expression/node';

/**
 * 정리.
 *
 * expand와 달리 **괄호를 함부로 풀지 않는다.** 자식부터 정리한 뒤, 덧셈 노드에서만
 * 동류항을 합친다. 어떤 항을 합치려고 분배가 필요하면 그 항은 통째로 놔둔다 —
 * 사용자가 `\left(A+B\right)C` 라고 쓴 걸 정리랍시고 펼쳐놓지 않기 위해서다.
 *
 * 재귀는 `simplifyRaw` 안에서만 돌고, **normalize는 맨 바깥에서 한 번만** 건다 —
 * 재귀할 때마다 정규화하면 트리 깊이만큼 중복 작업이 쌓인다 (정규화 자체는 몇 번을
 * 걸어도 값은 안 바뀌지만, 굳이 반복할 이유가 없다).
 *
 * **`foldPowers=true`** — simplify는 이웃한 같은 인수를 `matPow` 로 접는다
 * (`AAAA` → `A⁴`) 그리고 역행렬을 소거한다(`AA^{-1}` → `I`). "정리해 달라"는 요청에서
 * 자연스러운 기대이기 때문. parse/expand/factor/substitute는 안 그런다 —
 * 사용자가 쓴 곱의 모양을 임의로 바꾸지 않는다는 결정은 그대로다 (`normalize.ts` 참고).
 */
export function simplify(e: TypedExpr, env: Env): Result<TypedExpr> {
  const result = simplifyRaw(e, env);
  if (!result.ok) return result;
  return normalize(result.value, true);
}

function simplifyRaw(e: TypedExpr, env: Env): Result<TypedExpr> {
  if (isPureScalar(e)) return ok(viaCe(e, 'simplify', env));

  if (e.op === 'add') {
    const terms: TypedExpr[] = [];
    for (const term of e.terms) {
      const simplified = simplifyRaw(term, env);
      if (!simplified.ok) return simplified;
      terms.push(simplified.value);
    }
    const monomials: Monomial[] = [];
    for (const term of terms) {
      const p = toPolynomial(term);
      // 분배가 일어나는 항(= 단항식이 여러 개)은 펼치지 않고 통째로 하나의 인수로 둔다.
      if (p.ok && p.value.length === 1) {
        monomials.push(p.value[0]);
      } else {
        monomials.push(
          isScalar(term.shape)
            ? { coefficient: ONE_LIT, scalars: [term], nonScalars: [] }
            : { coefficient: ONE_LIT, scalars: [], nonScalars: [term] },
        );
      }
    }
    return fromPolynomial(
      combineLikeTerms(refineScalars(monomials, 'simplify', env, true)),
      e.shape,
    );
  }

  return mapChildren(e, (child) => simplifyRaw(child, env));
}
