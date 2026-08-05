import { describe, expect, it } from 'vitest';
import { sexpTyped } from './debug';
import { render } from './render';
import { formatShape, shape } from './types-shape';
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

  it('AIA 는 I 를 먼저 버려야 두 A 가 이웃해진다', () => {
    // 소거는 normalize 몫이라 여기서 이미 `AA` 가 된다.
    expect(sexpTyped(normalizedOf('AIA'))).toBe('(matMul A A)');
    // 접기는 simplify 몫이다 (normalize 기본값은 안 접는다).
    const t = simplifiedOf('AIA');
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
