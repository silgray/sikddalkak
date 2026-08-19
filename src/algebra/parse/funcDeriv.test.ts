import { describe, expect, it } from 'vitest';
import { parse, render } from '../index';
import { evaluate } from '../transform/evaluate';
import { formatSyntax } from '../debug';
import { parseSyntax } from './parse';
import { evalNumeric, matricesClose } from '../numeric';
import { TEST_VALUES } from '../testEnv';
import { rng, randomLatex } from '../transform/transform.fuzz.test';
import type { Env, FunctionDef, TypedExpr } from '../expression/node';

/**
 * `f'(a)` / `\frac{df}{dx}(a)` — **정의된 함수의 도함수**를 인수에서 값매김하는 표기
 * 전체 표. `prime.test.ts` 는 프라임(`f'(a)`) 하나만 다루고, 여기는 `\frac{df}{dx}`·
 * `\frac{\partial f}{\partial x}`·다변수 그래디언트까지 포함한 표기 전체를 다룬다.
 *
 * 뜻은 항상 "본문을 먼저 미분한 뒤 인수를 대입" 이다 — 합성함수 미분이 아니다
 * (`expression/node.ts` 의 `apply.deriv` 문서 참고). `f(z)=z^3` 로 확인:
 *   `f'(3y)` = `27y^2` (미분한 `3z^2` 에 `z:=3y`), `\frac{df}{dx}(y)` = `0`
 *   (본문에 `x` 가 없다), 인수 생략 `\frac{df}{dz}` = `3z^2` (매개변수 자기 자신).
 */

function fn(params: readonly string[], bodyLatex: string): FunctionDef {
  const syntax = parseSyntax(bodyLatex);
  if (!syntax.ok) throw new Error(`fn body parse failed: ${syntax.errors[0].message}`);
  return { params, body: syntax.value };
}

const ENV: Env = {
  shapes: {},
  functions: {
    f: fn(['z'], 'z^3'),
    g: fn(['x', 'y'], 'x^2y'),
  },
};

const evaluated = (latex: string, env: Env = ENV): string => {
  const parsed = parse(latex, env);
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.errors[0].message}`);
  const result = evaluate(parsed.value, env);
  if (!result.ok) throw new Error(`evaluate failed: ${result.errors[0].message}`);
  return render(result.value);
};

const syntaxOf = (latex: string): string => {
  const s = parseSyntax(latex);
  if (!s.ok) throw new Error(`parseSyntax failed: ${s.errors[0].message}`);
  return formatSyntax(s.value);
};

const parseFails = (latex: string, env: Env = ENV): string => {
  const r = parse(latex, env);
  if (r.ok) throw new Error(`expected failure, got ${render(r.value)}`);
  return r.errors[0].message;
};

describe('함수 도함수 — 결정표', () => {
  it.each([
    [String.raw`f'(3y)`, '27y^{2}'],
    [String.raw`\frac{df}{dz}(y)`, '3y^{2}'],
    [String.raw`\frac{df}{dx}(y)`, '0'],
    [String.raw`\frac{df}{dz}`, '3z^{2}'],
  ])('%s → %s', (input, expected) => {
    expect(evaluated(input)).toBe(expected);
  });

  it('다변수 함수 편미분', () => {
    expect(evaluated(String.raw`\frac{\partial g}{\partial x}(a,b)`)).toBe('2ab');
  });

  it('다변수 함수 그래디언트 — 모양 (1,2)', () => {
    expect(evaluated(String.raw`\frac{dg}{d(x,y)}(a,b)`)).toBe(
      String.raw`\begin{pmatrix}2ab&a^{2}\end{pmatrix}`,
    );
  });
});

describe(String.raw`\partial 와 \mathrm{d} 는 같은 트리`, () => {
  it.each([
    [String.raw`\frac{df}{dx}(y)`, String.raw`\frac{\partial f}{\partial x}(y)`],
    [String.raw`\frac{df}{dx}(y)`, String.raw`\frac{\mathrm{d}f}{\mathrm{d}x}(y)`],
    [String.raw`\frac{df}{dx}(y)`, String.raw`\frac{\differentialD f}{\differentialD x}(y)`],
  ])('%s ≡ %s', (a, b) => {
    expect(syntaxOf(a)).toBe(syntaxOf(b));
  });
});

describe('고차', () => {
  it(String.raw`\frac{d^2f}{dz^2}(y) — 2계`, () => {
    expect(evaluated(String.raw`\frac{d^2f}{dz^2}(y)`)).toBe('6y');
  });

  it(String.raw`f'''(y) 와 \frac{d^3f}{dz^3}(y) 는 같은 값`, () => {
    expect(evaluated(String.raw`f'''(y)`)).toBe(evaluated(String.raw`\frac{d^3f}{dz^3}(y)`));
  });
});

