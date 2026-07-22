import { expand, factor } from '@cortex-js/compute-engine';
import type { MathJsonExpression } from '@cortex-js/compute-engine';
import { ce } from './ce';

export type TransformOp = 'expand' | 'simplify' | 'factor';

const norm = (s: string) => s.replace(/\s+/g, '');

/**
 * CE의 expand는 복소 계수 산술을 부동소수점 경로로 계산해서 부스러기를 남긴다.
 * 예: `(i\sin x+\cos x)^3` 전개 시 sin³ 계수가 정확히 -i가 아니라
 * `["Complex", -3.9e-21, -1]` 로 나온다 (i^3 단독 평가는 정확한데 expand 내부만 그렇다).
 *
 * 엔진이 스스로 "사실상 0"으로 정의하는 tolerance(기본 1e-10)를 기준으로
 * 숫자 리터럴을 잘라낸다 — Mathematica의 Chop과 같은 관행이다. 명시적 변환
 * 결과에만 적용하므로 평가(evaluate) 결과의 충실성에는 영향이 없다.
 */
function chopJson(json: MathJsonExpression): MathJsonExpression {
  if (typeof json === 'number') return ce.chop(json);
  if (Array.isArray(json)) {
    return json.map((item) => chopJson(item as MathJsonExpression)) as unknown as MathJsonExpression;
  }
  if (typeof json === 'object' && json !== null && 'num' in json) {
    const value = Number(json.num);
    if (Number.isFinite(value) && ce.chop(value) === 0) return 0;
  }
  return json;
}

/**
 * 선택한 부분식을 구문적으로 변환한다 (전개/정리/인수분해).
 *
 * 평가(evaluate)는 하지 않는다 — 정의 치환도, 수치화도 없이 식 그 자체만
 * 바꾼다. 선택 변환은 "지금 보이는 이 조각을 다른 꼴로" 라는 국소적 조작이라
 * 문서 문맥(바인딩)을 끌어들이면 예측이 어려워진다.
 *
 * 반환값은 선택 자리에 그대로 넣을 수 있는 치환 문자열이다. 다음 경우 null:
 *  - 선택이 완전한 식이 아니다 (`x+` 같은 조각)
 *  - 변환해도 실질적으로 달라지지 않는다. 판정 기준은 원문이 아니라 선택의
 *    **정규형**이다 — `+3x^2+3x` 를 파싱하면 단항 +가 사라져 문자열은 달라지지만
 *    그건 변환이 아니므로 버튼을 띄우면 안 된다. 항 재배열만 되는 경우도 같다.
 *
 * 합류 연산자: `x^3+3x^2+3x+1` 에서 `+3x^2+3x` 를 선택해 변환하면 치환 결과가
 * `3x(x+1)` 처럼 연산자 없이 시작할 수 있다. 그대로 넣으면 `x^3` 과 붙어
 * 곱셈(`x^3·3x(x+1)`)이 돼버리므로, 선택이 +/-로 시작했다면 치환도 부호로
 * 시작하도록 `+` 를 붙인다. (선행 `-` 의 의미는 파싱된 식에 이미 들어 있어서
 * 변환 결과가 `-` 로 시작하지 않으면 `+` 합류가 수학적으로 옳다.)
 *
 * expand/factor는 CE 0.90에서 free function이다 ([[compute-engine-docs-unreliable]]).
 */
export function transformSelection(selectedLatex: string, op: TransformOp): string | null {
  const raw = selectedLatex.trim();
  if (raw === '') return null;
  const needsJoin = raw.startsWith('+') || raw.startsWith('-');

  try {
    const expr = ce.parse(raw);
    if (!expr.isValid) return null;
    const baseline = expr.latex;
    const result =
      op === 'expand' ? expand(expr) : op === 'factor' ? factor(expr) : expr.simplify();
    // 부동소수점 부스러기를 자른 뒤 다시 박싱해 정규형 LaTeX을 얻는다.
    const out = ce.box(chopJson(result.json)).latex;
    if (norm(out) === norm(baseline)) return null;
    const startsWithSign = out.startsWith('+') || out.startsWith('-');
    return needsJoin && !startsWithSign ? `+${out}` : out;
  } catch {
    return null;
  }
}
