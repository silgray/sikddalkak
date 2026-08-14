import { solve as ceSolve } from '@cortex-js/compute-engine';
import { getDefaultCeEngine } from '../ce/engine';
import { guardCe } from '../ce/budget';
import { elaborate } from '../parse/elaborate';
import { parseCeJson } from '../parse/parse';
import { isPureScalar } from './delegate';
import { render } from '../render';
import { fail, ok, type Result } from '../result/result';
import type { TypedExpr, Env } from '../expression/node';

/**
 * `e = 0` 을 `symbol` 에 대해 푼다. `e` 는 이미 `lhs - rhs` 로 접힌 식이다 — 등식 자체를
 * 아는 IR 노드가 없으므로(설계상 `=` 는 `cellGraph.ts` 층에만 있다) 여기서는 그냥
 * "이 식이 0" 이라는 스칼라 식 하나를 받는다.
 *
 * **수식이냐 수치냐를 우리가 가르지 않는다.** 호출자가 `substituteDeep` 로 정의된 심볼을
 * 먼저 다 먹인 뒤 이 함수를 부르면(`cellGraph.ts` 의 `computeRelationNode`), CE의 `solve`
 * 자유 함수가 알아서 남은 심볼로는 수식 해를, 전부 리터럴이면 수치 해를(필요하면 근 찾기로
 * 폴백) 낸다 — 실측(`ax-b=0` → `[Divide(b,a)]`, `x^5-x-1=0` → `[1.1673…]`).
 *
 * `viaCe`(`delegate.ts`)와 같은 규율을 따른다: `isPureScalar` 로 게이트, `render()` 로
 * LaTeX을 만들어 `{strict:true}` 로 넘기고, **MathJSON으로 받아 다시 읽는다**(CE 0.90의
 * `.latex` 직렬화 버그를 피한다, `delegate.ts` 문서 참고).
 *
 * ⚠ **CE 0.90 실측 함정**: `.d.ts` 는 `solve()` 가 `Expression`(순수 MathJSON) 배열을
 * 돌려준다고 적어놨지만, 실제로는 **`BoxedExpression` 인스턴스**를 준다(실측 — `typeof`
 * 로 찍어보면 내부 클래스 `e` 다). `parseCeJson` 에 그대로 넘기면 `translateToTree` 가
 * 숫자·심볼 어느 분기에도 안 걸려 `'Unsupported expression'` 으로 죽는다. `.json` 접근자로
 * 한 번 더 벗겨야 한다 — `delegate.ts` 의 `viaCe` 가 `result.json` 을 쓰는 것과 같은 이유
 * (`.d.ts` 를 믿지 말라는 CLAUDE.md 원칙이 여기서도 맞았다).
 *
 * **부분 성공을 허용하지 않는다** — 근 중 하나라도 못 읽으면 전체를 실패로 낸다. 일부만
 * 돌려주면 "답이 이게 다"로 보이는데, 실제로는 모자란 것이라 그게 더 나쁘다.
 */

/** `solve()` 가 주는 항목을 MathJSON으로 벗긴다 — 위 실측 함정 참고. */
function toMathJson(item: unknown): unknown {
  if (typeof item === 'object' && item !== null && 'json' in item) {
    return (item as { json: unknown }).json;
  }
  return item;
}
export function solveFor(e: TypedExpr, symbol: string, env: Env): Result<readonly TypedExpr[]> {
  if (!isPureScalar(e)) {
    return fail('unsupported', 'Can only solve scalar equations');
  }

  let raw: null | readonly unknown[];
  try {
    const source = render(e);
    const result = guardCe(getDefaultCeEngine(), 'solve', () =>
      ceSolve(`${source}=0`, symbol, { strict: true }),
    );
    // 미지수 하나만 넘겼으므로 근 배열만 받는다 — `Record<string, Expression>` 계열은
    // 연립방정식(여러 미지수) 응답이라 여기선 안 나와야 정상이다. 혹시 나오면(방어적으로)
    // 배열이 아니므로 곧장 "못 읽음"으로 떨어진다.
    raw = result === null || !Array.isArray(result) ? null : result;
  } catch {
    raw = null;
  }
  if (raw === null || raw.length === 0) {
    return fail('unsupported', `No solution for ${symbol}`);
  }

  const roots: TypedExpr[] = [];
  for (const item of raw) {
    const syntax = parseCeJson(toMathJson(item));
    if (!syntax.ok) return fail('unsupported', `Could not read a solution for ${symbol}`);
    const typed = elaborate(syntax.value, env);
    if (!typed.ok) return fail('unsupported', `Could not read a solution for ${symbol}`);
    roots.push(typed.value);
  }
  return ok(roots);
}
