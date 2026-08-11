import { describe, expect, it } from 'vitest';
import { sexpTyped } from './debug';
import { render } from './render';
import { formatShape, shape } from './shape/shape';
import { normalizedOf, sameValue, simplifiedOf, TEST_ENV, typedOf } from './testEnv';

/**
 * 항등행렬 `I` (matIdentity) 테스트.
 *
 * `typedOf` 가 아니라 **`normalizedOf`** 를 쓴다 — 소거는 normalize의 몫이라, elaborate
 * 직후 모습(`typedOf`)만 보면 `I` 가 아직 그대로 남아 있다. 공개 `parse()` 와 같은 경로다.
 *
 * `A^{-1}A`/`AA^{-1}B` 는 **퍼즈가 못 보는 자리**다 — `numeric.ts` 가 역행렬을 거부해서
 * 값 대조가 불가능하다(퍼즈 생성기도 역행렬을 안 만든다). 여기 표 테스트가 유일한 안전망.
 */

describe('모양 해석 — elaborate가 I 를 채운다', () => {
  it('A+I 는 I 를 A의 모양으로 해석한다', () => {
    const t = normalizedOf('A+I');
    // 항 순서는 normalize 가 정한다 (`I(3x3)` 가 `sA` 보다 앞선다).
    expect(sexpTyped(t)).toBe('(add I A)');
    expect(formatShape(t.shape)).toBe('3x3');
  });

  it('AI, IA 는 상대에게서 I의 모양을 유도해 소거한다', () => {
    expect(sexpTyped(normalizedOf('AI'))).toBe('A');
    expect(sexpTyped(normalizedOf('IA'))).toBe('A');
  });

  it('직사각·벡터와도 소거된다', () => {
    expect(sexpTyped(normalizedOf('Iv'))).toBe('v'); // v: 3x1
    expect(sexpTyped(normalizedOf('MI'))).toBe('M'); // M: 2x3 직사각
  });

  it('AIA 는 I 를 먼저 버려야 두 A 가 이웃해져 A² 로 접힌다', () => {
    // 소거와 접기가 둘 다 normalize 몫이다 — parse 만으로 여기까지 온다.
    const t = normalizedOf('AIA');
    expect(sexpTyped(t)).toBe('(matPow A 2)');
    expect(render(t)).toBe('A^{2}');
  });

  it('A^0 은 I 다', () => {
    const t = normalizedOf('A^0');
    expect(sexpTyped(t)).toBe('I');
    expect(formatShape(t.shape)).toBe('3x3');
  });

  it('I^n 은 미정이어도 정사각이 전제이므로 그대로 I 다', () => {
    expect(sexpTyped(normalizedOf('I^3'))).toBe('I');
  });
});

describe('거듭제곱 접기 — normalize 기본값', () => {
  it('행렬은 이웃한 런만 접는다 (비가환)', () => {
    expect(render(normalizedOf('AAABBA'))).toBe('A^{3}B^{2}A');
    expect(render(normalizedOf('ABA'))).toBe('ABA');
  });

  it('스칼라는 떨어져 있어도 모아서 접는다 (교환 가능)', () => {
    expect(render(normalizedOf('xxxyyx'))).toBe('x^{4}y^{2}');
    expect(render(normalizedOf('aAa'))).toBe('a^{2}A');
    expect(render(normalizedOf(String.raw`\sin(x)\sin(x)`))).toBe(
      String.raw`\sin\left(x\right)^{2}`,
    );
  });

  it('지수 합이 0이면 소거된다', () => {
    expect(sexpTyped(normalizedOf(String.raw`AA^{-1}`))).toBe('I');
    expect(render(normalizedOf(String.raw`xx^{-1}`))).toBe('1');
    expect(render(normalizedOf(String.raw`xxx^{-1}yy`))).toBe('y^{2}x');
  });

  it('상수 정수가 아닌 지수는 건드리지 않는다', () => {
    // 합을 우리가 판정할 수 없으므로 접지 않는다.
    expect(render(normalizedOf(String.raw`x^{a}x^{b}`))).toBe('x^{a}x^{b}');
    expect(render(normalizedOf(String.raw`A^{n}A^{n}`))).toBe('A^{n}A^{n}');
  });
});

describe('frac — 비스칼라 분자는 곱으로 내린다', () => {
  it('계수가 역수와 합쳐진다', () => {
    expect(render(normalizedOf(String.raw`\frac{2A}{3}`))).toBe(String.raw`\frac{2}{3}A`);
    expect(render(normalizedOf(String.raw`\frac{A}{2}`))).toBe(String.raw`\frac{1}{2}A`);
  });

  it('심볼 분모도 내린다', () => {
    expect(render(normalizedOf(String.raw`\frac{A}{a}`))).toBe(String.raw`\frac{1}{a}A`);
  });

  it('합 분자도 통째로 내린다 (분배는 안 한다)', () => {
    expect(render(normalizedOf(String.raw`\frac{A+B}{2}`))).toBe(
      String.raw`\frac{1}{2}\left(A+B\right)`,
    );
  });

  it('스칼라 분자는 나눗셈 표기를 지킨다', () => {
    // 이걸 내리면 `\frac{x^2+2x+1}{x+1}` 이 원문 모양을 잃는다 — frac 노드의 존재 이유다.
    expect(render(normalizedOf(String.raw`\frac{x+1}{2}`))).toBe(String.raw`\frac{x+1}{2}`);
    expect(render(normalizedOf(String.raw`\frac{2x}{3}`))).toBe(String.raw`\frac{2x}{3}`);
  });
});

