import { describe, expect, it } from 'vitest';
import { sexpTyped } from './debug';
import { render } from './render';
import { TEST_ENV, typedOf } from './testEnv';
import { parseSyntax } from './parse/parseSymbol';
import type { Env, FunctionDef } from './types-TypedExpr';
import { shape } from './shape/shape';

/**
 * 렌더러의 계약은 **왕복**이다: 낸 LaTeX을 다시 읽으면 같은 연산 트리가 나와야 한다.
 * 괄호를 하나 빠뜨리면 `A(BC)` 가 `(AB)C` 로 다시 읽혀 비가환 순서가 조용히 바뀐다.
 */

/** LaTeX → Typed → LaTeX. */
const rendered = (latex: string): string => render(typedOf(latex, TEST_ENV));

/** 왕복이 연산 트리를 보존하는지. */
function expectRoundTrip(latex: string): void {
  const once = typedOf(latex, TEST_ENV);
  const out = render(once);
  const twice = typedOf(out, TEST_ENV);
  expect(sexpTyped(twice), `round-trip broke via ${out}`).toBe(sexpTyped(once));
}

describe('왕복 — 다시 읽으면 같은 연산 트리', () => {
  const cases = [
    'v^Tv',
    'v^TAv',
    'A^{-1}',
    'A^2',
    'ABC',
    String.raw`A\left(BC\right)`,
    String.raw`\left(AB\right)C`,
    String.raw`v\cdot w`,
    String.raw`v\times w`,
    String.raw`u\cdot v\cdot w`,
    String.raw`\left(u\times v\right)\times w`,
    String.raw`u\times\left(v\times w\right)`,
    String.raw`u\cdot\left(v\times w\right)`,
    String.raw`\left(v\cdot w\right)v\times A\left(v\times w\right)`,
    'A+B',
    'A-B',
    'A+B-C',
    String.raw`\left(A+B\right)C`,
    String.raw`C\left(A+B\right)`,
    'vv^T',
    'M^T',
    '2A',
    'a+b',
    'ab',
    String.raw`\frac{A}{a}`,
    String.raw`\sin a`,
    String.raw`\sqrt{a}`,
    'a^b',
    '-A',
    'A-BC',
    String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`,
    String.raw`\begin{pmatrix}1\\2\\3\end{pmatrix}`,
    String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}\left(x^2\right)`,
    String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}\left(v\right)`,
    String.raw`\dfrac{\mathrm{d}^{2}}{\mathrm{d}x^{2}}\left(x\right)`,
    String.raw`\dfrac{\mathrm{d}}{\mathrm{d}(x,y)}\left(f\right)`,
    String.raw`\dfrac{\mathrm{d}}{\mathrm{d}(x,y)}\left(v\right)`,
    String.raw`\sum_{k=1}^{n}\left(k\right)`,
    String.raw`\sum_{k}\left(k\right)`,
    String.raw`\prod_{k=1}^{n}\left(k\right)`,
    String.raw`\int_{0}^{1}\left(x^2\right)\mathrm{d}x`,
    String.raw`\int\left(x^2\right)\mathrm{d}x`,
    // 결합 범위 함정 — 곱/합 안에 낀 자리는 항상 추가로 감싸져야 왕복이 성립한다
    // (deriv/sum/prod/integral 은 CE가 뒤따르는 병치·덧셈 항을 삼키므로).
    String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}\left(x^2\right)+f`,
    String.raw`2\left(\sum_{k=1}^{n}\left(k\right)\right)`,
    String.raw`A\left(\sum_{k=1}^{n}\left(v\right)\right)`,
  ];

  for (const latex of cases) {
    it(latex, () => {
      expectRoundTrip(latex);
    });
  }
});

