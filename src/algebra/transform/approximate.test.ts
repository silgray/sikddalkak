import { describe, expect, it } from 'vitest';
import { render } from '../render';
import { normalizedOf } from '../testEnv';
import { approximate } from './approximate';
import type { Env } from '../expression/node';

/**
 * `approximate` — 정확값을 수치로 편다 (결과 행의 numeric 표시 모드).
 *
 * 배경: CE의 `.evaluate()` 는 정확값을 보존해서 `\ln(1/2)` 가 `-\ln(2)` 까지만 간다
 * (실측). 숫자를 보려면 `.N()` 이 필요하고, 그게 이 함수다.
 */

const ENV: Env = { shapes: {} };
const approx = (latex: string): string => {
  const r = approximate(normalizedOf(latex, ENV), ENV);
  if (!r.ok) throw new Error(`approximate failed: ${r.errors[0].message}`);
  return render(r.value);
};

/** 소수점 아래를 잘라 비교 — CE의 자릿수 재량에 테스트가 매달리지 않게. */
const startsWithNumber = (out: string, prefix: string) =>
  expect(out.startsWith(prefix), `${out} should start with ${prefix}`).toBe(true);

describe('approximate — 정확값을 수치로', () => {
  it('유리수', () => {
    startsWithNumber(approx(String.raw`\frac{1}{3}`), '0.333');
  });

  it('무리수 (정확값으로는 안 풀리던 것들)', () => {
    startsWithNumber(approx(String.raw`\sqrt{2}`), '1.414');
    startsWithNumber(approx(String.raw`\ln\left(2\right)`), '0.693');
    startsWithNumber(approx(String.raw`\cos\left(1\right)`), '0.540');
    startsWithNumber(approx(String.raw`\pi`), '3.14');
  });

  it('사용자 보고: 분수 인수를 받은 ln', () => {
    // `\ln(0.5)` 는 되는데 `\ln(1/2)` 는 `-\ln(2)` 로만 가던 그 자리.
    startsWithNumber(approx(String.raw`\ln\left(\frac{1}{2}\right)`), '-0.693');
  });

  it('복소수 결과도 편다', () => {
    // ln(1/2 + i√3/2) = iπ/3 — CE는 정확값을 못 내지만 수치로는 낸다.
    const out = approx(String.raw`\ln\left(\frac{1}{2}+\frac{i\sqrt{3}}{2}\right)`);
    expect(out).toContain('i');
    expect(out).not.toContain('\\ln');
  });

  it('이미 숫자면 그대로 둔다', () => {
    expect(approx('3')).toBe('3');
    expect(approx('0.5')).toBe('0.5');
  });
});

describe('approximate — 손대면 안 되는 것', () => {
  it('미지수가 남아 있으면 식을 유지한다', () => {
    // 자유 심볼이 있으면 수치로 풀 게 없다 — 오류가 아니라 그대로.
    expect(approx('x+1')).toContain('x');
  });

  it('행렬은 원소별로 편다', () => {
    const out = approx(String.raw`\begin{pmatrix}\frac{1}{2}&\frac{1}{4}\end{pmatrix}`);
    expect(out).toContain('0.5');
    expect(out).toContain('0.25');
  });

  it('실패해도 오류를 내지 않는다 (편의 기능)', () => {
    // 어떤 입력이든 결과 행을 오류로 만들지 않는다는 계약.
    for (const latex of ['x', 'A', String.raw`\frac{x}{y}`]) {
      const r = approximate(normalizedOf(latex, { shapes: {} }), { shapes: {} });
      expect(r.ok).toBe(true);
    }
  });
});
