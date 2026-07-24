import { forEachTokenList, scanLatex } from './latexScan';

export { RULES, findViolations, repairLatex } from './rules';
export type { StructureRule, Violation, RepairResult } from './rules';

/**
 * 정규형(well-formed) 파사드.
 *
 * 규칙 자체는 [rules.ts](rules.ts)에 데이터로 모여 있고, 여기서는 앱이 쓰는
 * 진입점만 노출한다 — 문서 교정(`repairLatex`), 감시(`findViolations`),
 * 그리고 교정 후 캐럿을 제자리에 두기 위한 `contentCount`.
 */

/**
 * "내용" 토큰 수 — 글자/숫자/연산자와 명령어. 구분자·중괄호·첨자 기호처럼
 * 구조만 나타내는 토큰은 세지 않는다.
 *
 * 교정으로 구조 토큰이 사라져도 캐럿을 **같은 내용 위치**에 되돌리기 위한
 * 기준이다 (MathLive 오프셋은 원자 인덱스라 문자열 splice와 직접 대응하지 않는다).
 */
export function contentCount(latex: string): number {
  let n = 0;
  forEachTokenList(scanLatex(latex), (tokens) => {
    for (const t of tokens) {
      if (t.kind === 'char' || t.kind === 'command') n += 1;
    }
  });
  return n;
}