describe('apply 도입으로 생긴 재파싱 위험 (실측 회귀, 퍼즈가 잡음)', () => {
  it('맨 심볼이 좌결합 이웃과 묶인 채 자체 구분자 인수 앞에 서면 괄호로 보호한다', () => {
    // rv(sum) 을 그대로 다시 읽으면 v 가 sum 쪽으로 먼저 묶여(apply 후보) r 과의
    // 좌결합이 깨진다 — v(3,1)·sum(3,1) 은 안 되는데 (rv)(1,1)·sum 은 되므로 값 자체가
    // 못 나온다(예전엔 apply가 없어 항상 좌결합이라 문제가 없었다).
    expect(
      rendered(String.raw`\left(r\right)\left(v\right)\left(\sum_{k=1}^{3}\left(w\right)\right)`),
    ).toBe(String.raw`\left(rv\right)\left(\sum_{k=1}^{3}\left(w\right)\right)`);
    expectRoundTrip(
      String.raw`\left(r\right)\left(v\right)\left(\sum_{k=1}^{3}\left(w\right)\right)`,
    );
  });

  it('맨 앞(왼쪽에 아무것도 없는) 심볼은 감쌀 필요가 없다', () => {
    // A 는 이 곱의 첫 인수라 오른쪽으로 apply 후보가 돼도 값이 똑같다 — 과잉 괄호 방지.
    expect(rendered(String.raw`A\left(B+C\right)`)).toBe(String.raw`A\left(B+C\right)`);
  });

  it('명시적으로 한 번 더 감싼 후위는 apply 전체를 감싼다 (§3 규칙과 별개 경로)', () => {
    // `A(B)^T`(괄호 한 겹, 안 감쌈)와 `(A(B))^T`(괄호 두 겹, 명시적으로 감쌈)는
    // CE JSON부터 다르게 온다(실측) — 후자는 사용자가 후위 범위를 통째로 못박은
    // 것이므로, A가 함수가 아니면 (A·B) 전체가 전치돼야지 B만 전치되면 안 된다.
    expectRoundTrip(String.raw`\left(r\left(\sum_{k=1}^{3}\left(w\right)\right)\right)^3`);
    expect(
      rendered(String.raw`\left(A\left(B\right)\right)^T`),
    ).toBe(String.raw`\left(AB\right)^T`);
  });
});

describe('괄호는 필요한 곳에만', () => {
  it('좌결합 병치는 괄호가 없다', () => {
    expect(rendered('ABC')).toBe('ABC');
    expect(rendered(String.raw`\left(AB\right)C`)).toBe('ABC');
  });

  it('중첩된 matMul도 첫 인수 자리에서는 괄호가 안 붙는다', () => {
    // `(AB)C` 는 elaborate 단계에서 matMul(factors:[matMul(A,B), C]) 로 **중첩된 채**
    // 남는다 (평탄화는 `normalize` 의 몫 — 아직 없다). 그런데 중첩된 matMul이 맨 앞
    // 인수 자리에 오면 자신도 MUL 세기라 괄호 없이 렌더된다 — 우연히 안 보일 뿐,
    // 진짜 평탄화는 아니다. `A(BC)` 처럼 **뒤쪽** 인수 자리에 오면 POW 세기를 요구하니
    // 괄호가 필요하다 (아래 테스트). **순서**는 그대로다 — `AB ≠ BA` 는 여전히 지켜진다.
    expect(rendered(String.raw`\left(AB\right)C`)).toBe('ABC');
    expect(rendered('BA')).toBe('BA');
  });

  it('뒤쪽 인수 자리의 중첩 matMul은 아직 괄호가 필요하다 (평탄화 전)', () => {
    // normalize(③)가 들어오면 이 괄호도 사라져야 한다 — 그때 이 테스트를 갱신한다.
    expect(rendered(String.raw`A\left(BC\right)`)).toBe(String.raw`A\left(BC\right)`);
  });

  it('덧셈은 곱 안에서 괄호를 지킨다 (분배는 결합법칙이 아니다)', () => {
    expect(rendered(String.raw`A\left(B+C\right)`)).toBe(String.raw`A\left(B+C\right)`);
  });

  it('덧셈이 곱 안에 들어가면 괄호가 붙는다', () => {
    expect(rendered(String.raw`\left(A+B\right)C`)).toBe(String.raw`\left(A+B\right)C`);
  });

  it('외적은 양쪽 다 괄호가 필요하다 (결합법칙이 없다)', () => {
    expect(rendered(String.raw`\left(u\times v\right)\times w`)).toBe(
      String.raw`\left(u\times v\right)\times w`,
    );
  });

  it('내적 뒤의 곱은 mul이라 내적 쪽에 괄호가 붙는다', () => {
    // `u·v` 가 스칼라이므로 그 다음 곱은 내적이 아니라 mul(scalar, matrix)이다.
    expect(sexpTyped(typedOf(String.raw`u\cdot v\cdot w`))).toBe('(mul (dot u v) w)');
    expect(rendered(String.raw`u\cdot v\cdot w`)).toBe(String.raw`\left(u\cdot v\right)w`);
  });

  it('전치·거듭제곱의 밑이 복합이면 괄호가 붙는다', () => {
    expect(rendered(String.raw`\left(AB\right)^T`)).toBe(String.raw`\left(AB\right)^T`);
    expect(rendered(String.raw`\left(A+B\right)^2`)).toBe(String.raw`\left(A+B\right)^{2}`);
  });

  it('글자로만 된 명령 뒤에 글자가 바로 오면 공백으로 뗀다 (안 그러면 명령 이름을 먹는다)', () => {
    // CE는 `e` 를 파싱 단계에서부터 곧장 심볼 `ExponentialE` 로 읽고(실측), 그 이름의
    // LaTeX은 `\exponentialE` 처럼 글자로만 된 명령이다. 뒤에 곧장 `x` 가 붙으면
    // `\exponentialEx` 가 되어 존재하지 않는 명령이 되고 파싱이 깨진다(실측:
    // `\alphax` → unexpected-command). 공백 하나로 떼어내면 다시 읽어도 그대로다.
    expect(sexpTyped(typedOf('ex'))).toBe('(scalarMul ExponentialE x)');
    expect(rendered('ex')).toBe(String.raw`\exponentialE x`);
    expectRoundTrip('ex');
  });
});

