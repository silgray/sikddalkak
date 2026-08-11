import { describe, expect, it } from 'vitest';
import type { Env, TypedExpr } from '../expression/node';
import { render } from '../render';
import { isPureScalar } from './delegate';
import { expand } from './expand';
import { factor } from './factor';
import { simplify } from './simplify';
import { substitute } from './substitute';
import { evalNumeric, matricesClose } from '../numeric';
import { formatShape, shape } from '../shape/shape';
import { TEST_ENV, TEST_VALUES, sameValue, typedOf } from '../testEnv';

/**
 * 재작성 테스트.
 *
 * 세 겹으로 본다:
 *  ① 꼴 — 사용자가 요구한 결과가 그대로 나오는가
 *  ② 경계 — 모양이 얽힌 식이 CE로 새어나가지 않는가
 *  ③ 값 — 재작성 전후의 수치가 같은가 (설계 §10②, 자동으로 오답을 잡는 장치)
 */

function applied(
  op: (e: TypedExpr, env: Env) => ReturnType<typeof expand>,
  latex: string,
  env: Env = TEST_ENV,
): TypedExpr {
  const result = op(typedOf(latex, env), env);
  if (!result.ok) throw new Error(`rewrite failed: ${result.errors[0].message}`);
  return result.value;
}

const expandedLatex = (latex: string): string => render(applied(expand, latex));
const simplifiedLatex = (latex: string): string => render(applied(simplify, latex));
const factoredLatex = (latex: string): string => render(applied(factor, latex));

describe('expand — 사용자가 요구한 전개', () => {
  it('v^T(A+B)v -> v^TAv + v^TBv', () => {
    expect(expandedLatex(String.raw`v^T\left(A+B\right)v`)).toBe('v^TAv+v^TBv');
  });

  it('행렬곱 순서를 지킨다', () => {
    expect(expandedLatex(String.raw`\left(A+B\right)C`)).toBe('AC+BC');
    expect(expandedLatex(String.raw`C\left(A+B\right)`)).toBe('CA+CB');
  });

  it('벡터 내적·외적의 분배법칙', () => {
    expect(expandedLatex(String.raw`u\cdot\left(v+w\right)`)).toBe(String.raw`u\cdot v+u\cdot w`);
    expect(expandedLatex(String.raw`u\times\left(v+w\right)`)).toBe(
      String.raw`u\times v+u\times w`,
    );
  });

  it('순수 스칼라 식은 CE가 전개한다', () => {
    // 항 순서는 CE가 정한다 — 스칼라는 교환 가능하므로 순서를 강제할 이유가 없다.
    // 항 순서는 이제 CE가 아니라 normalize 의 정렬이 정한다 (`*`0x2A < `p`0x70).
    expect(expandedLatex(String.raw`\left(x+y\right)^2`)).toBe('2xy+x^{2}+y^{2}');
  });

  it('스칼라 계수가 섞인 식', () => {
    expect(expandedLatex(String.raw`a\left(A+B\right)`)).toBe('aA+aB');
  });

  it('같은 스칼라가 겹치면 거듭제곱으로 접힌다', () => {
    // 스칼라 인수를 하나씩 CE에 넘기면 `aa` 인 채로 남는다 — 묶어서 넘겨야 접힌다.
    // (스칼라는 CE 위임 경로라 expand 에서도 접힌다.)
    expect(expandedLatex('aaA')).toBe('a^{2}A');
  });

  it('행렬 인수는 이웃할 때만 접힌다 (교환할 수 없으므로)', () => {
    // 접기는 normalize 기본값이라 expand/simplify 어느 쪽이든 같은 결과다.
    expect(expandedLatex('AAB')).toBe('A^{2}B');
    expect(expandedLatex('ABA')).toBe('ABA');
    expect(simplifiedLatex('AAB')).toBe('A^{2}B');
    expect(simplifiedLatex('ABA')).toBe('ABA');
    // 인접한 런만 모은다 — 떨어진 A 는 따로 남는다.
    expect(expandedLatex('AAABBA')).toBe('A^{3}B^{2}A');
  });
});

describe('simplify — 괄호를 함부로 풀지 않는다', () => {
  it('동류항은 합친다', () => {
    expect(simplifiedLatex('2A+3A')).toBe('5A');
    // `mul(2, matMul(A,B))` 에서 두 번째 자리(행렬 부분)는 렌더의 왕복 안전장치 때문에
    // 항상 괄호가 붙는다 (POW 문턱) — `matMul` 이 그 자리에 오면 무조건 감싼다. 값은 같다.
    expect(simplifiedLatex('AB+AB')).toBe(String.raw`2\left(AB\right)`);
  });

  it('비가환 항은 합치지 않는다', () => {
    expect(simplifiedLatex('AB+BA')).toBe('AB+BA');
  });

  it('분배가 필요한 항은 펼치지 않는다', () => {
    // 사용자가 괄호로 써둔 걸 정리한답시고 풀어놓지 않는다 (그건 expand의 일이다).
    expect(simplifiedLatex(String.raw`\left(A+B\right)C`)).toBe(String.raw`\left(A+B\right)C`);
  });

  it('순수 스칼라 부분은 CE가 정리한다', () => {
    expect(simplifiedLatex(String.raw`\sin\left(x\right)^2+\cos\left(x\right)^2`)).toBe('1');
  });

  it('상쇄는 모양을 지킨 채 일어난다', () => {
    expect(formatShape(applied(simplify, 'A-A').shape)).toBe('3x3');
  });
});

