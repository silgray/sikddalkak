import { describe, expect, it } from 'vitest';
import { formatTyped } from '../debug';
import type { TypedExpr } from '../expression/node';
import { combineLikeTerms } from './combine';
import { fromPolynomial, toPolynomial } from './convert';
import { monomialKey } from './polynomial';
import { render } from '../render';
import { formatShape } from '../shape/shape';
import { TEST_ENV, sameValue, typedOf } from '../testEnv';

/**
 * 정규형 테스트.
 *
 * 눈으로 보는 단위 테스트(전개 결과의 꼴)와, 값이 바뀌지 않았는지 자동 대조하는 속성
 * 테스트를 함께 돌린다. 전자는 "원하는 모양인가", 후자는 "틀리지 않았는가"를 본다.
 */

/** 전개만 한 결과 (동류항은 합치지 않음). */
function expanded(latex: string): TypedExpr {
  const source = typedOf(latex);
  const p = toPolynomial(source);
  if (!p.ok) throw new Error(`toPolynomial failed: ${p.errors[0].message}`);
  const back = fromPolynomial(p.value, source.shape);
  if (!back.ok) throw new Error(`fromPolynomial failed: ${back.errors[0].message}`);
  return back.value;
}

/** 전개 + 동류항 합치기. */
function collected(latex: string): TypedExpr {
  const source = typedOf(latex);
  const p = toPolynomial(source);
  if (!p.ok) throw new Error(`toPolynomial failed: ${p.errors[0].message}`);
  const back = fromPolynomial(combineLikeTerms(p.value), source.shape);
  if (!back.ok) throw new Error(`fromPolynomial failed: ${back.errors[0].message}`);
  return back.value;
}

describe('분배 — 사용자가 요구한 전개', () => {
  it('v^T(A+B)v -> v^TAv + v^TBv', () => {
    expect(render(expanded(String.raw`v^T\left(A+B\right)v`))).toBe('v^TAv+v^TBv');
  });

  it('(A+B)C -> AC + BC (좌우 순서 유지)', () => {
    expect(render(expanded(String.raw`\left(A+B\right)C`))).toBe('AC+BC');
  });

  it('C(A+B) -> CA + CB (좌우 순서 유지)', () => {
    expect(render(expanded(String.raw`C\left(A+B\right)`))).toBe('CA+CB');
  });

  it('외적도 분배된다', () => {
    expect(render(expanded(String.raw`u\times\left(v+w\right)`))).toBe(
      String.raw`u\times v+u\times w`,
    );
  });

  it('내적도 분배된다', () => {
    expect(render(expanded(String.raw`u\cdot\left(v+w\right)`))).toBe(
      String.raw`u\cdot v+u\cdot w`,
    );
  });

  it('전치는 합 위로 분배된다', () => {
    expect(render(expanded(String.raw`\left(A+B\right)^T`))).toBe('A^T+B^T');
  });

  it('정수 거듭제곱을 풀어쓴다', () => {
    // `monomialToExpr` 는 이웃한 같은 인수를 접지 않는다 (`polynomial/polynomial.ts` 서두 참고) —
    // `AA` 를 `A^{2}` 로 만드는 건 `simplify` 의 몫이라 여기선 풀어쓴 그대로다.
    expect(render(expanded(String.raw`\left(A+B\right)^2`))).toBe('AA+AB+BA+BB');
  });
});