describe('잎 렌더', () => {
  it('심볼 이름은 CE 사전을 거쳐 LaTeX으로 돌아온다', () => {
    expect(rendered(String.raw`\alpha`)).toBe(String.raw`\alpha`);
    expect(rendered(String.raw`\pi`)).toBe(String.raw`\pi`);
    expect(rendered('x_1')).toBe('x_1');
  });

  it('숫자끼리 병치는 괄호로 떼어놓는다', () => {
    // 그냥 이어붙이면 `2`·`3` 이 `23` 이 된다. `\cdot` 로 끼우면 병치보다 느슨해서
    // `2\cdot 3x` 가 `2·(3x)` 로 읽혀 묶음이 달라진다 — 괄호만이 안전하다.
    expect(rendered(String.raw`2\cdot3`)).toBe(String.raw`2\left(3\right)`);
  });

  it('음수 지수는 중괄호로 감싼다', () => {
    expect(rendered('A^{-1}')).toBe('A^{-1}');
  });
});

describe('apply — 사용자 정의 함수 호출', () => {
  function fn(params: readonly string[], bodyLatex: string): FunctionDef {
    const s = parseSyntax(bodyLatex);
    if (!s.ok) throw new Error('bad body');
    return { params, body: s.value };
  }

  const FN_ENV: Env = {
    ...TEST_ENV,
    shapes: { ...TEST_ENV.shapes, y: shape(1, 1) },
    functions: { f: fn(['x'], 'x^2') },
  };

  /** 왕복이 성립하는지 — **같은 env** 안에서만 계약이 성립한다(render.ts 서두 참고). */
  function expectRoundTripIn(latex: string, env: Env): void {
    const once = typedOf(latex, env);
    const out = render(once);
    const twice = typedOf(out, env);
    expect(sexpTyped(twice), `round-trip broke via ${out}`).toBe(sexpTyped(once));
  }

  it('f(y) 는 f\\left(y\\right) 로 렌더된다 — call 처럼 뭉개지 않는다', () => {
    expect(render(typedOf('f(y)', FN_ENV))).toBe(String.raw`f\left(y\right)`);
  });

  it('같은 env 안에서 왕복이 성립한다', () => {
    expectRoundTripIn('f(y)', FN_ENV);
    expectRoundTripIn('f(y)^2', FN_ENV);
  });

  it('함수 정의가 없는 env로 다시 읽으면 곱으로 돌아온다 (render.ts 서두의 계약 그대로)', () => {
    const rerendered = render(typedOf('f(y)', FN_ENV));
    const rereadElsewhere = typedOf(rerendered, TEST_ENV);
    // TEST_ENV엔 y도 없어 둘 다 미정 스칼라로 가정된다 → scalarMul.
    expect(sexpTyped(rereadElsewhere)).toBe('(scalarMul f y)');
  });
});
