import { describe, expect, it } from 'vitest';
import { evaluate, freeSymbols, substituteDeep } from './evaluate';
import { render } from './render';
import type { Env } from './elaborate';
import { shape } from './types-shape';
import { TEST_ENV, sameValue, typedOf } from './testEnv';
import { buildEnv } from './index';

/**
 * `evaluate` 계약 테스트.
 *
 * `src/engine/evaluate.test.ts` 의 **표현식 단위** 계약을 옮겨온다 — 그래프·캐시·
 * 정의 바인딩(셀 간 의존)은 다음 라운드(`src/cellGraph.ts`) 몫이라 여기 없다.
 */

const evaluatedLatex = (latex: string, env: Env = TEST_ENV): string => {
  const result = evaluate(typedOf(latex, env), env);
  if (!result.ok) throw new Error(`evaluate failed: ${result.errors[0].message}`);
  return render(result.value);
};

describe('구체 행렬 산술', () => {
  it('행렬 곱을 계산한다', () => {
    expect(
      evaluatedLatex(String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}\begin{pmatrix}5&6\\7&8\end{pmatrix}`, {
        shapes: {},
      }),
    ).toBe(String.raw`\begin{pmatrix}19&22\\43&50\end{pmatrix}`);
  });

  it('행렬 덧셈을 계산한다', () => {
    expect(
      evaluatedLatex(String.raw`\begin{pmatrix}1&2\end{pmatrix}+\begin{pmatrix}3&4\end{pmatrix}`, {
        shapes: {},
      }),
    ).toBe(String.raw`\begin{pmatrix}4&6\end{pmatrix}`);
  });

  it('행렬 거듭제곱을 계산한다', () => {
    expect(
      evaluatedLatex(String.raw`\begin{pmatrix}1&1\\0&1\end{pmatrix}^3`, { shapes: {} }),
    ).toBe(String.raw`\begin{pmatrix}1&3\\0&1\end{pmatrix}`);
  });

  it('전치를 계산한다', () => {
    expect(
      evaluatedLatex(String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}^T`, { shapes: {} }),
    ).toBe(String.raw`\begin{pmatrix}1&3\\2&4\end{pmatrix}`);
  });

  it('스칼라 배를 계산한다', () => {
    expect(evaluatedLatex(String.raw`3\begin{pmatrix}1&2\end{pmatrix}`, { shapes: {} })).toBe(
      String.raw`\begin{pmatrix}3&6\end{pmatrix}`,
    );
  });

  it('벡터 내적을 계산한다', () => {
    expect(
      evaluatedLatex(String.raw`\begin{pmatrix}1\\2\\3\end{pmatrix}\cdot\begin{pmatrix}4\\5\\6\end{pmatrix}`, {
        shapes: {},
      }),
    ).toBe('32');
  });

  it('벡터 외적을 계산한다 (e1×e2=e3)', () => {
    expect(
      evaluatedLatex(String.raw`\begin{pmatrix}1\\0\\0\end{pmatrix}\times\begin{pmatrix}0\\1\\0\end{pmatrix}`, {
        shapes: {},
      }),
    ).toBe(String.raw`\begin{pmatrix}0\\0\\1\end{pmatrix}`);
  });

  it('정확한 유리수를 보존한다 (부동소수로 안 뭉갠다)', () => {
    expect(
      evaluatedLatex(
        String.raw`\begin{pmatrix}\frac{1}{3}\end{pmatrix}+\begin{pmatrix}\frac{1}{3}\end{pmatrix}`,
        { shapes: {} },
      ),
    ).toBe(String.raw`\begin{pmatrix}\frac{2}{3}\end{pmatrix}`);
  });
});

describe('심볼이 섞이면 재배열 없이 그대로', () => {
  it('심볼 행렬의 곱은 접히지 않는다 (ABA ≠ A²B)', () => {
    expect(evaluatedLatex('ABA')).toBe('ABA');
  });

  it('행렬곱의 비가환성을 지킨다 (pq ≠ qp 상당)', () => {
    // p,q 둘 다 미정 → 스칼라 가정, 순서 안 바뀜만 확인
    expect(evaluatedLatex(String.raw`Ap-pA`, { shapes: { A: shape(2, 2) } })).not.toBe('0');
  });

  it('리터럴과 심볼 행렬이 섞인 곱은 리터럴끼리만 접힌다', () => {
    // A는 (2,2) 행렬 심볼이지만 리터럴이 아니다 — 곱할 리터럴 상대가 없으니 그대로 남는다.
    expect(
      evaluatedLatex(String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}A`, {
        shapes: { A: shape(2, 2) },
      }),
    ).toBe(String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}A`);
  });
});

