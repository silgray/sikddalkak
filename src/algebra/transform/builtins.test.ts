import { describe, expect, it } from 'vitest';
import { evaluate } from './evaluate';
import { foldMatrices } from './matrixFold';
import { transform } from '../index';
import { render } from '../render';
import { typedOf, TEST_ENV } from '../testEnv';
import { shape, SCALAR } from '../shape/shape';
import type { Env, TypedExpr } from '../expression/node';

/**
 * `evaluate` 가 `det`/`tr`/`Re`/`Im`/`conjugate`(`call` 노드)를 값으로 펴는지 보는 표.
 * `functions.test.ts` 와 같은 방식 — 여기서는 `foldBuiltins` 만 본다.
 */

const evaluatedLatex = (latex: string, env: Env = { shapes: {} }): string => {
  const result = evaluate(typedOf(latex, env), env);
  if (!result.ok) throw new Error(`evaluate failed: ${result.errors[0].message}`);
  return render(result.value);
};

describe('det/tr — 리터럴 행렬', () => {
  it(String.raw`\det\begin{pmatrix}1&2\\3&4\end{pmatrix} = -2`, () => {
    expect(evaluatedLatex(String.raw`\det\begin{pmatrix}1&2\\3&4\end{pmatrix}`)).toBe('-2');
  });

  it(String.raw`\operatorname{tr}\begin{pmatrix}1&2\\3&4\end{pmatrix} = 5`, () => {
    expect(evaluatedLatex(String.raw`\operatorname{tr}\begin{pmatrix}1&2\\3&4\end{pmatrix}`)).toBe('5');
  });
});

describe('Re/Im/conjugate — 복소수 리터럴', () => {
  it(String.raw`\Re(3+4i) = 3`, () => {
    expect(evaluatedLatex(String.raw`\Re\left(3+4i\right)`)).toBe('3');
  });

  it(String.raw`\Im(3+4i) = 4`, () => {
    expect(evaluatedLatex(String.raw`\Im\left(3+4i\right)`)).toBe('4');
  });

  it(String.raw`\overline{3+4i} = 3-4i`, () => {
    expect(evaluatedLatex(String.raw`\overline{3+4i}`)).toBe('3-4i');
  });
});

describe('후위 켤레 — A^* (원소별) / A^\\dagger (켤레전치)', () => {
  const M = String.raw`\begin{pmatrix}1+2i&3\\4&5-6i\end{pmatrix}`;

  it('스칼라에 붙으면 켤레다', () => {
    expect(evaluatedLatex(String.raw`\left(3+4i\right)^*`)).toBe('3-4i');
    expect(evaluatedLatex(String.raw`\left(3+4i\right)^\dagger`)).toBe('3-4i');
  });

  it('행렬 A^* 는 원소별 켤레 — 자리는 그대로다', () => {
    expect(evaluatedLatex(`${M}^*`)).toBe(String.raw`\begin{pmatrix}1-2i&3\\4&5+6i\end{pmatrix}`);
  });

  it('행렬 A^\\dagger 는 켤레 + 전치 — 자리가 뒤집힌다', () => {
    expect(evaluatedLatex(`${M}^\\dagger`)).toBe(
      String.raw`\begin{pmatrix}1-2i&4\\3&5+6i\end{pmatrix}`,
    );
  });

  it('직사각 행렬의 dagger 는 모양이 뒤집힌다 (2x3 → 3x2)', () => {
    const wide = String.raw`\begin{pmatrix}1&2&3\\4&5&6\end{pmatrix}`;
    const typed = typedOf(`${wide}^\\dagger`);
    expect(typed.shape).toEqual(shape(3, 2));
  });

  it('conj 는 모양을 그대로 물려받는다 (2x3 → 2x3)', () => {
    const wide = String.raw`\begin{pmatrix}1&2&3\\4&5&6\end{pmatrix}`;
    const typed = typedOf(`${wide}^*`);
    expect(typed.shape).toEqual(shape(2, 3));
  });

  it('평가 전엔 안 접힌다 — 렌더도 후위 그대로 (멱등)', () => {
    const result = transform(String.raw`\left(3+4i\right)^*`, 'simplify', { shapes: {} });
    if (!result.ok) throw new Error(result.errors[0].message);
    expect(result.value).toBe(String.raw`\left(3+4i\right)^*`);
  });

  it('심볼 행렬은 접히지 않고 후위 표기로 남는다', () => {
    expect(evaluatedLatex('A^*', TEST_ENV)).toBe('A^*');
    expect(evaluatedLatex(String.raw`A^\dagger`, TEST_ENV)).toBe(String.raw`A^\dagger`);
  });

  it('foldMatrices 를 지나가도 dagger 의 모양이 뭉개지지 않는다 (회귀)', () => {
    // `matrixFold.ts` 의 `call` 케이스가 예전엔 `shape: SCALAR` 를 박아버렸다 —
    // `foldBuiltins` 가 곧바로 값으로 접어 대개 가려지지만, `evaluate` 가 fold
    // 시퀀스를 고정점까지 반복하면서 접히지 않은 `dagger` 노드(심볼 밑)를
    // `foldMatrices` 가 여러 번 다시 지나가게 됐다 — 그때마다 모양이 scalar 로
    // 굳으면 안 된다. `normalize.ts` 의 같은 케이스가 `shape: e.shape` 를 쓰는 것과
    // 맞춘 것이 이 테스트의 계약이다.
    const typed = typedOf(String.raw`A^\dagger`, TEST_ENV);
    const folded = foldMatrices(typed);
    if (!folded.ok) throw new Error(folded.errors[0].message);
    expect(folded.value.shape).toEqual(TEST_ENV.shapes.A);
  });
});

