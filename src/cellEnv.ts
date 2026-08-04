import { buildEnv, parse, type Env } from './algebra';
import { scanLatex } from './editor/latexScan';
import type { FormulaObject } from './types';

/**
 * 셀들 → `src/algebra` 의 심볼 환경.
 *
 * algebra는 **식 하나와 심볼 환경**만 안다 — 셀·문서·의존 그래프는 모른다는 게 그
 * 모듈의 경계다. 그래서 "셀에서 정의를 긁어 `Env` 를 만드는" 일은 여기, 모듈 바깥에 있다.
 * `src/engine/evaluate.ts` 가 쥐고 있던 그래프 층의 후계가 앉을 자리이기도 하다.
 *
 * 이 환경이 있어야 선택 변환이 `A` 가 행렬인지 스칼라인지 알 수 있다. 문맥 없는
 * `transformSelection` 이 `ABA` 를 `A²B` 로 만들던 게 이번 교체의 이유다.
 */

/**
 * `a = 3` 처럼 **최상위 `=` 의 좌변이 단일 심볼**이면 정의로 본다.
 * `x^2 = 4` 는 좌변이 식이므로 정의가 아니라 그냥 방정식이다.
 *
 * 최상위 판정에 `scanLatex` 를 쓰는 이유: `{...}` 안의 `=` 는 자식 토큰으로 내려가므로
 * 최상위 토큰 열만 훑으면 자연히 걸러진다. `=` 를 문자열에서 직접 찾으면
 * `\frac{a=1}{2}` 같은 걸 오인한다.
 */
function splitDefinition(latex: string): { name: string; rhs: string } | null {
  const doc = scanLatex(latex);
  const eq = doc.tokens.find((t) => t.kind === 'char' && t.text === '=');
  if (eq === undefined) return null;

  const lhs = latex.slice(0, eq.start).trim();
  const rhs = latex.slice(eq.end).trim();
  if (lhs === '' || rhs === '') return null;

  // "단일 심볼인가"는 algebra 자신에게 묻는다 — 정규식으로 흉내내면 `\alpha` 나 첨자
  // 붙은 이름에서 판정이 갈린다. 빈 환경으로 파싱해도 심볼 여부는 모양과 무관하다.
  const parsed = parse(lhs, { shapes: {} });
  if (!parsed.ok || parsed.value.op !== 'sym') return null;
  return { name: parsed.value.name, rhs };
}

/**
 * 셀 목록에서 정의를 모아 심볼 환경을 만든다.
 *
 * `mode`(symbolic/scoped)는 보지 않는다 — mode가 정하는 건 **치환 여부**이고, 여기서
 * 필요한 건 모양뿐이다. "A가 행렬"인 사실은 mode와 무관하게 참이다.
 *
 * 정의끼리 서로를 참조하는 경우(`B = A^T`)는 algebra의 `buildEnv` 가 고정점 반복으로
 * 푼다. 끝내 못 푼 것들(`unresolved`)은 이번 라운드에서는 버린다 — 진단을 UI에
 * 어떻게 드러낼지는 별건이다.
 */
export function buildCellEnv(objects: readonly FormulaObject[]): Env {
  const definitions: Record<string, string> = {};
  for (const object of objects) {
    const latex = object.latex.trim();
    if (latex === '') continue;
    const def = splitDefinition(latex);
    // 같은 이름을 두 번 정의하면 뒤엣것이 이긴다. 중복 정의는 평가기가 오류로 잡으므로
    // 여기서 또 판정하지 않는다 (모양 환경은 하나만 있으면 된다).
    if (def !== null) definitions[def.name] = def.rhs;
  }
  return buildEnv(definitions).env;
}
