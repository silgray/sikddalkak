import { describe, expect, it } from 'vitest';
import { parse, render } from '../index';
import { evaluate } from '../transform/evaluate';
import { formatSyntax } from '../debug';
import { parseSyntax } from './parse';
import type { Env, FunctionDef } from '../expression/node';

/**
 * `f'(x)` — 프라임 미분 표기 (정의된 일변수 함수 전용).
 *
 * CE는 `["Apply",["Derivative","f",n],arg]` 로 준다(실측). **본문을 먼저 미분한 뒤
 * 인수를 대입**한다는 뜻이다(`expression/node.ts` 의 `apply.deriv` 문서 참고) —
 * 합성함수 미분이 아니다. 그래서 `\frac{d}{dx}f(x)` 와는 **트리가 다르다**(전자는
 * "f'을 x에서 값매김", 후자는 "f(x) 라는 식을 x로 미분" — 값은 우연히 같을 때가
 * 많지만 뜻은 다르다, `funcDeriv.test.ts` 의 `\frac{df}{dx}(y)` vs 인수 없는
 * `\frac{df}{dz}` 대조 참고).
 */

function fn(params: readonly string[], bodyLatex: string): FunctionDef {
  const syntax = parseSyntax(bodyLatex);
  if (!syntax.ok) throw new Error(`fn body parse failed: ${syntax.errors[0].message}`);
  return { params, body: syntax.value };
}

const ENV: Env = {
  shapes: {},
  functions: {
    f: fn(['t'], 't^2'),
    g: fn(['t'], String.raw`\sin\left(t\right)`),
    h: fn(['t'], 't^3+t'),
  },
};

const evaluated = (latex: string): string => {
  const parsed = parse(latex, ENV);
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.errors[0].message}`);
  const result = evaluate(parsed.value, ENV);
  if (!result.ok) throw new Error(`evaluate failed: ${result.errors[0].message}`);
  return render(result.value);
};

const syntaxOf = (latex: string): string => {
  const s = parseSyntax(latex);
  if (!s.ok) throw new Error(`parseSyntax failed: ${s.errors[0].message}`);
  return formatSyntax(s.value);
};

describe("f'(x) — 값", () => {
  const CASES: readonly (readonly [string, string])[] = [
    [String.raw`f'(x)`, '2x'],
    [String.raw`f''(x)`, '2'],
    [String.raw`g'(y)`, String.raw`\cos\left(y\right)`],
    [String.raw`h'(x)`, '3x^{2}+1'],
    // 다른 식 안에 놓여도 잎처럼 자연스럽게 섞인다.
    [String.raw`2f'(x)`, '4x'],
    [String.raw`f'(x)+1`, '2x+1'],
    // 인수가 심볼이 아니어도 된다 — "미분한 뒤 대입" 이라 아무 식이나 받는다.
    [String.raw`f'(3)`, '6'],
    [String.raw`f'(3y)`, '6y'],
  ];

  it.each(CASES)('%s → %s', (input, expected) => {
    expect(evaluated(input)).toBe(expected);
  });

  it('3계 미분까지 센다', () => {
    expect(evaluated(String.raw`h'''(x)`)).toBe('6');
  });
});

describe("f'(x) — \\frac{d}{dx}f(x) 와 다른 트리, 그러나 같은 값", () => {
  // f(t)=t^2 처럼 f(x) 를 그대로 되돌려주는 함수라면 두 표기의 **값**은 같다 — 다만
  // "미분 후 대입" 과 "식을 미분" 은 서로 다른 연산이라 트리는 갈린다.
  it.each([
    [String.raw`f'(x)`, String.raw`\frac{d}{dx}f(x)`],
    [String.raw`g'(y)`, String.raw`\frac{d}{dy}g(y)`],
  ])('%s 와 %s 는 값이 같다', (prime, frac) => {
    expect(evaluated(prime)).toBe(evaluated(frac));
  });

  it(String.raw`f^{\prime}(x) 도 f'(x) 와 같은 트리다`, () => {
    expect(syntaxOf(String.raw`f^{\prime}(x)`)).toBe(syntaxOf(String.raw`f'(x)`));
  });

  it('렌더가 멱등이지는 않다 — 프라임은 d-표기로 렌더되고, 그건 다시 프라임으로 안 돌아간다', () => {
    // `render.ts` 는 `apply.deriv` 를 `\frac{df}{dx}(a)` 문체로 낸다(프라임 자체는 다시
    // 못 낸다 — 함수가 일변수인지부터 다시 따져야 해서 멱등을 보장 못 한다). 하지만
    // 그 d-표기를 다시 읽으면 같은 값이 나온다.
    const once = evaluated(String.raw`f'(x)`);
    expect(evaluated(once)).toBe(once);
  });
});

describe("f'(x) — 못 하는 것은 정직하게 거절한다", () => {
  it('다변수 함수엔 프라임을 못 쓴다', () => {
    const two: Env = { shapes: {}, functions: { p: fn(['a', 'b'], 'a^2+b') } };
    const r = parse(String.raw`p'(1,2)`, two);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].message).toContain('one-variable');
  });

  it('인수 개수가 안 맞으면 오류다', () => {
    const r = parse(String.raw`f'(1,2)`, ENV);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].message).toContain('argument');
  });

  it('정의되지 않은 함수는 미분할 수 없다', () => {
    // `q` 는 env에 없다 — 전개할 본문이 없으니 프라임 자체가 뜻이 없다.
    const r = parse(String.raw`q'(x)`, ENV);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].message).toContain('not a defined function');
  });
});
