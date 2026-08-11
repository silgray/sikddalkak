import { describe, expect, it } from 'vitest';
import { render } from './render';
import { simplify } from './index';
import { formatTyped } from './debug';
import { normalizedOf, TEST_ENV } from './testEnv';
import { parseSyntax } from './parse/parse';
import { evalNumeric } from './numeric';

/**
 * 복소수 리터럴 테스트.
 *
 * ⚠ **여기가 복소수의 유일한 안전망이다.** 퍼즈는 복소수를 못 본다 — 생성기가 `i` 를
 * 만들지 않고, `numeric.ts` 의 `Matrix`(number[][])가 허수부를 담지 못해 값 대조도
 * 불가능하다. 그래서 표 테스트로 못박는다.
 */

const simplified = (latex: string): string => {
  const r = simplify(normalizedOf(latex), TEST_ENV);
  if (!r.ok) throw new Error(`simplify failed: ${r.errors[0].message}`);
  return render(r.value);
};

const parsed = (latex: string): string => render(normalizedOf(latex));

describe('파싱 — i 가 심볼로 새지 않는다', () => {
  it('허수 단위는 숫자 리터럴이지 변수가 아니다', () => {
    // 심볼로 새면 "i 라는 미지수" 가 되어 조용한 오답이 된다.
    expect(formatTyped(normalizedOf('i'))).toBe('c(0,1)');
    // 계수는 곱에서 접히고(`4·i` → `c(0,4)`), 동류항 합치기가 실수부까지 묶는다.
    expect(formatTyped(normalizedOf('3+4i'))).toBe('c(3,4)');
    expect(formatTyped(normalizedOf('4i'))).toBe('c(0,4)');
  });

  it('실수부·허수부가 유리수여도 받는다', () => {
    // CE가 `Complex(0, Rational(1,2))` 를 준다(실측) — 재귀로 안 받으면 여기서 깨진다.
    const r = simplify(normalizedOf(String.raw`\frac{i}{2}`), TEST_ENV);
    expect(r.ok && formatTyped(r.value)).toBe('c(0,1/2)');
  });

  it('허수부가 0이면 실수로 무너진다', () => {
    expect(simplified('i-i')).toBe('0');
  });
});

describe('산술 — CE 위임', () => {
  it('i^2 = -1 이 계수 곱셈에서 떨어진다', () => {
    expect(simplified('ii')).toBe('-1');
    expect(simplified('i^2')).toBe('-1');
  });

  it('복소수 사칙연산', () => {
    expect(simplified(String.raw`\left(1+i\right)^2`)).toBe('2i');
    expect(simplified(String.raw`\left(3+4i\right)+\left(1-2i\right)`)).toBe('4+2i');
    expect(simplified(String.raw`\left(3+4i\right)\left(1-2i\right)`)).toBe('11-2i');
    expect(simplified(String.raw`\frac{1}{i}`)).toBe('-i');
  });

  it('복소수 계수도 동류항으로 합쳐진다', () => {
    expect(simplified('2iA+3iA')).toBe('5iA');
  });
});

describe('렌더 — 멱등이어야 한다', () => {
  // 퍼즈가 못 보는 자리라 손으로 박는다. `render -> parse -> render` 가 제자리여야 한다.
  for (const latex of ['i', '3+4i', '4iA', '-4i', '2-3i', String.raw`\frac{i}{2}`]) {
    it(`${latex} 는 왕복해도 같다`, () => {
      const once = parsed(latex);
      const twice = parsed(once);
      expect(twice, `via ${once}`).toBe(once);
    });
  }

  it('순허수는 곱처럼, 실수부가 있으면 덧셈처럼 묶인다', () => {
    // `4i` 는 곱이라 뒤에 인수가 붙어도 괄호가 필요 없지만, `3+4i` 는 덧셈이라 필요하다.
    expect(parsed('4iA')).toBe('4iA');
    expect(parsed(String.raw`\left(3+4i\right)A`)).toBe(String.raw`\left(3+4i\right)A`);
  });
});

describe('수치 대조는 복소수를 거절한다', () => {
  it('실수부만 몰래 쓰지 않는다', () => {
    // numeric.ts 는 Matrix(number[][]) 라 허수부를 담을 자리가 없다. 조용히 실수부만
    // 쓰면 퍼즈가 "값이 같다" 고 잘못 판정한다 — 정직하게 실패해야 표본이 버려진다.
    const r = evalNumeric(normalizedOf('4i'), {});
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors[0].code).toBe('unsupported');
  });
});

describe('파싱 실패는 정직하게', () => {
  it('계산 불능은 심볼이 아니라 오류다', () => {
    // `1/0` -> ComplexInfinity, `0/0` -> NaN. 심볼로 새면 "변수 NaN" 이 된다.
    const r = parseSyntax(String.raw`\frac{1}{0}`);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors[0].code).toBe('unsupported');
  });
});
