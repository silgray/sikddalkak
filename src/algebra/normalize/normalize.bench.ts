import { bench, describe } from 'vitest';
import { normalize } from './normalize';
import { exprKey, sortScalars } from '../expression/key';
import { typedOf, TEST_ENV } from '../testEnv';
import type { TypedExpr } from '../expression/node';
import { buildNum } from '../expression/builders';
import { intLit } from '../literal/literal';

/**
 * 정규화 처리량 기준선.
 *
 * `key.ts:20` 의 "12000회 600ms→1040ms(1.7배)" 경고는 여태 주석으로만 남아 있었다 —
 * 숫자 없이 정렬을 "극단적으로 최적화" 할 수는 없으니 먼저 이걸 깐다.
 *
 * 코퍼스는 **정규화 전** 트리다(`typedOf` = parseSyntax + elaborate, normalize는 안 함).
 * `parse()` 를 쓰면 이미 정규화가 끝난 트리를 다시 정규화하는 셈이라 측정이 왜곡된다.
 *
 * `npm run bench` 로 돌린다.
 */

const CORPUS_LATEX = [
  // 중첩된 스칼라곱 — sortScalars가 매번 도는 자리
  'xyzabk',
  'x^2y^3z^4k^5',
  'xyzxyzxyz',
  // 긴 합 — sortTerms가 매번 도는 자리
  'a+b+k+x+y+xy+x^2+y^2+xyz+x^2y+xy^2+2x^3y+3xy^3+z^5+1',
  '-3+x^5+x^3y+xy^3+x^3z^3+y^3z^5+2x^3y+a+b+k',
  'x^3+y^3+3xy^2+3x^2y+z^3+3yz^2+3y^2z',
  // 행렬곱 중첩 — matMul은 정렬 안 하지만 스칼라 호이스팅은 돈다
  'ABCABCABC',
  '2A3B4C',
  'kABC+jACB',
  '(A+B)(A+B)(A+B)',
  // 내적/외적/전치 — 스칼라로 접히는 경로
  'v^Tw+r u',
  'u\\times v+v\\times w',
  '(A+I)3x(A+I)',
  // 거듭제곱 접기
  'AAAA+AA^{-1}A^{3}',
  'xxxx+xx^{-1}x^{3}',
  'x^{a}yx^{2a}',
  // 분수
  '\\frac{x^2+2x+1}{x+1}',
  '\\frac{1}{x}+\\frac{1}{y}+\\frac{1}{z}',
  // 섞인 큰 식 — 실제 사용자 입력에 가까운 크기
  '-3+x^5+x^3y+xy^3z^3+x^3z^3+y^3z^5+\\sin(x)+\\frac{1}{x}+2x^3y',
  '(aA(w^Tw)ABb)c+abdd(v^Tv)ABA',
  'x^4+4x^3+6x^2+4x+1',
];

const CORPUS: readonly TypedExpr[] = CORPUS_LATEX.map((latex) => typedOf(latex, TEST_ENV));

describe('normalize', () => {
  bench('전체 코퍼스', () => {
    for (const e of CORPUS) normalize(e, true);
  });
});

// ---------------------------------------------------------------------------
// sortScalars 마이크로벤치 — 길이별
// ---------------------------------------------------------------------------

const SYMS: readonly TypedExpr[] = ['z', 'y', 'x', 'w', 'v'].map((name) => ({
  op: 'sym',
  shape: { rows: 1, cols: 1 },
  name,
}));

describe('sortScalars', () => {
  bench('길이 1', () => {
    sortScalars(SYMS.slice(0, 1));
  });
  bench('길이 2', () => {
    sortScalars(SYMS.slice(0, 2));
  });
  bench('길이 5', () => {
    sortScalars(SYMS);
  });
});

// ---------------------------------------------------------------------------
// exprKey 마이크로벤치
// ---------------------------------------------------------------------------

const DEEP_EXPR: TypedExpr = CORPUS[CORPUS.length - 1];
const NUM_EXPR: TypedExpr = buildNum(intLit(42));

describe('exprKey', () => {
  bench('잎(숫자)', () => {
    exprKey(NUM_EXPR);
  });
  bench('큰 트리', () => {
    exprKey(DEEP_EXPR);
  });
});
