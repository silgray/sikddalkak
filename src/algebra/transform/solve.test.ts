import { describe, expect, it } from 'vitest';
import { render } from '../render';
import { solveFor } from './solve';
import { TEST_ENV, normalizedOf } from '../testEnv';

/**
 * `solveFor` 계약 테스트.
 *
 * `e` 는 이미 `lhs - rhs` 로 접힌 식이다(`cellGraph.ts` 의 `computeRelationNode` 가 만든다).
 * "수식이냐 수치냐"는 우리가 안 가른다 — CE의 `solve` 자유 함수가 남은 심볼에 따라
 * 알아서 고른다(`solve.ts` 문서의 실측 표 참고). 그래서 여기서는 **입력에 미정 심볼이
 * 남아 있는가**로 두 경로를 구분해 표본을 고른다.
 */

function roots(latex: string, symbol: string): readonly string[] {
  const e = normalizedOf(latex, TEST_ENV);
  const result = solveFor(e, symbol, TEST_ENV);
  if (!result.ok) throw new Error(`solve failed: ${result.errors[0].message}`);
  return result.value.map((r) => render(r));
}

describe('solveFor — 수식 해 (미정 심볼이 섞여 있으면)', () => {
  it('ax-b=0 → x=b/a', () => {
    expect(roots('ax-b', 'x')).toEqual([String.raw`\frac{b}{a}`]);
  });

  it('2x+1-7=0 → x=3 (계수는 리터럴, 답은 리터럴)', () => {
    expect(roots('2x+1-7', 'x')).toEqual(['3']);
  });
});

describe('solveFor — 다중근', () => {
  it('x^2-4=0 → x=2, x=-2', () => {
    expect(roots('x^2-4', 'x')).toEqual(['2', '-2']);
  });
});

describe('solveFor — 수치 폴백 (닫힌 형이 없으면)', () => {
  it('x^5-x-1=0 → 근 찾기로 떨어진다', () => {
    const [r] = roots('x^5-x-1', 'x');
    expect(Number(r)).toBeCloseTo(1.1673039782614187, 8);
  });
});

describe('solveFor — 근이 없으면 실패', () => {
  it('1-2=0 은 항상 거짓이다', () => {
    const e = normalizedOf('1-2', TEST_ENV);
    const result = solveFor(e, 'x', TEST_ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].code).toBe('unsupported');
  });
});

describe('solveFor — 비스칼라는 거부', () => {
  it('행렬/벡터가 얽힌 식은 CE로 새지 않는다', () => {
    // Av - u : (3,3)(3,1) - (3,1) = (3,1), 스칼라가 아니다.
    const e = normalizedOf('Av-u', TEST_ENV);
    const result = solveFor(e, 'x', TEST_ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe('unsupported');
      expect(result.errors[0].message).toMatch(/scalar/);
    }
  });
});