describe('factor — 비가환이라 좌·우 공통인수만', () => {
  it('공통 좌인수를 뽑는다', () => {
    expect(factoredLatex('AB+AC')).toBe(String.raw`A\left(B+C\right)`);
  });

  it('공통 우인수를 뽑는다', () => {
    expect(factoredLatex('BA+CA')).toBe(String.raw`\left(B+C\right)A`);
  });

  it('어느 쪽도 공통이 아니면 정직하게 포기한다', () => {
    // 억지로 뽑으면 곱의 순서가 바뀌어 값이 달라진다.
    expect(factoredLatex('AB+CA')).toBe('AB+CA');
  });

  it('공통 스칼라 계수를 뽑는다', () => {
    expect(factoredLatex('2A+2B')).toBe(String.raw`2\left(A+B\right)`);
    expect(factoredLatex('aA+aB')).toBe(String.raw`a\left(A+B\right)`);
  });

  it('내적의 공통인수도 뽑는다', () => {
    expect(factoredLatex(String.raw`u\cdot v+u\cdot w`)).toBe(
      String.raw`u\cdot \left(v+w\right)`,
    );
  });

  it('단위행렬이 필요한 경우도 뽑는다', () => {
    // `A + AB = A(I+B)` — matIdentity가 있으니 뽑을 수 있다. 항 순서는 `sortTerms`가
    // `exprKey` 순으로 정하므로(`I(...)` < `sB`) `I+B`.
    expect(factoredLatex('A+AB')).toBe(String.raw`A\left(I+B\right)`);
  });

  it('공통 좌·우인수를 2단계로 뽑는다', () => {
    // 1단계(앞)에서 A, 그 몫에서 2단계(뒤)로 다시 A.
    expect(factoredLatex('ABA+ACA')).toBe(String.raw`A\left(B+C\right)A`);
  });

  it('순수 스칼라 식은 CE가 인수분해한다', () => {
    // 두 인수 다 스칼라라 순서가 안 중요하다 — normalize가 exprKey 순으로 정렬한다.
    expect(factoredLatex('x^2-y^2')).toBe(String.raw`\left(x-y\right)\left(x+y\right)`);
  });

  it('스칼라 지수가 낀 공통인수도 뽑는다', () => {
    // `x^2` 는 `scalarPow` 원자가 아니라 `[x,x]` 다중집합으로 풀려 `x` 와 이어진다.
    expect(factoredLatex('kx+x^2')).toBe(String.raw`\left(k+x\right)x`);
    expect(factoredLatex('a^2k+a')).toBe(String.raw`\left(ak+1\right)a`);
  });

  it('공통 인수를 뗀 몫에 CE factor를 이어 붙인다', () => {
    // 공통 계수 2를 떼고 남은 `x^2+2x+1` 을 CE가 마저 `(x+1)^2` 로 묶는다.
    expect(factoredLatex('2x^2+4x+2')).toBe(String.raw`2\left(x+1\right)^{2}`);
    expect(factoredLatex('x^3+2x^2+x')).toBe(String.raw`\left(x+1\right)^{2}x`);
  });

  describe('단일 행렬 심볼 다항식 — 스칼라 인수분해 경로를 그대로 태운다', () => {
    it('A^3+4A^2+5A+2I -> (I+A)^2(2I+A)', () => {
      expect(factoredLatex('A^3+4A^2+5A+2I')).toBe(
        String.raw`\left(I+A\right)^{2}\left(2I+A\right)`,
      );
    });

    it('A^2+2A+I -> (I+A)^2', () => {
      expect(factoredLatex('A^2+2A+I')).toBe(String.raw`\left(I+A\right)^{2}`);
    });

    it('A^3+2A^2+A -> A(I+A)^2', () => {
      expect(factoredLatex('A^3+2A^2+A')).toBe(String.raw`A\left(I+A\right)^{2}`);
    });

    it('계수에 벡터가 낀 경우도 모양 기반으로 잡는다', () => {
      // 심볼 이름이 아니라 "비스칼라 인수 열" 을 보므로, 계수 안의 `u·v` 는 그냥
      // 스칼라 계수로 취급되고 A 만 밑으로 잡힌다.
      expect(
        factoredLatex(String.raw`\left(u\cdot v\right)A^2+\left(u\cdot v\right)A`),
      ).toBe(String.raw`\left(u\cdot v\right)\left(A\left(I+A\right)\right)`);
    });
  });
});

