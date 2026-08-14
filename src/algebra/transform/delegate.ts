import {
  expand as ceExpand,
  factor as ceFactor,
  simplify as ceSimplify,
} from '@cortex-js/compute-engine';
import { getDefaultCeEngine } from '../ce/engine';
import { guardCe } from '../ce/budget';
import { elaborate } from '../parse/elaborate';
import { parseCeJson } from '../parse/parse';
import { buildMulAll } from '../expression/builders';
import { sortScalars } from '../expression/key';
import { combineNumericScalars } from '../polynomial/combine';
import type { Polynomial } from '../polynomial/polynomial';
import { render } from '../render';
import { isScalar } from '../shape/shape';
import type { TypedExpr, Env } from '../expression/node';

/**
 * `call` 이름 중 CE에 절대 위임하지 않는 것들 — 전개는 `evaluate` 단계의
 * `foldBuiltins`(`transform/builtins.ts`) 에서만 한다는 요청 사항. `det`/`tr` 은 인수가
 * 행렬이라 아래 `isScalar(e.args)` 검사에서 이미 걸러지지만, `Re`/`Im`/`conjugate` 는
 * 인수가 스칼라(복소수)라 그 검사를 통과해버린다 — 그래서 이름으로 명시적으로 막는다.
 */
const EVALUATE_ONLY_BUILTINS = new Set(['det', 'tr', 'Re', 'Im', 'conjugate']);

/**
 * CE 위임 경계 — expand/simplify/factor 셋이 함께 쓰는 부분.
 *
 * **순수 스칼라 부분식은 CE에 위임한다**(설계 §7). 삼각항등식·유리식 정리처럼 우리가
 * 다시 만들 이유가 없는 것들이 거기 있다. 모양이 얽힌 식은 절대 CE에 넘기지 않는다 —
 * 거기가 교환법칙 오적용의 출처였다. 그 판정(`isPureScalar`)과 왕복(`viaCe`), 그리고
 * 다항식 계수만 골라 넘기는 `refineScalars` 가 여기 모여 있다.
 */

/**
 * 통째로 CE에 넘겨도 되는가 = **모양이 스칼라이고, 안에 모양을 다루는 연산이 하나도 없다.**
 *
 * 결과가 스칼라라는 것만으로는 부족하다. `v·w` 는 스칼라지만 안에 벡터가 있어서 CE에
 * 넘기면 벡터를 스칼라 곱으로 오해한다.
 */
export function isPureScalar(e: TypedExpr): boolean {
  if (!isScalar(e.shape)) return false;
  switch (e.op) {
    case 'num':
    case 'sym':
      return true;
    case 'matrix':
    case 'dot':
    case 'cross':
    case 'transpose':
    case 'matMul':
    case 'matPow':
      return false;
    // `mul` 은 `matrix` 필드가 비스칼라 모양이라 `e.shape` 도 늘 비스칼라다 — 위의
    // `isScalar(e.shape)` 관문에서 이미 걸러진다. 여기 있는 건 switch 완전성 때문이다.
    case 'mul':
      return false;
    case 'add':
      return e.terms.every(isPureScalar);
    case 'neg':
      return isPureScalar(e.operand);
    case 'scalarMul':
      return e.factors.every(isPureScalar);
    case 'scalarPow':
      return isPureScalar(e.base) && isPureScalar(e.exponent);
    case 'call':
      return !EVALUATE_ONLY_BUILTINS.has(e.name) && e.args.every(isPureScalar);
    case 'frac':
      return isPureScalar(e.numerator) && isPureScalar(e.denominator);
    // 미정 항등원은 `isScalar(e.shape)` 관문에서 대부분 걸러지지만(정사각 미정 크기는
    // 스칼라가 아니다), CE는 애초에 `I` 를 모른다 — 넘기면 그냥 미지 심볼로 읽어 무슨
    // 정리를 할지 알 수 없다. 절대 위임하지 않는다.
    case 'matIdentity':
      return false;
    // 넷 다 절대 CE에 통째로 위임하지 않는다 — CE는 이 연산들의 우리 도메인 규약
    // (바운드 변수, 임의 모양 원소별 계산, `\prod` 의 비가환 순서)을 전혀 모른다.
    case 'deriv':
    case 'sum':
    case 'prod':
    case 'integral':
      return false;
    // CE는 사용자 정의 함수를 전혀 모른다 — `f\left(x\right)` 를 통째로 넘기면 `f` 를
    // 미지 심볼로 읽어 곱으로 오해한다(`A(v)` 가 곱으로 읽히는 것과 같은 CE 실측 함정).
    // 전개는 `evaluate` 의 `foldFunctions` 몫이라 여기선 절대 위임하지 않는다.
    case 'apply':
      return false;
  }
}

