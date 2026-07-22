import { expand } from '@cortex-js/compute-engine';
import { ce } from './ce';

export type TransformOp = 'expand' | 'simplify';

/**
 * 선택한 부분식을 구문적으로 변환한다 (전개/정리).
 *
 * 평가(evaluate)는 하지 않는다 — 정의 치환도, 수치화도 없이 식 그 자체만
 * 바꾼다. 선택 변환은 "지금 보이는 이 조각을 다른 꼴로" 라는 국소적 조작이라
 * 문서 문맥(바인딩)을 끌어들이면 예측이 어려워진다.
 *
 * 선택이 완전한 식이 아니면(`x+` 같은 조각) null — 호출자는 조용히 무시한다.
 * expand는 CE 0.90에서 free function이다 ([[compute-engine-docs-unreliable]]).
 */
export function transformLatex(latex: string, op: TransformOp): string | null {
  const trimmed = latex.trim();
  if (trimmed === '') return null;
  try {
    const expr = ce.parse(trimmed);
    if (!expr.isValid) return null;
    const result = op === 'expand' ? expand(expr) : expr.simplify();
    return result.latex;
  } catch {
    return null;
  }
}
