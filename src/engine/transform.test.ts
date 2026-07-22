import { describe, expect, it } from 'vitest';
import { transformLatex } from './transform';

const norm = (s: string | null) => s?.replace(/\s+/g, '') ?? null;

describe('선택 변환', () => {
  it('전개한다', () => {
    expect(norm(transformLatex('(x+1)^2', 'expand'))).toBe('x^2+2x+1');
    expect(norm(transformLatex('(x+1)^3', 'expand'))).toBe('x^3+3x^2+3x+1');
  });

  it('정리한다', () => {
    expect(norm(transformLatex(String.raw`\frac{x^2-1}{x-1}`, 'simplify'))).toBe('x+1');
    expect(norm(transformLatex(String.raw`\sin^2 x+\cos^2 x`, 'simplify'))).toBe('1');
    expect(norm(transformLatex('2x+3x', 'simplify'))).toBe('5x');
  });

  it('전개할 게 없으면 입력을 그대로 돌려준다 (버튼 숨김 판정은 호출자 몫)', () => {
    expect(norm(transformLatex('5x', 'expand'))).toBe('5x');
  });

  it('불완전한 선택 조각은 null', () => {
    expect(transformLatex('x+', 'expand')).toBeNull();
    expect(transformLatex('x+', 'simplify')).toBeNull();
    expect(transformLatex('', 'expand')).toBeNull();
    expect(transformLatex('   ', 'simplify')).toBeNull();
  });

  it('평가하지 않는다 — 상수는 기호로 유지', () => {
    // 2\pi 를 6.28... 로 수치화하면 안 된다.
    expect(norm(transformLatex(String.raw`2\pi`, 'simplify'))).toBe(String.raw`2\pi`);
  });
});
