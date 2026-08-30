import { buildEnv, parse, parseSyntax, type Env, type FunctionDef } from './algebra';
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
 * `splitDefinition`/`splitFunctionDefinition` 을 여기서 export하고 그래프 층이
 * 재사용한다. 변수 정의(`a=3`)와 함수 정의(`f(x)=x^2`)는 판정 함수가 갈라져 있다.
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
 * `f(x)=x^2`, `f(x,y)=x^2+y` 처럼 **최상위 `=` 의 좌변이 이름 뒤 괄호 인수열**이고
 * 그 인수가 **전부 맨 심볼**이면 함수 정의로 본다. `f(2)=3` 처럼 인수가 식이면
 * (매개변수가 아니라 값이므로) 정의가 아니다 — 관계식 경로로 떨어진다.
 *
 * `splitDefinition` 과 순서상 나란히 시도한다: 이건 좌변이 **단일 심볼**일 때, 이건
 * 좌변이 **함수 적용 모양**일 때다. 겹칠 일이 없다 — 단일 심볼은 `apply` 가 아니다.
 *
 * `parse`(elaborate까지)가 아니라 **`parseSyntax`(Syntax IR)로만** 판단한다 — `f(x)`
 * 가 함수 적용인지 곱인지는 `env.functions` 를 알아야 갈리는데, 지금 그걸 알아내려는
 * 게 이 함수의 목적이라 순환이다. Syntax 층은 env가 없어도 "이름 뒤 괄호"라는 모양만은
 * 안다(`apply` 노드, `parse/node.ts` 참고) — 그거면 충분하다.
 *
 * 매개변수 이름이 중복되면(`f(x,x)=...`) 정의로 인정하지 않는다 — 인스턴스화 때 뒤엣것이
 * 앞엣것을 조용히 덮어써 다른 인수를 준 호출이 같은 값으로 뭉개진다.
 */
export function splitFunctionDefinition(
  latex: string,
): { name: string; params: readonly string[]; rhs: string } | null {
  const doc = scanLatex(latex);
  const eq = doc.tokens.find((t) => t.kind === 'char' && t.text === '=');
  if (eq === undefined) return null;

  const lhs = latex.slice(0, eq.start).trim();
  const rhs = latex.slice(eq.end).trim();
  if (lhs === '' || rhs === '') return null;

  const syntax = parseSyntax(lhs);
  if (!syntax.ok || syntax.value.kind !== 'apply') return null;

  const params: string[] = [];
  for (const arg of syntax.value.args) {
    if (arg.kind !== 'sym') return null;
    params.push(arg.name);
  }
  if (new Set(params).size !== params.length) return null;

  return { name: syntax.value.name, params, rhs };
}

// `splitRelation` 은 여기 없다 — `scanLatex` 만 쓰고 algebra가 필요 없어서 잎 모듈
// `cellRelation.ts` 로 뗐다(그 파일 문서 참고). 재노출하지 않는다 — 한 판정에 두 진입로를
// 만들지 않는다.

/**
 * 정의 레코드(이름 → 우변 LaTeX)로 심볼 환경을 만든다. `buildEnv` 의 얇은 재노출이다 —
 * 정의끼리 서로를 참조하는 경우(`B = A^T`)는 그쪽이 고정점 반복으로 푼다.
 *
 * 함수 정의(`functions`)는 고정점 없이 그대로 얹는다 — 함수 자체는 모양이 없어서
 * (호출부마다 다시 정해진다) 풀어나갈 게 없다. 변수 정의가 함수를 호출하는 경우
 * (`w = f(v)`)는 `buildEnv` 가 고정점 안에서 이 `functions` 를 보고 푼다.
 *
 * 셀 목록에서 이 레코드들을 만드는 일(중복·순환·매개변수 이름 충돌 제외)은
 * `cellGraph.ts` 가 한다 — 여기서는 안 한다. 이 함수 자체는 "유효한 정의가 이미
 * 걸러진 뒤"만 상대한다.
 */
export function buildCellEnv(
  definitions: Readonly<Record<string, string>>,
  functions: Readonly<Record<string, FunctionDef>> = {},
): Env {
  return buildEnv(definitions, functions).env;
}