describe('matPow 지수는 식이어도 된다', () => {
  it('A^{1+2} 는 A^3 이다 — 지수도 정규화된다', () => {
    const t = normalizedOf('A^{1+2}');
    expect(sexpTyped(t)).toBe('(matPow A 3)');
    expect(render(t)).toBe('A^{3}');
  });

  it('직접 쓴 정수 지수의 모습은 그대로다', () => {
    // 지수를 일반 normalize 에 맡기면 `num -1` 이 `neg(num 1)` 이 되어 s-식이 달라진다.
    // 정수로 확정되면 단일 리터럴로 되돌려 담는 게 그 방어다.
    expect(sexpTyped(normalizedOf(String.raw`A^{-1}`))).toBe('(matPow A -1)');
    expect(sexpTyped(normalizedOf('A^{2}'))).toBe('(matPow A 2)');
  });

  it('값이 안 정해진 지수도 통과한다 (치환 뒤에 정해질 수 있다)', () => {
    const t = normalizedOf('A^{k}');
    expect(sexpTyped(t)).toBe('(matPow A k)');
    // 렌더 왕복이 성립해야 한다.
    expect(render(normalizedOf(render(t)))).toBe(render(t));
  });

  it('지수가 비스칼라면 오류다', () => {
    expect(() => normalizedOf('A^{v}')).toThrow();
  });

  it('simplify 는 지수까지 접는다', () => {
    expect(render(simplifiedOf('A^{2}A^{3}'))).toBe('A^{5}');
  });
});

// 소거는 거듭제곱 접기와 같은 패스(`foldAdjacentPowers`)에 있어 `simplify` 에서만 돈다.
describe('역행렬 소거 — 퍼즈가 못 보는 자리, 표 테스트로만 검증', () => {
  it('A^{-1}A 는 I 다', () => {
    expect(sexpTyped(simplifiedOf(String.raw`A^{-1}A`))).toBe('I');
  });

  it('AA^{-1}B 는 B 다 (소거로 새로 생긴 I 를 다시 걷어낸다)', () => {
    expect(sexpTyped(simplifiedOf(String.raw`AA^{-1}B`))).toBe('B');
  });

  it('BA^{-1}A 도 대칭적으로 성립한다', () => {
    expect(sexpTyped(simplifiedOf(String.raw`BA^{-1}A`))).toBe('B');
  });
});

describe('I 단독·덧셈', () => {
  it('I 혼자 쓰면 모양이 끝내 안 정해져 (1,1)=스칼라로 굳는다', () => {
    const t = normalizedOf('I');
    expect(sexpTyped(t)).toBe('I');
    expect(formatShape(t.shape)).toBe('scalar');
  });

  it('I+I 는 둘 다 (1,1)로 굳어 2 가 된다', () => {
    const t = normalizedOf('I+I');
    // 동류항 합치기가 `1+1` 을 접는다 — (1,1) 항등원은 스칼라 1과 같기 때문.
    expect(render(t)).toBe('2');
    expect(sameValue(t, typedOf('2'))).toBe(true);
  });
});

describe('정사각이 아니면 I 와 더할 수 없다', () => {
  it('M+I 는 오류다 (M 은 2x3 직사각)', () => {
    expect(() => normalizedOf('M+I')).toThrow();
  });

  it('I+M 도 오류다', () => {
    expect(() => normalizedOf('I+M')).toThrow();
  });
});

describe('env에 I 를 직접 정의하면 사용자 정의가 이긴다', () => {
  it('보통 심볼처럼 동작한다 — 자동 소거가 꺼진다', () => {
    const env = { shapes: { ...TEST_ENV.shapes, I: shape(3, 3) } };
    const t = normalizedOf('AI', env);
    expect(sexpTyped(t)).toBe('(matMul A I)'); // matIdentity 가 아니라 평범한 matMul
    expect(t.op === 'matMul' && t.factors[1].op).toBe('sym');
  });

  it('모양도 사용자가 준 대로 간다', () => {
    const env = { shapes: { ...TEST_ENV.shapes, I: shape(2, 2) } };
    const t = normalizedOf('I', env);
    expect(formatShape(t.shape)).toBe('2x2');
  });
});

describe('값 대조 — 소거가 값을 바꾸지 않는다', () => {
  // A^{-1} 이 낀 식은 numeric.ts 가 역행렬을 거부해 대조 불가 — 여기선 제외.
  const cases = ['AI', 'IA', 'Iv', 'MI', 'AIA', 'A^0'];

  for (const latex of cases) {
    it(`${latex}`, () => {
      const eliminated = normalizedOf(latex);
      // A^0 은 원래 식에 I 가 없으므로 typedOf 비교 대신 그 자체로 I(n,n) 값(단위행렬)만 확인.
      if (latex === 'A^0') {
        expect(sexpTyped(eliminated)).toBe('I');
        return;
      }
      const original = typedOf(latex); // elaborate 직후 (I 가 아직 안 지워진 모습)
      expect(sameValue(original, eliminated)).toBe(true);
    });
  }
});
