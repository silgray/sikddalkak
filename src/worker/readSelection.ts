import {
  expand,
  factor,
  parse,
  render,
  simplify,
  substitute,
  type Env,
  type TypedExpr,
} from '../algebra';
import { repairLatex } from '../editor/wellformed';
import { TRANSFORM_OPS, type SelectionInfo, type SelectionOp } from '../cellSelection';

/**
 * 선택 영역 변환의 실제 계산 — `algebra.worker.ts`(워커)와 `client.ts`(폴백)만 쓴다.
 *
 * **algebra 공개 API와 문자열만 다룬다** — React·DOM을 몰라야 워커 안에서도 그대로 돈다.
 * `Cell.tsx`(UI)는 이 파일을 직접 import하지 않는다 — `cellSelection.ts` 의 모양(타입·
 * 상수)만 보고, 계산은 `worker/client.ts` 의 `readSelectionAsync` 로 위임한다(그 파일
 * 머리 문서 참고 — 여기를 정적으로 끌어오면 CE가 메인 번들에도 딸려온다).
 *
 * **끼워 넣기(`joinSign`/`guardForSplice`)는 앱의 문제라 algebra가 아니라 여기 있다** —
 * 그 모듈은 주변 문맥을 모른다.
 */

const OPS: Record<SelectionOp, typeof simplify> = { expand, simplify, factor, substitute };

/**
 * 변환 결과를 주변 LaTeX에 끼워 넣을 수 있는 꼴로 만든다.
 *
 * `x^3+3x^2+3x+1` 에서 `+3x^2+3x` 를 선택해 변환하면 결과가 `3x(x+1)` 처럼 연산자 없이
 * 시작할 수 있다. 그대로 넣으면 앞의 `x^3` 과 붙어 곱셈이 돼버리므로, 선택이 부호로
 * 시작했다면 치환도 부호로 시작하게 한다. (선행 `-` 의 의미는 이미 파싱된 식에
 * 들어 있어서, 결과가 `-` 로 시작하지 않으면 `+` 합류가 수학적으로 옳다.)
 */
function joinSign(source: string, out: string): string {
  const needsJoin = source.startsWith('+') || source.startsWith('-');
  const startsWithSign = out.startsWith('+') || out.startsWith('-');
  return needsJoin && !startsWithSign ? `+${out}` : out;
}

/**
 * `render()`가 부모 없이 낸 꼴이 **그 자리에 도로 꽂아도 안전한가**를 대충 가른다.
 *
 * `replaceSelection`(`MathFieldHandle`)은 선택 지점 **바깥 문맥을 모르는 텍스트 접합**이다
 * — `render(out.value)`는 최상위로 렌더한 값이라 자기 문맥에서만 옳다. 원래 선택이
 * `c`처럼 안 감싸도 되던 원자였는데 치환 결과가 `b+1`처럼 느슨한 합이면, 감싸지 않고는
 * 못 끼워 넣는다: `cx`의 `c`만 `b+1`로 바꾸면 `b+1x`가 되어 `b+x`로 다시 읽힌다(실측 —
 * 곱 문맥에서 `1x`가 `x`로 붙어버린다).
 *
 * `render.ts`의 우선순위표(`ATOM > POW > MUL > DOTX > ADD`)를 흉내 낸다 — `num`/`sym`/
 * `matrix`/`matIdentity`/`frac`/`call`/`apply`(ATOM)와 `transpose`/`matPow`/`scalarPow`
 * (POW, 곱의 인수 자리에서 안전한 세기)만 안 감싸도 된다.
 */
const TIGHT_OPS = new Set<TypedExpr['op']>([
  'num', 'sym', 'matrix', 'matIdentity', 'frac', 'call', 'apply', 'transpose', 'matPow', 'scalarPow',
]);

/**
 * 원래 선택(`before`)이 이미 감싸지 않아도 됐던 자리인데, 치환 결과(`after`)가 더
 * 느슨한 꼴이면 감싼다. **원래 선택 자체가 이미 느슨한 꼴이었다면**(전체 셀을 고른
 * 경우 등) 감쌀 필요가 없다 — 그 문맥이 이미 그 느슨함을 받아들이고 있었다는 뜻이다.
 */
function guardForSplice(before: TypedExpr, after: TypedExpr, rendered: string): string {
  const wasTight = TIGHT_OPS.has(before.op);
  const stillTight = TIGHT_OPS.has(after.op);
  return wasTight && !stillTight ? `\\left(${rendered}\\right)` : rendered;
}

/**
 * 선택 조각을 **한 번만** 파싱하고, 그 Typed IR 위에서 네 변환을 각각 돌린다.
 * (구 엔진 경로는 op마다 CE 왕복을 따로 했다.)
 *
 * op 하나가 실패해도 나머지는 살린다 — factor는 못 해도 expand는 되는 식이 흔하다.
 */
export function readSelection(field: 'input' | 'result', selected: string, env: Env): SelectionInfo {
  const replacements: Partial<Record<SelectionOp, string>> = {};
  // 방어선 2: 선택 조각에 파손된 구조가 섞여 있어도 파싱은 되게.
  const raw = repairLatex(selected.trim()).latex;
  if (raw === '') return { field, latex: selected, replacements, solveSymbol: null, error: null };

  const parsed = parse(raw, env);
  if (!parsed.ok) {
    return {
      field,
      latex: selected,
      replacements,
      solveSymbol: null,
      error: parsed.errors[0].message,
    };
  }

  // substitute 필터용으로 미리 한 번.
  const parsedLatex = render(parsed.value);
  for (const op of TRANSFORM_OPS) {
    const out = OPS[op](parsed.value, env);
    if (!out.ok) continue;
    const replaced = render(out.value);
    // substitute는 정의된 심볼이 하나도 없으면 그냥 원래 값을 돌려줘서(=실패가 아니라
    // "바뀐 게 없음") 버튼이 늘 뜬다. expand/simplify/factor는 이 필터를 안 건다 —
    // 값은 같아도 꼴이 바뀌는 게 정상 동작이라, 여기에 걸면 사용자가 부탁한 변환이
    // 조용히 숨어버린다.
    if (op === 'substitute' && replaced === parsedLatex) continue;
    replacements[op] = joinSign(raw, guardForSplice(parsed.value, out.value, replaced));
  }
  // "단일 심볼을 선택했는가" — splitDefinition이 좌변을 판정하는 것과 같은 방식
  // (정규식으로 흉내내면 `\alpha`나 첨자 붙은 이름에서 갈린다).
  const solveSymbol = parsed.value.op === 'sym' ? parsed.value.name : null;
  return { field, latex: selected, replacements, solveSymbol, error: null };
}
