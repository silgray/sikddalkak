import { describe, expect, it } from 'vitest';
import { evaluate } from './evaluate';
import { render } from '../render';
import { sexpTyped } from '../debug';
import type { Env } from '../types-TypedExpr';
import { typedOf } from '../testEnv';

/**
 * `evaluate` 가 미분/적분/`\sum`/`\prod` 를 실제로 계산하는지 보는 표.
 * `transform/evaluate.test.ts` 와 같은 방식.
 */

const EMPTY_ENV: Env = { shapes: {} };

const evaluatedLatex = (latex: string, env: Env = EMPTY_ENV): string => {
  const result = evaluate(typedOf(latex, env), env);
  if (!result.ok) throw new Error(`evaluate failed: ${result.errors[0].message}`);
  return render(result.value);
};

/** 계산되지 않고 그대로 남았는지 — 연산 트리 종류만 확인한다(정확한 렌더는 안 본다). */
const evaluatedOp = (latex: string, env: Env = EMPTY_ENV): string => {
  const result = evaluate(typedOf(latex, env), env);
  if (!result.ok) throw new Error(`evaluate failed: ${result.errors[0].message}`);
  return sexpTyped(result.value).slice(1).split(' ')[0].split('(')[0] || sexpTyped(result.value);
};

describe('\\sum / \\prod — 상수 정수 상하한이면 전개한다', () => {
  it('스칼라 합', () => {
    expect(evaluatedLatex(String.raw`\sum_{k=1}^{3}\left(k^2\right)`)).toBe('14');
  });

  it('스칼라 곱', () => {
    expect(evaluatedLatex(String.raw`\prod_{k=1}^{4}\left(k\right)`)).toBe('24');
  });

  it('행렬 합 — 원소별', () => {
    expect(
      evaluatedLatex(
        String.raw`\sum_{k=1}^{2}\left(k\begin{pmatrix}1&0\\0&1\end{pmatrix}\right)`,
      ),
    ).toBe(String.raw`\begin{pmatrix}3&0\\0&3\end{pmatrix}`);
  });

  it('행렬 곱 — 비가환 순서를 지킨다 (왼쪽부터, 인덱스 증가 방향)', () => {
    // k=1: M, k=2: M+N. \prod = M(M+N) ≠ (M+N)M — 둘 다 계산해 값으로 구분되는 걸 확인한다.
    const M = String.raw`\begin{pmatrix}1&1\\0&1\end{pmatrix}`;
    const N = String.raw`\begin{pmatrix}1&0\\1&1\end{pmatrix}`;
    const latex = String.raw`\prod_{k=1}^{2}\left(${M}+(k-1)${N}\right)`;
    expect(evaluatedLatex(latex)).toBe(String.raw`\begin{pmatrix}3&3\\1&2\end{pmatrix}`);
  });

  it('상한이 기호면 미평가로 남는다', () => {
    expect(evaluatedOp(String.raw`\sum_{k=1}^{n}\left(k\right)`)).toBe('sum');
  });

  it('전개 상한을 넘으면 미평가로 남는다', () => {
    expect(evaluatedOp(String.raw`\sum_{k=1}^{100}\left(k\right)`)).toBe('sum');
  });

  it('중첩된 같은 이름 바인더는 섀도잉되어 올바르게 계산된다', () => {
    // 안쪽 \sum_k 는 바깥 k와 무관하게 매번 1+2=3 — 바깥에서 2번 더해 6.
    expect(
      evaluatedLatex(String.raw`\sum_{k=1}^{2}\left(\sum_{k=1}^{2}\left(k\right)\right)`),
    ).toBe('6');
  });
});

describe('미분 — 순수 스칼라는 CE로 계산한다', () => {
  it('다항식', () => {
    expect(evaluatedLatex(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}\left(x^2+3x\right)`)).toBe(
      '2x+3',
    );
  });

  it('삼각함수', () => {
    expect(evaluatedLatex(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}\left(\sin\left(x\right)\right)`)).toBe(
      String.raw`\cos\left(x\right)`,
    );
  });

  it('2계 미분 (order가 접혀 있어도)', () => {
    expect(
      evaluatedLatex(String.raw`\dfrac{\mathrm{d}^{2}}{\mathrm{d}x^{2}}\left(x^3\right)`),
    ).toBe('6x');
  });

  it('상수는 0', () => {
    expect(evaluatedLatex(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}\left(3\right)`)).toBe('0');
  });
});

describe('미분 — 행렬 본문은 원소별', () => {
  it('리터럴 행렬', () => {
    expect(
      evaluatedLatex(
        String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}\left(\begin{pmatrix}x^2&x\\1&x^3\end{pmatrix}\right)`,
      ),
    ).toBe(String.raw`\begin{pmatrix}2x&1\\0&3x^{2}\end{pmatrix}`);
  });

  it('기호 벡터는 성분을 몰라 미평가로 남는다', () => {
    expect(evaluatedOp(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}\left(v\right)`, {
      shapes: { v: { rows: 3, cols: 1 } },
    })).toBe('deriv');
  });
});

describe('다변수 미분 — 그래디언트/야코비안', () => {
  it('스칼라 본문 → 행벡터(그래디언트)', () => {
    expect(
      evaluatedLatex(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}(x,y)}\left(x^2y\right)`),
    ).toBe(String.raw`\begin{pmatrix}2xy&x^{2}\end{pmatrix}`);
  });

  it('열벡터 리터럴 본문 → 야코비안', () => {
    expect(
      evaluatedLatex(
        String.raw`\dfrac{\mathrm{d}}{\mathrm{d}(x,y)}\left(\begin{pmatrix}x^2\\xy\end{pmatrix}\right)`,
      ),
    ).toBe(String.raw`\begin{pmatrix}2x&0\\y&x\end{pmatrix}`);
  });
});

describe('적분 — 순수 스칼라는 CE로 계산한다', () => {
  it('부정적분', () => {
    expect(evaluatedLatex(String.raw`\int x^2\,\mathrm{d}x`)).toBe(String.raw`\frac{1}{3}x^{3}`);
  });

  it('정적분', () => {
    expect(evaluatedLatex(String.raw`\int_{0}^{1} x^2\,\mathrm{d}x`)).toBe(String.raw`\frac{1}{3}`);
  });

  it('삼각함수', () => {
    expect(evaluatedLatex(String.raw`\int \sin\left(x\right)\,\mathrm{d}x`)).toBe(
      String.raw`-\cos\left(x\right)`,
    );
  });
});

describe('적분 — 행렬 본문은 원소별', () => {
  it('리터럴 행렬', () => {
    expect(
      evaluatedLatex(
        String.raw`\int\left(\begin{pmatrix}x&1\\0&x^2\end{pmatrix}\right)\,\mathrm{d}x`,
      ),
    ).toBe(String.raw`\begin{pmatrix}\frac{1}{2}x^{2}&x\\0&\frac{1}{3}x^{3}\end{pmatrix}`);
  });
});
