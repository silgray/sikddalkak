import { describe, expect, it } from 'vitest';
import { parse, render } from '../index';
import { evaluate } from '../transform/evaluate';
import { formatSyntax } from '../debug';
import { parseSyntax } from './parse';
import type { Env, FunctionDef } from '../expression/node';

/**
 * `f'(x)` — 프라임 미분 표기 (한 변수 함수 전용).
 *
 * CE는 `["Apply",["Derivative","f",n],arg]` 로 준다(실측). Syntax IR에 이미 `deriv` 와
 * `apply` 가 있어서 새 노드 없이 **`\frac{\mathrm{d}}{\mathrm{d}x}f(x)` 와 같은 트리로**
 * 내려놓는다 — 그래서 elaborate·evaluate·render가 이미 아는 길로 흘러간다.
 * 그 "같은 트리" 가 이 스위트의 핵심 계약이다.
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

const parseError = (latex: string): string => {
  const r = parse(latex, ENV);
  if (r.ok) throw new Error(`expected failure, got ${render(r.value)}`);
  return r.errors[0].message;
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
  ];

  it.each(CASES)('%s → %s', (input, expected) => {
    expect(evaluated(input)).toBe(expected);
  });

  it('3계 미분까지 센다', () => {
    expect(evaluated(String.raw`h'''(x)`)).toBe('6');
  });
});

describe("f'(x) — \\frac{d}{dx}f(x) 와 같은 트리", () => {
  // 새 노드를 만들지 않았다는 게 요점이다. 트리가 같으니 뒤 단계는 전부 공짜다.
  it.each([
    [String.raw`f'(x)`, String.raw`\frac{d}{dx}f(x)`],
    [String.raw`g'(y)`, String.raw`\frac{d}{dy}g(y)`],
  ])('%s ≡ %s', (prime, frac) => {
    expect(syntaxOf(prime)).toBe(syntaxOf(frac));
  });

  it(String.raw`f^{\prime}(x) 도 같은 트리다`, () => {
    expect(syntaxOf(String.raw`f^{\prime}(x)`)).toBe(syntaxOf(String.raw`f'(x)`));
  });

  it('렌더가 멱등이다', () => {
    const once = evaluated(String.raw`f'(x)`);
    expect(evaluated(once)).toBe(once);
  });
});

describe("f'(x) — 못 하는 것은 정직하게 거절한다", () => {
  it('인수가 변수가 아니면 오류다', () => {
    // `f'(2)` 는 "미분한 다음 2를 넣어라" 라서 같은 트리로 못 적는다 — 치환을 담을
    // Syntax 노드가 없다. 조용히 틀린 답을 내느니 거절한다.
    expect(parseError(String.raw`f'(2)`)).toContain('variable');
    expect(parseError(String.raw`f'(x+1)`)).toContain('variable');
  });

  it('정의되지 않은 함수는 미분할 수 없다', () => {
    // `q` 는 env에 없다 — 전개할 본문이 없으니 값이 안 나온다.
    const parsed = parse(String.raw`q'(x)`, ENV);
    if (parsed.ok) {
      const result = evaluate(parsed.value, ENV);
      // 실패하든, 못 편 채 그대로 남든 — 조용히 틀린 값을 내지만 않으면 된다.
      if (result.ok) expect(render(result.value)).toContain('q');
    }
  });
});
