import { describe, expect, it } from 'vitest';
import { evaluate } from './evaluate';
import { render } from '../render';
import { parseSyntax } from '../parse/parseSymbol';
import { parse } from '../index';
import type { Env, FunctionDef } from '../types-TypedExpr';
import { typedOf } from '../testEnv';
import { shape } from '../shape/shape';

/**
 * `evaluate` 가 `apply`(사용자 정의 함수 호출)를 실제로 값으로 펴는지 보는 표.
 * `calculus.test.ts` 와 같은 방식 — 여기서는 함수 전개(`foldFunctions`)만 본다.
 */

/** `params` 매개변수, `bodyLatex` 본문으로 함수 정의를 만든다. */
function fn(params: readonly string[], bodyLatex: string): FunctionDef {
  const syntax = parseSyntax(bodyLatex);
  if (!syntax.ok) throw new Error(`fn body parse failed: ${syntax.errors[0].message}`);
  return { params, body: syntax.value };
}

const evaluatedLatex = (latex: string, env: Env): string => {
  const result = evaluate(typedOf(latex, env), env);
  if (!result.ok) throw new Error(`evaluate failed: ${result.errors[0].message}`);
  return render(result.value);
};

/** parse(elaborate 포함) 단계의 오류를 본다 — 인수 개수 불일치처럼 elaborate에서부터
 * 막히는 경우는 `evaluate` 까지 갈 필요가 없다. */
const parseError = (latex: string, env: Env): string => {
  const result = parse(latex, env);
  if (result.ok) throw new Error(`expected failure, got ${render(result.value)}`);
  return result.errors[0].message;
};

describe('숫자·식 인수', () => {
  const env: Env = { shapes: {}, functions: { f: fn(['x'], 'x^2') } };

  it('숫자 인수', () => {
    expect(evaluatedLatex('f(3)', env)).toBe('9');
  });

  it('식 인수 — 인수 자체가 먼저 값으로 확정된다', () => {
    expect(evaluatedLatex(String.raw`f\left(1+2\right)`, env)).toBe('9');
  });

  it('심볼 인수는 심볼인 채로 본문에 꽂힌다', () => {
    expect(evaluatedLatex('f(y)', { ...env, shapes: { y: shape(1, 1) } })).toBe(
      String.raw`y^{2}`,
    );
  });
});

describe('다중 인수', () => {
  it('f(x,y)=xy', () => {
    const env: Env = { shapes: {}, functions: { f: fn(['x', 'y'], 'xy') } };
    expect(evaluatedLatex('f(2,3)', env)).toBe('6');
  });
});

describe('중첩 호출', () => {
  it('f(g(x)) — 안쪽부터 전개된다', () => {
    const env: Env = {
      shapes: {},
      functions: { f: fn(['x'], 'x^2'), g: fn(['x'], 'x+1') },
    };
    expect(evaluatedLatex('f(g(2))', env)).toBe('9');
  });
});

describe('후위는 전개된 값을 감싼다', () => {
  it('f(x)^2', () => {
    const env: Env = { shapes: {}, functions: { f: fn(['x'], 'x+1') } };
    expect(evaluatedLatex('f(2)^2', env)).toBe('9');
  });
});

describe('미분·적분 본문 안의 함수 호출도 전개된다', () => {
  it(String.raw`\frac{d}{dx}f(x)`, () => {
    const env: Env = { shapes: {}, functions: { f: fn(['x'], 'x^2') } };
    expect(
      evaluatedLatex(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}\left(f\left(x\right)\right)`, env),
    ).toBe('2x');
  });
});

describe('행렬 인수 — 모양 다형이 값 전개에도 그대로 적용된다', () => {
  it('f(x)=x^2 에 정사각 행렬 리터럴을 넣으면 행렬 거듭제곱 값이 나온다', () => {
    const env: Env = { shapes: {}, functions: { f: fn(['x'], 'x^2') } };
    // [[1,0],[2,1]]^2 = [[1,0],[4,1]]
    expect(
      evaluatedLatex(String.raw`f\left(\begin{pmatrix}1&0\\2&1\end{pmatrix}\right)`, env),
    ).toBe(String.raw`\begin{pmatrix}1&0\\4&1\end{pmatrix}`);
  });
});

describe('실패해도 원래 노드를 그대로 돌려준다 (foldCalculus 와 같은 규약)', () => {
  it('인수 개수 불일치는 elaborate(parse) 단계에서부터 막힌다', () => {
    // env.functions에 정의는 있지만 호출 인수 개수가 안 맞는 경우 — apply 노드 자체가
    // 안 만들어지고 parse가 실패한다(elaborate.test.ts 에서 이미 다룬 경로).
    // 여기서는 그 오류가 evaluate까지 내려가지 않고 parse 시점에 이미 잡히는지만 본다.
    const env: Env = { shapes: {}, functions: { f: fn(['x', 'y'], 'x+y') } };
    expect(parseError('f(1)', env)).toContain('f expects 2 arguments');
  });
});