type CeOp = 'expand' | 'simplify' | 'factor';

/**
 * 순수 스칼라 식을 CE에 넘겼다 받는다.
 *
 * **결과는 `.latex` 가 아니라 MathJSON으로 받는다.** CE 0.90의 LaTeX 직렬화에 버그가
 * 있어서 `Power(Divide(X,a), 2)` 를 `\frac{1}{a}(X)^2` 로 내놓는다 — 지수의 적용 범위가
 * 바뀌어 **값이 달라진다**(실측, 퍼즈가 잡음). MathJSON은 멀쩡하다.
 *
 * 왕복이 실패하면 **원래 식을 그대로 돌려준다**. CE가 우리가 못 읽는 머리를 내놓는 일이
 * 있는데, 그것 때문에 변환 전체가 실패하는 것보다 "안 바뀜"이 낫다.
 */
export function viaCe(e: TypedExpr, op: CeOp, env: Env): TypedExpr {
  try {
    // 0.90에서 expand/factor는 Expression의 메서드가 아니라 자유 함수다(.d.ts 확인).
    // 문자열 입력은 기본이 느슨한 AsciiMath 문법이라 `strict` 로 LaTeX 문법을 강제한다.
    const source = render(e);
    // 자유 함수는 우리 인스턴스가 아니라 CE의 **기본 엔진**에서 돈다 — 상한도 거기에
    // 걸어야 한다 (`ce/engine.ts` 의 `getDefaultCeEngine`).
    const result = guardCe(getDefaultCeEngine(), op, () =>
      op === 'expand'
        ? ceExpand(source, { strict: true })
        : op === 'factor'
          ? ceFactor(source, { strict: true })
          : ceSimplify(source, { strict: true }),
    );
    const syntax = parseCeJson(result.json);
    if (!syntax.ok) return e;
    const typed = elaborate(syntax.value, env);
    if (!typed.ok || !isScalar(typed.value.shape)) return e;
    return typed.value;
  } catch {
    return e;
  }
}

/**
 * 다항식 안의 **스칼라 계수만** CE로 넘긴다. 비스칼라 인수 열은 건드리지 않는다.
 * CE가 돌려준 숫자는 곧바로 수치 계수로 흡수한다 (`3^2` → `9` → 계수에 곱해짐).
 *
 * `fold` 는 순수 스칼라 인수들을 **하나로 묶어** 넘길지 정한다.
 *  - `true` (expand/simplify): `A·A` 가 `A²` 로 접힌다. 하나씩 넘기면 안 접힌다.
 *  - `false` (factor): 묶어버리면 `abA + acB` 에서 공통 인수 `a` 가 블록 안에 갇혀
 *    추출되지 않는다. 인수분해할 때는 흩어진 채로 두는 게 맞다.
 */
export function refineScalars(p: Polynomial, op: CeOp, env: Env, fold: boolean): Polynomial {
  return combineNumericScalars(
    p.map((m) => {
      if (m.scalars.length === 0) return m;
      const refined = m.scalars.map((s) => (isPureScalar(s) ? viaCe(s, op, env) : s));
      if (!fold) return { ...m, scalars: sortScalars(refined) };

      // 내적처럼 모양이 얽힌 스칼라는 CE에 넘길 수 없으니 따로 둔다.
      const pure = refined.filter(isPureScalar);
      const rest = refined.filter((s) => !isPureScalar(s));
      if (pure.length < 2) return { ...m, scalars: sortScalars(refined) };
      const merged = buildMulAll(pure);
      if (!merged.ok) return { ...m, scalars: sortScalars(refined) };
      return { ...m, scalars: sortScalars([viaCe(merged.value, op, env), ...rest]) };
    }),
  );
}