describe('matIdentity 인수 — 모양이 확정되면 직접 계산한다', () => {
  it('det(I_3) = 1', () => {
    const e: TypedExpr = {
      op: 'call',
      shape: SCALAR,
      name: 'det',
      args: [{ op: 'matIdentity', shape: shape(3, 3) }],
    };
    const result = evaluate(e, { shapes: {} });
    if (!result.ok) throw new Error(result.errors[0].message);
    expect(render(result.value)).toBe('1');
  });

  it('tr(I_3) = 3', () => {
    const e: TypedExpr = {
      op: 'call',
      shape: SCALAR,
      name: 'tr',
      args: [{ op: 'matIdentity', shape: shape(3, 3) }],
    };
    const result = evaluate(e, { shapes: {} });
    if (!result.ok) throw new Error(result.errors[0].message);
    expect(render(result.value)).toBe('3');
  });
});

describe('평가 전엔 안 접힌다 — expand/simplify/factor 는 CE에 위임하지 않는다', () => {
  it(String.raw`simplify(\Re(3+4i)) 는 그대로다`, () => {
    const result = transform(String.raw`\Re\left(3+4i\right)`, 'simplify', { shapes: {} });
    if (!result.ok) throw new Error(result.errors[0].message);
    expect(result.value).toBe(String.raw`\Re\left(3+4i\right)`);
  });

  it(String.raw`simplify(\det(A)) 는 그대로다`, () => {
    const result = transform(String.raw`\det(A)`, 'simplify', TEST_ENV);
    if (!result.ok) throw new Error(result.errors[0].message);
    expect(result.value).toBe(String.raw`\det\left(A\right)`);
  });
});

describe('동류항 — 정규화가 det/tr 을 원자로 다룬다', () => {
  it(String.raw`\det(A)+\det(A) = 2\det(A)`, () => {
    expect(evaluatedLatex(String.raw`\det(A)+\det(A)`, TEST_ENV)).toBe(
      String.raw`2\det\left(A\right)`,
    );
  });
});

describe('심볼 행렬은 CE의 안전한 무평가 결과를 그대로 받는다', () => {
  it('det(A) — 심볼 행렬은 접히지 않고 그대로 남는다', () => {
    expect(evaluatedLatex(String.raw`\det(A)`, TEST_ENV)).toBe(String.raw`\det\left(A\right)`);
  });
});
