import { describe, expect, it } from 'vitest';
import { evaluate } from './evaluate';
import { render } from '../render';
import { formatTyped } from '../debug';
import type { Env } from '../expression/node';
import { typedOf } from '../testEnv';
import { CE_BUDGET_MS } from '../ce/budget';

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
  return formatTyped(result.value).slice(1).split(' ')[0].split('(')[0] || formatTyped(result.value);
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

  it('d/dx 는 바로 다음 항에만 묶인다 — 뒤따르는 +를 안 삼킨다', () => {
    // d/dx(x) + x = 1 + x, 합 전체를 미분한 게 아니다.
    expect(evaluatedLatex(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}x+x`)).toBe('x+1');
    expect(evaluatedLatex(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}\left(x\right)+x`)).toBe(
      'x+1',
    );
    // 대조: 합 전체를 괄호로 감싸면 진짜로 합 전체가 미분된다.
    expect(evaluatedLatex(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}\left(x+x\right)`)).toBe('2');
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

  it('본문이 e 로 시작하는 곱이어도 괄호·공백 없이 렌더가 깨지지 않는다', () => {
    // e는 파싱 단계에서 곧장 ExponentialE 심볼이 되고, 그 LaTeX(`\exponentialE`)은
    // 글자로만 된 명령이라 뒤에 곧장 x가 오면 명령 이름을 먹어버렸었다(render.test.ts
    // 참고). CE로 렌더된 결과를 되읽는 이 evaluate 경로에서까지 안 깨지는지 확인한다.
    expect(evaluatedLatex(String.raw`\frac{d}{dx}ex`)).toBe(String.raw`\exponentialE`);
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

describe('적분 — CE가 안 끝나는 입력에도 돌아온다 (동작 핀)', () => {
  /**
   * 실측 회귀. CE 0.90의 `.evaluate()` 는
   * `\int_{-\pi}^{\pi}\frac{1}{2}e^{3x}\sin(2x)dx` (본문 정리 후의 모습)에서 **안 돌아온다**.
   * 지수 계수가 `1` 이면 111ms 만에 풀리는데 `3` 이면 멈추는 CE 쪽 버그라, 우리는
   * 시간 상한(`ce/budget.ts`)으로만 막을 수 있다. 상한이 걸리면 적분은 **미평가로 남는다** —
   * 접을 수 없으면 원래 노드를 돌려준다는 이 파일의 규약 그대로다.
   */
  it('e^{3x}sin/cos — 상한 안에 미평가로 돌아온다', () => {
    const latex = String.raw`\int_{-\pi}^{\pi}\cos\left(x\right)\sin\left(x\right)e^{3x}\,\mathrm{d}x`;
    const started = Date.now();
    expect(evaluatedOp(latex)).toBe('integral');
    expect(Date.now() - started).toBeLessThan(CE_BUDGET_MS * 3);
  });

  /** 같은 모양의 잘 풀리는 이웃은 여전히 값이 나와야 한다 — 상한이 과잉이 아니라는 확인. */
  it('e^{x}sin/cos — 이건 그대로 계산된다', () => {
    expect(
      evaluatedLatex(String.raw`\int_{-\pi}^{\pi}\cos\left(x\right)\sin\left(x\right)e^{x}\,\mathrm{d}x`),
    ).toBe(String.raw`\frac{1}{5}\exponentialE^{-\pi}-\frac{1}{5}\exponentialE^{\pi}`);
  });
});
