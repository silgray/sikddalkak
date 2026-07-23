import { describe, expect, it } from 'vitest';
import { sanitizeLatex } from './sanitizeLatex';

describe('sanitizeLatex — 고아 fence 교정', () => {
  it('한쪽이 지워진 쌍을 평평한 낱개로 편다 (실측 시퀀스)', () => {
    // `)` 삭제 (backspace/del 공통 직렬화)
    expect(sanitizeLatex(String.raw`x\left(\right.`)).toEqual({
      latex: 'x(',
      changed: true,
      survivor: 'left',
    });
    expect(sanitizeLatex(String.raw`\left(a+b\right.`)).toEqual({
      latex: '(a+b',
      changed: true,
      survivor: 'left',
    });
    // `(` 삭제
    expect(sanitizeLatex(String.raw`x\left.\right)`)).toEqual({
      latex: 'x)',
      changed: true,
      survivor: 'right',
    });
    expect(sanitizeLatex(String.raw`\left.a+b\right)`)).toEqual({
      latex: 'a+b)',
      changed: true,
      survivor: 'right',
    });
  });

  it('양쪽 다 지워진 쌍은 통째로 사라진다', () => {
    expect(sanitizeLatex(String.raw`a\left.\right.b`).latex).toBe('ab');
  });

  it('정상 쌍과 fence 없는 식은 건드리지 않는다', () => {
    const ok = String.raw`\left(\sin\left(x\right)+\cos\left(x\right)\right)`;
    expect(sanitizeLatex(ok)).toEqual({ latex: ok, changed: false, survivor: null });
    expect(sanitizeLatex('x^2+1').changed).toBe(false);
    expect(sanitizeLatex('').changed).toBe(false);
  });

  it('중첩 속 고아 쌍만 골라 편다', () => {
    // 바깥 쌍은 정상, 안쪽 쌍의 )가 지워진 상태
    expect(sanitizeLatex(String.raw`\left(a+\left(b\right.\right)`).latex).toBe(
      String.raw`\left(a+(b\right)`,
    );
    // 분수 안의 고아 쌍
    expect(sanitizeLatex(String.raw`\frac{1}{\left(x\right.}`).latex).toBe(
      String.raw`\frac{1}{(x}`,
    );
  });

  it('다른 구분자 종류도 같은 규칙', () => {
    expect(sanitizeLatex(String.raw`\left[a\right.`).latex).toBe('[a');
    expect(sanitizeLatex(String.raw`\left\{a\right.`).latex).toBe(String.raw`\{a`);
    expect(sanitizeLatex(String.raw`\left|a\right.`).latex).toBe('|a');
    expect(sanitizeLatex(String.raw`\left.a\right\rbrace`).latex).toBe(String.raw`a\rbrace`);
  });

  it('사용자 재현 시나리오: (sinx+cosx) 뒤 빈 괄호쌍에서 한쪽 삭제', () => {
    const before = String.raw`\left(\sin\left(x\right)+\cos\left(x\right)\right)\left(\right.`;
    const out = sanitizeLatex(before);
    expect(out.latex).toBe(String.raw`\left(\sin\left(x\right)+\cos\left(x\right)\right)(`);
    expect(out.survivor).toBe('left');
  });
});
