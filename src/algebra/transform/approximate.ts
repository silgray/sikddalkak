import { elaborate } from '../parse/elaborate';
import { createEngine } from '../ce/engine';
import { guardCe } from '../ce/budget';
import { mapChildren } from '../expression/traversal';
import { parseCeJson } from '../parse/parse';
import { render } from '../render';
import { ok, type Result } from '../result/result';
import { isPureScalar } from './delegate';
import type { Env, TypedExpr } from '../expression/node';

/**
 * 정확값을 **수치로 편다** — `\frac{1}{3}` → `0.333…`, `\ln\left(2\right)` → `0.693…`.
 *
 * 왜 따로 필요한가: CE의 `.evaluate()` 는 **정확값을 보존한다**(실측). `\ln(1/2)` 는
 * `-\ln(2)` 까지만 가고 숫자가 되지 않으며, `\ln(0.5)` 가 숫자로 나오는 건 인수가 이미
 * 소수라서다. 그래서 이 앱의 결과 행은 일관되게 정확값이고, 숫자를 보려면 `.N()` 을
 * 따로 불러야 한다. 그 한 줄이 이 파일이다.
 *
 * **`evaluate` 파이프라인에 안 낀다.** 결과 행의 표시 모드(`numeric`/`symbolic`)가
 * 켜졌을 때만 그 위에 한 번 더 얹는다 — 정확값을 잃는 건 사용자가 고를 일이지
 * 계산이 마음대로 할 일이 아니다.
 *
 * ⚠ `numeric.ts`(모듈 최상위)와 이름이 비슷하지만 다른 물건이다. 그쪽은 재작성 전후
 * 값을 대조하는 **테스트용 평가기**고, 이쪽은 사용자에게 보여줄 LaTeX을 만든다.
 *
 * 통째로 넘길 수 있는 순수 스칼라(`delegate.ts` 의 `isPureScalar`)면 그대로 위임하고,
 * 아니면 자식으로 내려간다 — 행렬은 그렇게 원소별로 펴진다. 어느 단계든 실패하면
 * **원래 노드를 그대로 돌려준다**(`foldBuiltins` 와 같은 규율): 수치화는 편의 기능이라
 * 못 했다고 결과 행 전체를 오류로 만들 이유가 없다.
 */
/** 이 파일 전용 CE 인스턴스 (`ce/engine.ts` 참고). */
const ce = createEngine();

export function approximate(e: TypedExpr, env: Env): Result<TypedExpr> {
  // ⚠ `num` 이라고 다 건너뛰면 안 된다 — `\frac{1}{3}` 은 정규화가 **유리수 리터럴**로
  // 접어두므로(`normalize/frac.ts`) `frac` 노드가 아니라 `num` 으로 온다. 수치 모드가
  // 정작 가장 먼저 펴야 할 게 그거다. 이미 편 것(정수·소수)만 건너뛴다.
  if (e.op === 'num' && ALREADY_NUMERIC.has(e.value.kind)) return ok(e);
  if (isPureScalar(e)) return ok(viaCeNumeric(e, env));
  return mapChildren(e, (child) => approximate(child, env));
}

/** 더 펼 게 없는 리터럴 종류. 유리수·복소수는 빠져 있다 — 그게 펴야 할 것들이다. */
const ALREADY_NUMERIC: ReadonlySet<string> = new Set(['int', 'decimal']);

/**
 * `delegate.ts` 의 `viaCe` 와 같은 왕복이되 `.N()` 을 부른다.
 *
 * `.latex` 직렬화에 버그가 있어(CLAUDE.md의 CE 실측 함정) 결과는 **MathJSON으로**
 * 받는다. 문자열 입력은 기본이 느슨한 AsciiMath 문법이라 `strict` 로 LaTeX을 강제한다.
 */
function viaCeNumeric(e: TypedExpr, env: Env): TypedExpr {
  try {
    const result = guardCe(ce, 'approximate', () => ce.parse(render(e), { strict: true }).N());
    const syntax = parseCeJson(result.json);
    if (!syntax.ok) return e;
    const typed = elaborate(syntax.value, env);
    return typed.ok ? typed.value : e;
  } catch {
    return e;
  }
}
