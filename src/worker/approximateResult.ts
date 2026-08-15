import { approximate, parse, prettify, render, type Env } from '../algebra';
import { repairLatex } from '../editor/wellformed';

/**
 * 결과 행의 numeric 표시 모드 — 이미 계산된 결과 LaTeX을 수치로 편다.
 *
 * `readSelection.ts` 와 같은 규율이다: **algebra 공개 API와 문자열만 다룬다**(React·DOM을
 * 몰라야 워커 안에서 그대로 돈다), 그리고 못 펴면 **입력을 그대로 돌려준다** — 표시 모드는
 * 편의 기능이라 실패가 결과 행을 오류로 만들면 안 된다.
 *
 * 입력이 이미 `evaluate` 를 거친 결과라 자유 심볼이 남아 있어도 그대로 두면 된다
 * (`approximate` 가 알아서 그 부분만 안 건드린다).
 */
export function approximateResult(latex: string, env: Env): string {
  const raw = repairLatex(latex.trim()).latex;
  if (raw === '') return latex;

  const parsed = parse(raw, env);
  if (!parsed.ok) return latex;

  const approximated = approximate(parsed.value, env);
  if (!approximated.ok) return latex;

  return render(prettify(approximated.value));
}
