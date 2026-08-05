import { elaborate } from './parse/elaborate';
import { parse, simplify } from './index';
import { evalNumeric, matricesClose, type Assignment } from './numeric';
import { shape } from './types-shape';
import type { TypedExpr, Env } from './index';
import { parseSyntax } from './parse/parseSymbol';

/**
 * 테스트가 공유하는 심볼 환경과 파이프라인 헬퍼.
 *
 * 모양을 여기 한 곳에 모아두면 각 테스트가 "이 문자가 무엇인지"를 다시 설명하지 않아도 된다.
 * (`a`,`b`,`k`,`x`,`y` 처럼 여기 없는 문자는 **미정의 = 스칼라 가정**을 시험하는 자리다.)
 */
export const TEST_ENV: Env = {
  shapes: {
    u: shape(3, 1),
    v: shape(3, 1),
    w: shape(3, 1),
    r: shape(1, 3), // 행벡터
    p: shape(2, 1), // 길이가 다른 열벡터
    A: shape(3, 3),
    B: shape(3, 3),
    C: shape(3, 3),
    M: shape(2, 3), // 직사각
  },
};

/** LaTeX → Typed IR. 실패하면 던진다 (성공을 기대하는 자리에서만 쓴다). */
export function typedOf(latex: string, env: Env = TEST_ENV): TypedExpr {
  const syntax = parseSyntax(latex);
  if (!syntax.ok) throw new Error(`parse failed: ${syntax.errors[0].message}`);
  const typed = elaborate(syntax.value, env);
  if (!typed.ok) throw new Error(`elaborate failed: ${typed.errors[0].message}`);
  return typed.value;
}

/**
 * LaTeX → **정규화까지 끝난** Typed IR (elaborate + normalize, 공개 `parse()`와 동일).
 * `typedOf` 와 달리 평탄화·항등원 소거·정렬이 끝난 트리를 준다 — 소거 결과를 보는
 * 테스트는 이걸 써야 한다 (`typedOf` 만으로는 elaborate 직후 모습만 보인다).
 */
export function normalizedOf(latex: string, env: Env = TEST_ENV): TypedExpr {
  const r = parse(latex, env);
  if (!r.ok) throw new Error(`parse failed: ${r.errors[0].message}`);
  return r.value;
}

/**
 * LaTeX → **정리까지 끝난** Typed IR (`parse` + `simplify`).
 *
 * 거듭제곱 접기(`AA` → `A²`)와 역행렬 소거(`A^{-1}A` → `I`)를 보는 테스트는 이걸 써야
 * 한다. `normalize` 는 기본값이 `foldPowers=false` 라 **접지 않는다** — 사용자가 쓴 곱의
 * 모양을 임의로 바꾸지 않는다는 결정이고, `foldPowers=true` 로 부르는 건 `simplify` 뿐이다.
 */
export function simplifiedOf(latex: string, env: Env = TEST_ENV): TypedExpr {
  const r = simplify(normalizedOf(latex, env), env);
  if (!r.ok) throw new Error(`simplify failed: ${r.errors[0].message}`);
  return r.value;
}

/**
 * `TEST_ENV` 모양에 맞춘 구체적인 값. 수치 대조에 쓴다.
 *
 * **대칭 행렬도, 교환하는 행렬도 일부러 피했다** — `AB = BA` 인 값을 골라두면 교환법칙
 * 오적용 버그가 수치 대조를 그냥 통과해버린다. 대조가 잡아야 할 게 바로 그거다.
 */
export const TEST_VALUES: Assignment = {
  u: [[2], [-1], [4]],
  v: [[1], [3], [-2]],
  w: [[-3], [5], [1]],
  r: [[2, -4, 7]],
  p: [[3], [-5]],
  A: [
    [1, 2, -1],
    [0, -3, 4],
    [5, 1, 2],
  ],
  B: [
    [2, 0, 3],
    [-1, 4, 1],
    [6, -2, 0],
  ],
  C: [
    [-2, 1, 5],
    [3, 2, -4],
    [0, -1, 7],
  ],
  M: [
    [1, -2, 3],
    [4, 5, -6],
  ],
  a: [[3]],
  b: [[-2]],
  k: [[5]],
  x: [[1.5]],
  y: [[-0.5]],
};

/**
 * 두 식이 **같은 값**을 내는지 확인한다. 재작성이 값을 바꾸지 않았음을 보는 유일한
 * 자동 수단이라, 대조가 불가능한 경우(역행렬 등)는 통과가 아니라 **실패**로 본다.
 */
export function sameValue(left: TypedExpr, right: TypedExpr): true | string {
  const l = evalNumeric(left, TEST_VALUES);
  if (!l.ok) return `left not evaluable: ${l.errors[0].message}`;
  const r = evalNumeric(right, TEST_VALUES);
  if (!r.ok) return `right not evaluable: ${r.errors[0].message}`;
  return matricesClose(l.value, r.value)
    ? true
    : `values differ: ${JSON.stringify(l.value)} vs ${JSON.stringify(r.value)}`;
}
