import { ComputeEngine } from '@cortex-js/compute-engine';
import type { MathJsonExpression } from '@cortex-js/compute-engine';
import { fail, type Result } from '../result/result';
import { preprocess } from './preprocess';
import { translateToTree } from './translateToTree';
import type { SyntaxNode } from '../types-SyntaxNode';


/** 
 * parseSyntax:다음 2단계로 구성
 * 1. preprocess: latex -> latex
 * 2. translateToTree: ce MathJsonExpression -> SyntaxNode 번역
 *   - 아직 모양 분석 및 연산자 종류는 확정하지 않음(juxt/cdot/times로 놔둠)
 */

// ---------------------------------------------------------------------------
// CE 프런트엔드 — 그룹 보존 파싱
// ---------------------------------------------------------------------------


/**
 * 파싱 전용 CE 인스턴스. 앱 전역 인스턴스와 분리해 이 모듈이 자립하도록 둔다
 * (모듈은 셀·문서·앱을 모른다는 경계).
 */
const ce = new ComputeEngine();


/**
 * **괄호와 항·인수 순서를 함께 보존하는** 축소 정규화 형식 (전부 실측 근거).
 *  - `Flatten` 은 `\left(…\right)` 의 `Delimiter` 껍데기를 벗긴다 → 괄호 소실
 *  - `InvisibleOperator` 는 곱의 인수를 **재정렬**해 마커를 피연산자에서 떼어놓는다
 *    → "마커가 두 피연산자 사이"라는 전제가 깨진다
 *  - `Add` 는 **덧셈 항을 재정렬**한다 (`1+x` → `Add(x,1)`, `u·v+w` → `Add(w,…)`).
 *    의미는 같지만 사용자가 쓴 순서가 사라져 렌더가 원문과 달라진다.
 *  - `Power` 는 `A^{-1}` 을 `Divide(1,A)` 로 바꾼다 → **역행렬이 행렬 나눗셈이 되어버린다**
 *    (`A^{-2}` 는 그대로인데 `-1` 만 그러는 비대칭 동작).
 * 그래서 `Number` 만 남긴다. 남겨도 되는 이유: 숫자 리터럴 정규화(`Negate(1)` → `-1`)만
 * 하고 구조는 건드리지 않는다. 빼도 `\frac` 은 `Divide`/`Rational` 로, `x^2` 는 `Power` 로
 * 그대로 온다 (실측). `Add` 를 빼서 뺄셈이 `Subtract` 머리로 오는 것도 아래에서 받는다.
 */
const CE_PARSE_FORMS = ['Number'] as const;


/**
 * LaTeX -> Syntax IR.
 *
 * 모양은 보지 않는다. 여기서 결정되는 것은 **구조**(우선순위·그룹)와 **어느 곱 기호를
 * 썼는가**뿐이고, 그 기호가 무슨 연산인지는 elaborate가 모양과 함께 정한다.
 */
/**
 * CE MathJSON → Syntax IR. **CE에 넘겼던 식을 되받을 때 쓴다.**
 *
 * CE의 `.latex` 를 거치지 않는 이유: 0.90의 LaTeX 직렬화에 버그가 있다(실측).
 * `Power(Divide(X,a), 2)` 를 `\frac{1}{a}(X)^2` 로 내놓아 **지수의 적용 범위가 바뀐다**.
 * MathJSON 자체는 멀쩡하므로 그쪽을 받는 게 안전하고, 왕복도 한 번 줄어든다.
 */
export function parseCeJson(json: unknown): Result<SyntaxNode> {
  return translateToTree(json);
}

export function parseSyntax(latex: string): Result<SyntaxNode> {
  const trimmed = latex.trim();
  if (trimmed === '') return fail('malformed', 'Empty expression');
  let json: MathJsonExpression;
  try {
    const parsed = ce.parse(preprocess(trimmed), { form: [...CE_PARSE_FORMS] });
    if (!parsed.isValid) return fail('malformed', 'Could not parse the expression');
    json = parsed.json;
  } catch {
    return fail('malformed', 'Could not parse the expression');
  }
  return translateToTree(json);
}

/** 테스트·진단용. 프런트엔드가 무엇을 봤는지 확인할 때 쓴다. */
export function parseToCeJson(latex: string): unknown {
  return ce.parse(preprocess(latex.trim()), { form: [...CE_PARSE_FORMS] }).json;
}