describe('비가환 — 여기가 이 설계의 핵심', () => {
  it('ABA 는 A^2B 로 접히지 않는다', () => {
    // 인수 열을 정렬하지 않으므로 `A`,`B`,`A` 가 그대로 남는다.
    expect(render(expanded('ABA'))).toBe('ABA');
  });

  it('인수 열의 순서를 그대로 보존한다 (접기는 simplify 몫)', () => {
    expect(render(expanded('AAB'))).toBe('AAB');
    // 여기가 핵심 — 정렬했다면 `ABA` 도 `AAB` 가 됐을 것이다.
    expect(render(expanded('ABA'))).toBe('ABA');
  });

  it('AB 와 BA 는 동류항이 아니다', () => {
    const ab = toPolynomial(typedOf('AB'));
    const ba = toPolynomial(typedOf('BA'));
    if (!ab.ok || !ba.ok) throw new Error('unexpected failure');
    expect(monomialKey(ab.value[0])).not.toBe(monomialKey(ba.value[0]));
  });

  it('AB + BA 는 2AB 로 합쳐지지 않는다', () => {
    expect(render(collected('AB+BA'))).toBe('AB+BA');
  });

  it('AB + AB 는 합쳐진다', () => {
    expect(render(collected('AB+AB'))).toBe('2AB');
  });

  it('스칼라 인수는 교환 가능하므로 순서가 달라도 동류항이다', () => {
    expect(render(collected('abA+baA'))).toBe('2abA');
  });
});

describe('동류항 합치기', () => {
  it('상쇄되면 모양에 맞는 영이 된다', () => {
    expect(render(collected('a-a'))).toBe('0');
    // 스칼라 0으로 뭉개면 `\left(A-A\right)+B` 가 "행렬+스칼라" 오류로 막힌다.
    expect(render(collected('A-A'))).toBe(
      String.raw`\begin{pmatrix}0&0&0\\0&0&0\\0&0&0\end{pmatrix}`,
    );
  });

  it('계수가 정리된다', () => {
    expect(render(collected('2A+3A'))).toBe('5A');
    expect(render(collected('3A-A'))).toBe('2A');
  });

  it('부호는 뺄셈으로 나온다', () => {
    expect(render(collected('A-2B'))).toBe('A-2B');
  });
});

describe('속성 대조 — 재작성이 값을 바꾸지 않는다', () => {
  // 역행렬이 든 식은 수치 대조가 불가능하므로 여기 넣지 않는다 (numeric.ts 주석 참고).
  const cases = [
    'v^TAv',
    String.raw`v^T\left(A+B\right)v`,
    String.raw`\left(A+B\right)C`,
    String.raw`C\left(A+B\right)`,
    String.raw`\left(A+B\right)\left(B+C\right)`,
    'ABA',
    'AAB',
    'AB+BA',
    'A-A',
    '2A+3A',
    String.raw`\left(A+B\right)^2`,
    String.raw`\left(A+B\right)^T`,
    String.raw`u\times\left(v+w\right)`,
    String.raw`u\cdot\left(v+w\right)`,
    String.raw`\left(v\cdot w\right)v\times A\left(v\times w\right)`,
    String.raw`\left(u+v\right)\times\left(v+w\right)`,
    String.raw`a\left(A+B\right)v`,
    String.raw`\left(v^Tv\right)A`,
    'M^TM',
    String.raw`r\left(A+B\right)`,
    String.raw`-\left(A+B\right)C`,
    String.raw`2\left(A-B\right)+3B`,
  ];

  for (const latex of cases) {
    it(`${latex} — 전개해도 값과 모양이 같다`, () => {
      const original = typedOf(latex, TEST_ENV);
      const rewritten = expanded(latex);
      expect(formatShape(rewritten.shape)).toBe(formatShape(original.shape));
      expect(sameValue(original, rewritten)).toBe(true);
    });

    it(`${latex} — 동류항을 합쳐도 값이 같다`, () => {
      const original = typedOf(latex, TEST_ENV);
      const rewritten = collected(latex);
      expect(sameValue(original, rewritten)).toBe(true);
    });
  }
});

describe('왕복 — 전개 결과를 다시 읽어도 같다', () => {
  it('렌더한 전개 결과가 같은 트리로 다시 읽힌다', () => {
    for (const latex of ['ABA', String.raw`v^T\left(A+B\right)v`, String.raw`u\times\left(v+w\right)`]) {
      const once = expanded(latex);
      const twice = typedOf(render(once), TEST_ENV);
      expect(formatTyped(twice), `via ${render(once)}`).toBe(formatTyped(once));
    }
  });
});
