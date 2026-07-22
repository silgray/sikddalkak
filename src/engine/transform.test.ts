import { describe, expect, it } from 'vitest';
import { transformSelection } from './transform';

const norm = (s: string | null) => s?.replace(/\s+/g, '') ?? null;

describe('선택 변환', () => {
  it('전개한다', () => {
    expect(norm(transformSelection('(x+1)^2', 'expand'))).toBe('x^2+2x+1');
    expect(norm(transformSelection('(x+1)^3', 'expand'))).toBe('x^3+3x^2+3x+1');
  });

  it('정리한다', () => {
    expect(norm(transformSelection(String.raw`\frac{x^2-1}{x-1}`, 'simplify'))).toBe('x+1');
    expect(norm(transformSelection(String.raw`\sin^2 x+\cos^2 x`, 'simplify'))).toBe('1');
    expect(norm(transformSelection('2x+3x', 'simplify'))).toBe('5x');
  });

  it('인수분해한다', () => {
    expect(norm(transformSelection('3x^2+3x', 'factor'))).toBe('3x(x+1)');
    expect(norm(transformSelection('x^2-1', 'factor'))).toBe('(x-1)(x+1)');
    expect(norm(transformSelection('x^2+2x+1', 'factor'))).toBe('(x+1)^2');
  });

  it('실질 변화가 없으면 null (버튼 숨김)', () => {
    expect(transformSelection('5x', 'expand')).toBeNull();
    expect(transformSelection('5x', 'factor')).toBeNull();
    expect(transformSelection('3x^2+3x', 'expand')).toBeNull();
  });

  it('정규화만 되는 건 변화가 아니다', () => {
    // 선행 단항 +가 사라지는 것: `+3x^2+3x` -> `3x^2+3x` 는 변환이 아니다.
    // 이걸 변화로 치면 버튼이 뜨고, 치환 시 +가 사라져 앞 항과 곱으로 붙어버린다.
    expect(transformSelection('+3x^2+3x', 'simplify')).toBeNull();
    // 항 재배열만 되는 것도 마찬가지.
    expect(transformSelection('1+x', 'simplify')).toBeNull();
    expect(transformSelection(String.raw`3+\sin(y)+\cos(y)`, 'simplify')).toBeNull();
  });

  it('선행 +로 시작한 선택은 치환도 +로 시작한다 (합류 연산자 보존)', () => {
    // x^3 + [+3x^2+3x] + 1 에서 치환이 3x(x+1)로 시작하면 x^3과 곱으로 붙는다.
    expect(norm(transformSelection('+3x^2+3x', 'factor'))).toBe('+3x(x+1)');
  });

  it('선행 -는 부호가 결과에 흡수되고, 필요하면 +를 붙인다', () => {
    // -3x^2+3x = 3x-3x^2 -> factor -> -3x(x-1): 이미 -로 시작 -> 그대로
    expect(norm(transformSelection('-3x^2+3x', 'factor'))).toBe('-3x(x-1)');
    // -x^2+2x^2 -> x^2: 부호 없이 시작 -> +x^2 로 합류
    expect(norm(transformSelection('-x^2+2x^2', 'simplify'))).toBe('+x^2');
  });

  it('불완전한 선택 조각은 null', () => {
    expect(transformSelection('x+', 'expand')).toBeNull();
    expect(transformSelection('', 'simplify')).toBeNull();
    expect(transformSelection('   ', 'factor')).toBeNull();
  });

  it('평가하지 않는다 — 상수는 기호로 유지', () => {
    // 2\pi 를 6.28... 로 수치화하면 안 된다. 변화 없음 -> null.
    expect(transformSelection(String.raw`2\pi`, 'simplify')).toBeNull();
  });
});
