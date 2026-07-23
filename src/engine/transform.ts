import { expand, factor } from '@cortex-js/compute-engine';
import type { Expression, MathJsonExpression } from '@cortex-js/compute-engine';
import { ce } from './ce';
import {
  ORDER_PRESERVING_FORMS,
  jsonHasMatrix,
  preprocessVectorOps,
  reduceMatrixExpr,
} from './matrixPipeline';
import { sanitizeLatex } from '../editor/sanitizeLatex';

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

// ---------------------------------------------------------------------------
// 공통인자 추출 (factor 보강)
//
// CE 0.90의 factor는 단일 변수 다항식 지향이라 `tx^2+tx` 같은 다변수 공통인자도,
// `\cos x`(비다항 인수) 공통인자도 뽑지 못한다 (실측). 항을 (유리 계수 × 인수^지수
// 곱)으로 분해해 모든 항의 교집합을 직접 추출하고, 남은 몫에만 CE factor를 돌린다.
// ---------------------------------------------------------------------------

type TermParts = {
  /** 부호 포함 정수 분자. 정수로 못 읽는 계수는 인수 취급된다. */
  num: number;
  /** 양의 정수 분모. */
  den: number;
  /** 인수 키(JSON 직렬화) → { base, 지수 }. 지수는 양의 정수만 (그 외는 통째 인수). */
  factors: Map<string, { base: MathJsonExpression; exp: number }>;
};

const keyOf = (json: unknown) => JSON.stringify(json);

function gcdInt(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) [x, y] = [y, x % y];
  return x;
}

const asInt = (json: unknown): number | null => {
  const value =
    typeof json === 'number'
      ? json
      : typeof json === 'object' && json !== null && 'num' in json
        ? Number((json as { num: unknown }).num)
        : null;
  return value !== null && Number.isSafeInteger(value) ? value : null;
};

/** 곱 항 하나를 계수와 인수들로 분해한다. 모르는 조각은 통째로 인수가 된다. */
function parseTerm(term: MathJsonExpression): TermParts {
  const parts: TermParts = { num: 1, den: 1, factors: new Map() };
  const addFactor = (base: MathJsonExpression, exp: number) => {
    const key = keyOf(base);
    const existing = parts.factors.get(key);
    if (existing !== undefined) existing.exp += exp;
    else parts.factors.set(key, { base, exp });
  };
  const walk = (json: MathJsonExpression) => {
    const int = asInt(json);
    if (int !== null) {
      parts.num *= int;
      return;
    }
    if (Array.isArray(json)) {
      const [head] = json;
      if (head === 'Multiply') {
        for (const arg of json.slice(1)) walk(arg as MathJsonExpression);
        return;
      }
      if (head === 'Negate') {
        parts.num *= -1;
        walk(json[1] as MathJsonExpression);
        return;
      }
      if (head === 'Rational') {
        const n = asInt(json[1]);
        const d = asInt(json[2]);
        if (n !== null && d !== null && d !== 0) {
          parts.num *= n;
          parts.den *= Math.abs(d);
          if (d < 0) parts.num *= -1;
          return;
        }
      }
      if (head === 'Power') {
        const exp = asInt(json[2]);
        if (exp !== null && exp > 0) {
          addFactor(json[1] as MathJsonExpression, exp);
          return;
        }
      }
    }
    addFactor(json, 1);
  };
  walk(term);
  return parts;
}

/** TermParts를 다시 곱 JSON으로. 인수가 없고 계수가 1이면 1이 된다. */
function buildTerm(coefNum: number, coefDen: number, factors: MathJsonExpression[]): MathJsonExpression {
  const pieces: MathJsonExpression[] = [];
  if (coefDen !== 1) {
    pieces.push(['Rational', coefNum, coefDen] as unknown as MathJsonExpression);
  } else if (coefNum !== 1 || factors.length === 0) {
    pieces.push(coefNum);
  }
  pieces.push(...factors);
  if (pieces.length === 0) return 1;
  if (pieces.length === 1) return pieces[0];
  return ['Multiply', ...pieces] as unknown as MathJsonExpression;
}

const powerOf = (base: MathJsonExpression, exp: number): MathJsonExpression =>
  exp === 1 ? base : (['Power', base, exp] as unknown as MathJsonExpression);

/**
 * Add 식에서 모든 항의 공통인자(유리 계수 gcd + 공통 인수의 최소 지수)를 뽑는다.
 * 공통인자가 자명하면(±1, 인수 없음) null — 호출자가 CE factor로 폴백한다.
 * 몫의 합에는 CE factor를 한 번 더 시도한다 (`3x^2+3x` → `3x(x+1)` 유지).
 */
