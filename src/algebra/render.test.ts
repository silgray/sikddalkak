import { describe, expect, it } from 'vitest';
import { sexpTyped } from './debug';
import { render } from './render';
import { TEST_ENV, typedOf } from './testEnv';

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
  ];

  for (const latex of cases) {
    it(latex, () => {
      expectRoundTrip(latex);
    });
  }
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