describe('렌더', () => {
  it('d-표기는 멱등이다', () => {
    const once = evaluated(String.raw`\frac{df}{dx}(y)`);
    expect(evaluated(once)).toBe(once);
  });

  it('그래디언트도 멱등이다', () => {
    const once = evaluated(String.raw`\frac{dg}{d(x,y)}(a,b)`);
    expect(evaluated(once)).toBe(once);
  });

  it("프라임은 d-표기로 렌더된다 (프라임 자체로는 안 나온다)", () => {
    expect(render(parseOk(String.raw`f'(y)`))).toBe(String.raw`\frac{\mathrm{d}f}{\mathrm{d}z}\left(y\right)`);
  });
});

function parseOk(latex: string) {
  const r = parse(latex, ENV);
  if (!r.ok) throw new Error(`parse failed: ${r.errors[0].message}`);
  return r.value;
}

describe('못 하는 것은 정직하게 거절한다', () => {
  it('다변수 함수엔 프라임을 못 쓴다', () => {
    expect(parseFails(String.raw`g'(1,2)`)).toContain('one-variable');
  });

  it('인수 개수가 안 맞으면 오류다', () => {
    expect(parseFails(String.raw`\frac{dg}{dx}(1)`)).toContain('argument');
  });

  it('인수가 행렬이면 오류다 — 미분 경로가 스칼라 전용이다', () => {
    const env: Env = {
      shapes: { A: { rows: 2, cols: 2 } },
      functions: ENV.functions,
    };
    expect(parseFails(String.raw`f'(A)`, env)).toContain('scalar');
  });
});

describe('무작위 인수 — f(z)=z^3 이니 f\'(e) 는 3e^2 과 항상 같은 값이어야 한다', () => {
  // `key.test.ts` 가 하는 것과 같은 재사용(`transform.fuzz.test.ts`의 `rng`/
  // `randomLatex`) — 표 테스트는 내가 생각해낸 인수만 보지만, 미분 후 대입 순서가
  // 어디선가 뒤집히면(합성함수 미분으로 새면) 특정 인수 모양에서만 값이 갈린다.
  // 닫힌 형(3z^2)을 알고 있으니 `evalNumeric` 으로 직접 대조할 수 있다 — `deriv`/
  // `apply` 는 평가기가 대조를 거절하므로(`numeric.ts`), 반드시 `evaluate()` 로 완전히
  // 펼친 뒤에 넘긴다.
  const SCALAR_LEAVES = ['a', 'b', 'k', 'x', 'y', '2', '3'];

  function evaluatedTyped(latex: string, env: Env): TypedExpr {
    const parsed = parse(latex, env);
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.errors[0].message}`);
    const result = evaluate(parsed.value, env);
    if (!result.ok) throw new Error(`evaluate failed: ${result.errors[0].message}`);
    return result.value;
  }

  const random = rng(0xf00d);
  const samples: string[] = [];
  for (let i = 0; samples.length < 40 && i < 400; i += 1) {
    samples.push(randomLatex(random, 1 + Math.floor(random() * 2), SCALAR_LEAVES));
  }

  it.each(samples)("f'(%s) ≈ 3(%s)^2", (argLatex) => {
    let prime: TypedExpr;
    let closedForm: TypedExpr;
    try {
      prime = evaluatedTyped(String.raw`f'(${argLatex})`, ENV);
      closedForm = evaluatedTyped(String.raw`3\left(${argLatex}\right)^{2}`, ENV);
    } catch {
      return; // 인수 자체가 이 문법에서 뜻이 없는 표본(거부 표집) — 조용히 건너뛴다.
    }
    const lhs = evalNumeric(prime, TEST_VALUES);
    const rhs = evalNumeric(closedForm, TEST_VALUES);
    if (!lhs.ok || !rhs.ok) return; // 값이 안 정해지는 표본(예: 무한대) — 역시 건너뛴다.
    if (lhs.value.some((row) => row.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e12))) return;
    expect(matricesClose(lhs.value, rhs.value)).toBe(true);
  });
});

describe('함수가 아니면 곱으로 남는다', () => {
  it(String.raw`\frac{da}{dx}(y) — a는 함수가 아니다 → 0\cdot y`, () => {
    // `a` 는 스칼라 심볼일 뿐 함수가 아니다 — `\frac{da}{dx}` 는 보통의 식 미분(=0)
    // 이고, 뒤따르는 `(y)` 는 `absorbDerivArgs` 가 후보로만 담아뒀던 것이라 곱으로
    // 강등된다(`elaborateApplyNode` 가 `f(x)` 를 함수가 아닐 때 곱으로 되돌리는 것과
    // 같은 규칙, `elaborate.ts` 의 `elaborateDiff` 문서 참고).
    expect(evaluated(String.raw`\frac{da}{dx}(y)`)).toBe('0');
  });
});