describe('CE 위임 경계 — 모양이 얽힌 식은 넘기지 않는다', () => {
  it('CE 결과는 LaTeX이 아니라 MathJSON으로 받는다', () => {
    // CE 0.90의 LaTeX 직렬화 버그: `Power(Divide(X,a),2)` 를 `\frac{1}{a}(X)^2` 로 내놓아
    // 지수의 적용 범위가 바뀐다. `.latex` 를 거치면 **값이 달라진다** (퍼즈가 잡은 건).
    const latex = String.raw`\left(\frac{b}{a}\cdot\left(b-2\right)\right)^{2}`;
    const original = typedOf(latex, { shapes: {} });
    const result = simplify(original, { shapes: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // a=3, b=-2 → ((-2/3)·(-4))² = (8/3)² = 64/9
    const before = evalNumeric(original, TEST_VALUES);
    const after = evalNumeric(result.value, TEST_VALUES);
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(matricesClose(before.value, after.value, 1e-9)).toBe(true);
  });

  it('순수 스칼라만 위임 대상이다', () => {
    expect(isPureScalar(typedOf('x+y'))).toBe(true);
    expect(isPureScalar(typedOf(String.raw`\sin\left(x\right)`))).toBe(true);
    // 결과는 스칼라지만 안에 벡터가 있다 — CE에 넘기면 벡터를 스칼라로 오해한다.
    expect(isPureScalar(typedOf(String.raw`v\cdot w`))).toBe(false);
    expect(isPureScalar(typedOf('v^Tv'))).toBe(false);
    expect(isPureScalar(typedOf('A'))).toBe(false);
  });
});

describe('substitute — 한 단계만', () => {
  const env: Env = {
    ...TEST_ENV,
    shapes: { ...TEST_ENV.shapes, D: shape(3, 3) },
    bindings: {
      // D = AB 로 정의돼 있다고 치자.
      D: typedOf('AB'),
    },
  };

  it('정의된 심볼을 정의로 바꾼다', () => {
    expect(render(applied(substitute, 'Dv', env))).toBe('ABv');
  });

  it('치환 결과 안은 다시 치환하지 않는다', () => {
    const nested: Env = {
      ...env,
      bindings: { D: typedOf('AB'), A: typedOf('BC') },
    };
    // D -> AB 로 바뀐 자리의 A 는 한 단계 안에서 다시 치환되지 않는다.
    expect(render(applied(substitute, 'D', nested))).toBe('AB');
  });

  it('정의가 없으면 그대로 둔다', () => {
    expect(render(applied(substitute, 'AB', env))).toBe('AB');
  });
});

describe('값 대조 — 재작성이 답을 바꾸지 않는다', () => {
  const cases = [
    String.raw`v^T\left(A+B\right)v`,
    String.raw`\left(A+B\right)C`,
    String.raw`C\left(A+B\right)`,
    String.raw`\left(A+B\right)\left(B+C\right)`,
    'ABA',
    'AB+BA',
    'AB+AC',
    'BA+CA',
    'AB+CA',
    '2A+2B',
    'aA+aB',
    'A+AB',
    'A-A',
    'ABA+ACA',
    'A^3BA+AB^2',
    String.raw`u\cdot v+u\cdot w`,
    String.raw`u\times\left(v+w\right)`,
    String.raw`\left(v\cdot w\right)v\times A\left(v\times w\right)`,
    String.raw`\left(u+v\right)\times\left(v+w\right)`,
    String.raw`a\left(A+B\right)v`,
    String.raw`\left(v^Tv\right)A`,
    String.raw`2\left(A-B\right)+3B`,
    'M^TM',
    'kx+x^2',
    'a^2k+a',
    '2x^2+4x+2',
    'x^3+2x^2+x',
    'A^3+4A^2+5A+2I',
    'A^2+2A+I',
    'A^3+2A^2+A',
    String.raw`\left(u\cdot v\right)A^2+\left(u\cdot v\right)A`,
  ];

  for (const latex of cases) {
    it(`${latex}`, () => {
      const original = typedOf(latex);
      for (const [name, op] of [
        ['expand', expand],
        ['simplify', simplify],
        ['factor', factor],
      ] as const) {
        const result = op(original, TEST_ENV);
        if (!result.ok) throw new Error(`${name} failed: ${result.errors[0].message}`);
        expect(formatShape(result.value.shape), `${name} changed the shape`).toBe(
          formatShape(original.shape),
        );
        expect(sameValue(original, result.value), `${name} changed the value`).toBe(true);
      }
    });
  }
});
