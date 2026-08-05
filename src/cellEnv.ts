import { buildEnv, parse, type Env } from './algebra';
import { scanLatex } from './editor/latexScan';

/**
 * 셀들 → `src/algebra` 의 심볼 환경.
 *
 * algebra는 **식 하나와 심볼 환경**만 안다 — 셀·문서·의존 그래프는 모른다는 게 그
 * 모듈의 경계다. 그래서 "셀에서 정의를 긁어 `Env` 를 만드는" 일은 여기, 모듈 바깥에 있다.
 *
 * 이 환경이 있어야 선택 변환이 `A` 가 행렬인지 스칼라인지 알 수 있다. 문맥 없는
 * `transformSelection` 이 `ABA` 를 `A²B` 로 만들던 게 이번 교체의 이유다.
 *
 * "셀 목록 → 정의 판정" 은 [`src/cellGraph.ts`](./cellGraph.ts) 도 쓴다(중복·순환
 * 판정 후 유효한 정의만 골라 여기로 넘긴다) — 판정이 두 벌이 되면 어긋나므로
 * `splitDefinition` 을 여기서 export하고 그래프 층이 재사용한다.
 */

/**
 * `a = 3` 처럼 **최상위 `=` 의 좌변이 단일 심볼**이면 정의로 본다.
 * `x^2 = 4` 는 좌변이 식이므로 정의가 아니라 그냥 방정식이다.
 *
 * 최상위 판정에 `scanLatex` 를 쓰는 이유: `{...}` 안의 `=` 는 자식 토큰으로 내려가므로
 * 최상위 토큰 열만 훑으면 자연히 걸러진다. `=` 를 문자열에서 직접 찾으면
 * `\frac{a=1}{2}` 같은 걸 오인한다.
 */
export function splitDefinition(latex: string): { name: string; rhs: string } | null {
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
 * 정의 레코드(이름 → 우변 LaTeX)로 심볼 환경을 만든다. `buildEnv` 의 얇은 재노출이다 —
 * 정의끼리 서로를 참조하는 경우(`B = A^T`)는 그쪽이 고정점 반복으로 푼다.
 *
 * 셀 목록에서 이 레코드를 만드는 일(중복·순환 제외)은 `cellGraph.ts` 가 한다 — 여기서는
 * 안 한다. 이 함수 자체는 "유효한 정의가 이미 걸러진 뒤"만 상대한다.
 */
export function buildCellEnv(definitions: Readonly<Record<string, string>>): Env {
  return buildEnv(definitions).env;
}