describe('전치·내적 (모양 접기)', () => {
  it('v^Tv는 스칼라로 접힌 채 유지된다 (전치 곱 순서 보존 + 1×1 접기)', () => {
    const before = typedOf(String.raw`v^Tv`);
    const result = evaluate(before, TEST_ENV);
    if (!result.ok) throw new Error(result.errors[0].message);
    expect(sameValue(before, result.value)).toBe(true);
  });

  it('vv^T는 3×3 외적으로 유지된다', () => {
    const before = typedOf(String.raw`vv^T`);
    const result = evaluate(before, TEST_ENV);
    if (!result.ok) throw new Error(result.errors[0].message);
    expect(sameValue(before, result.value)).toBe(true);
  });
});

describe('역행렬', () => {
  it('구체 행렬의 역행렬을 정확한 유리수로 계산한다', () => {
    expect(
      evaluatedLatex(String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}^{-1}`, { shapes: {} }),
    ).toBe(String.raw`\begin{pmatrix}-2&1\\\frac{3}{2}&\frac{-1}{2}\end{pmatrix}`);
  });

  it('특이행렬이면 조용히 원래 식으로 남는다', () => {
    expect(
      evaluatedLatex(String.raw`\begin{pmatrix}1&2\\2&4\end{pmatrix}^{-1}`, { shapes: {} }),
    ).toBe(String.raw`\begin{pmatrix}1&2\\2&4\end{pmatrix}^{-1}`);
  });

  it('밑이 심볼이면(치환 전) 그대로 둔다', () => {
    expect(evaluatedLatex(String.raw`A^{-1}`, { shapes: { A: shape(2, 2) } })).toBe('A^{-1}');
  });

  it('치환 후 리터럴이 되면 역행렬이 값으로 나온다 (substituteDeep + evaluate)', () => {
    const built = buildEnv({ A: String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}` });
    expect(built.unresolved).toEqual([]);
    const sub = substituteDeep(typedOf('A^{-1}', built.env), built.env);
    if (!sub.ok) throw new Error(sub.errors[0].message);
    const result = evaluate(sub.value, built.env);
    if (!result.ok) throw new Error(result.errors[0].message);
    expect(render(result.value)).toBe(String.raw`\begin{pmatrix}-2&1\\\frac{3}{2}&\frac{-1}{2}\end{pmatrix}`);
  });
});

describe('값 대조 — 재작성 전후로 값이 안 바뀌는가', () => {
  it('행렬 조합식', () => {
    const before = typedOf(String.raw`A\left(B+C\right)`);
    const result = evaluate(before, TEST_ENV);
    if (!result.ok) throw new Error(result.errors[0].message);
    expect(sameValue(before, result.value)).toBe(true);
  });

  it('벡터 내적·외적 조합식 (스칼라 삼중곱)', () => {
    const before = typedOf(String.raw`u\cdot\left(v\times w\right)`);
    const result = evaluate(before, TEST_ENV);
    if (!result.ok) throw new Error(result.errors[0].message);
    expect(sameValue(before, result.value)).toBe(true);
  });
});

describe('오류 — 차원 불일치는 evaluate 전에 이미 잡힌다', () => {
  it('불일치 곱이 덧셈 안에 묻혀도 parse가 잡는다', () => {
    expect(() => typedOf(String.raw`A+Mp`)).toThrow();
  });
});

describe('freeSymbols', () => {
  it('식에 쓰인 심볼 이름을 정렬해 모은다', () => {
    expect(freeSymbols(typedOf('ABA'))).toEqual(['A', 'B']);
  });

  it('숫자·항등원만 있으면 빈 배열이다', () => {
    expect(freeSymbols(typedOf('3+4'))).toEqual([]);
  });
});

describe('substituteDeep — 전이 참조까지 끝까지 치환', () => {
  it('B = A^T 를 거쳐 Bv 가 A^Tv 로 풀린다', () => {
    const built = buildEnv({ A: String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`, B: 'A^T' });
    expect(built.unresolved).toEqual([]);
    const env = { ...built.env, shapes: { ...built.env.shapes, v: shape(2, 1) } };
    const sub = substituteDeep(typedOf('Bv', env), env);
    if (!sub.ok) throw new Error(sub.errors[0].message);
    // 한 단계만 하는 substitute라면 여기서 B가 안 풀려 남아있어야 하지만,
    // substituteDeep은 고정점까지 가므로 A까지 풀려 리터럴이 남는다.
    expect(render(sub.value)).toBe(String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}^Tv`);
  });
});