function factorCommon(expr: Expression): Expression | null {
  const json: unknown = expr.json;
  if (!Array.isArray(json) || json[0] !== 'Add' || json.length < 3) return null;
  const terms = json.slice(1).map((t) => parseTerm(t as MathJsonExpression));

  // 계수 공통부: gcd(분자들)/lcm(분모들), 전부 음수면 부호도 끌어낸다.
  if (terms.some((t) => t.num === 0)) return null;
  let g = 0;
  let lcm = 1;
  for (const t of terms) {
    g = gcdInt(g, t.num);
    const d = t.den;
    lcm = (lcm / gcdInt(lcm, d)) * d;
    if (!Number.isSafeInteger(lcm)) return null;
  }
  const sign = terms.every((t) => t.num < 0) ? -1 : 1;

  // 인수 공통부: 모든 항에 있는 base의 최소 지수.
  const common: { base: MathJsonExpression; exp: number }[] = [];
  for (const [key, { base, exp }] of terms[0].factors) {
    let minExp = exp;
    for (const t of terms.slice(1)) {
      const other = t.factors.get(key);
      if (other === undefined) {
        minExp = 0;
        break;
      }
      minExp = Math.min(minExp, other.exp);
    }
    if (minExp > 0) common.push({ base, exp: minExp });
  }

  const coefTrivial = g === lcm; // g/lcm === 1
  if (common.length === 0 && coefTrivial) return null;

  // 몫: 각 항을 공통부로 나눈다.
  const quotientTerms = terms.map((t) => {
    const coefNum = ((sign * t.num) / g) * (lcm / t.den);
    const rest: MathJsonExpression[] = [];
    for (const [key, { base, exp }] of t.factors) {
      const shared = common.find((c) => keyOf(c.base) === key);
      const remain = exp - (shared?.exp ?? 0);
      if (remain > 0) rest.push(powerOf(base, remain));
    }
    return buildTerm(coefNum, 1, rest);
  });
  const quotientSum = ce.box(['Add', ...quotientTerms] as unknown as MathJsonExpression);
  let quotient: MathJsonExpression = quotientSum.json;
  try {
    const refined = factor(quotientSum);
    if (refined.isValid) quotient = refined.json;
  } catch {
    // 몫이 CE factor가 못 다루는 모양이면 그대로 둔다.
  }

  const commonPieces: MathJsonExpression[] = common.map((c) => powerOf(c.base, c.exp));
  const coefJson = buildTerm(sign * g, lcm, []);
  const pieces =
    coefJson === 1 ? commonPieces : [coefJson, ...commonPieces];
  return ce.box(['Multiply', ...pieces, quotient] as unknown as MathJsonExpression);
}

/** factor 연산: 공통인자 추출을 먼저 시도하고, 없으면 CE factor 그대로. */
function factorOp(expr: Expression): Expression {
  return factorCommon(expr) ?? factor(expr);
}

/**
 * 행렬 리터럴이 관여하는 선택의 변환. 그래프 평가와 같은 파이프라인(축소
 * 정규화 파싱 → fold → evaluate)을 타서 곱셈 순서가 보존된다. expand/simplify
 * 모두 "계산해서 정리된 행렬"을 돌려주는 동작이고, factor는 의미가 없어 null.
 */
function transformMatrixSelection(raw: string, op: TransformOp): string | null {
  if (op === 'factor') return null;
  const expr = ce.parse(preprocessVectorOps(raw), { form: [...ORDER_PRESERVING_FORMS] });
  if (!expr.isValid) return null;
  const baseline = expr.latex;
  const out = ce.box(chopJson(reduceMatrixExpr(expr).json)).latex;
  if (norm(out) === norm(baseline)) return null;
  return out;
}

/**
 * 선택한 부분식을 구문적으로 변환한다 (전개/정리/인수분해).
 *
 * 평가(evaluate)는 하지 않는다 — 정의 치환도, 수치화도 없이 식 그 자체만
 * 바꾼다. 선택 변환은 "지금 보이는 이 조각을 다른 꼴로" 라는 국소적 조작이라
 * 문서 문맥(바인딩)을 끌어들이면 예측이 어려워진다.
 * (행렬 리터럴이 섞이면 예외 — 위 transformMatrixSelection이 계산 경로를 탄다.)
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
  // 방어선 2: 선택 조각에 고아 fence가 섞여 있어도 파싱은 되게.
  const raw = sanitizeLatex(selectedLatex.trim()).latex;
  if (raw === '') return null;
  const needsJoin = raw.startsWith('+') || raw.startsWith('-');

  try {
    const expr = ce.parse(raw);
    if (!expr.isValid) return null;
    if (jsonHasMatrix(expr.json)) {
      return transformMatrixSelection(raw, op);
    }
    const baseline = expr.latex;
    const result =
      op === 'expand' ? expand(expr) : op === 'factor' ? factorOp(expr) : expr.simplify();
    // 부동소수점 부스러기를 자른 뒤 다시 박싱해 정규형 LaTeX을 얻는다.
    const out = ce.box(chopJson(result.json)).latex;
    if (norm(out) === norm(baseline)) return null;
    const startsWithSign = out.startsWith('+') || out.startsWith('-');
    return needsJoin && !startsWithSign ? `+${out}` : out;
  } catch {
    return null;
  }
}
