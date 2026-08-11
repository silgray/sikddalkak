import { describe, expect, it } from 'vitest';
import { sexpTyped } from '../debug';
import { elaborate } from './elaborate';
import { formatShape } from '../shape/shape';
import { parseSyntax } from '../syntax/parse';
import { TEST_ENV, typedOf } from '../testEnv';
import type { Env } from '../expr/node';

/**
 * 미분/적분/`\sum`/`\prod` 파싱 표.
 *
 * `elaborate.test.ts` 와 같은 방식 — 해석된 연산 트리와 모양만 본다. 심볼은 전부
 * `f`,`g`,`n` 처럼 미정의(=스칼라) 이거나 `TEST_ENV` 에 있는 이름을 쓴다.
 */

const opsOf = (latex: string, env: Env = TEST_ENV): string => sexpTyped(typedOf(latex, env));
const shapeOf = (latex: string, env: Env = TEST_ENV): string => formatShape(typedOf(latex, env).shape);

function errorCode(latex: string, env: Env = TEST_ENV): string {
  const syntax = parseSyntax(latex);
  if (!syntax.ok) return syntax.errors[0].code;
  const typed = elaborate(syntax.value, env);
  if (typed.ok) throw new Error(`expected failure, got shape ${formatShape(typed.value.shape)}`);
  return typed.errors[0].code;
}

describe('단일변수 미분 — \\frac{d}{dx}', () => {
  it('\\dfrac{d}{dx} f(x) — 후위 없는 기본형', () => {
    expect(opsOf(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x} f(x)`)).toBe(
      '(deriv (scalarMul f x) [x] 1)',
    );
    expect(shapeOf(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x} f(x)`)).toBe('scalar');
  });

  it('\\dfrac{d}{dx}(f(x)+g(x)) — 괄호 친 합', () => {
    expect(opsOf(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}(f(x)+g(x))`)).toBe(
      '(deriv (add (scalarMul f x) (scalarMul g x)) [x] 1)',
    );
  });

  it('d/dx 는 뒤따르는 +를 삼키지 않는다 — 바로 다음 항에만 묶인다', () => {
    // CE 실측: \frac{d}{dx}x+x 도 \frac{d}{dx}\left(x\right)+x 도 똑같이
    // D(Add(x,x),x) 로 온다(첫 항을 따로 괄호 쳤는지는 CE가 구분하지 않는다) — 그래서
    // 둘 다 같은 결과여야 한다. 합 전체를 미분하려면 \left(x+x\right) 처럼 합 전체를
    // 감싸야 한다(바로 아래 테스트).
    expect(opsOf(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}x+x`)).toBe(
      '(add (deriv x [x] 1) x)',
    );
    expect(opsOf(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}\left(x\right)+x`)).toBe(
      '(add (deriv x [x] 1) x)',
    );
  });

  it('셋 이상, 뺄셈 섞인 경우도 첫 항만 미분된다', () => {
    expect(opsOf(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}x+y+z`)).toBe(
      '(add (deriv x [x] 1) y z)',
    );
    expect(opsOf(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}x-y`)).toBe(
      '(add (deriv x [x] 1) (neg y))',
    );
  });

  it('N계 미분에서도 첫 항만 미분되고 order는 유지된다', () => {
    expect(opsOf(String.raw`\dfrac{\mathrm{d}^{3}}{\mathrm{d}x^{3}}x+y`)).toBe(
      '(add (deriv x [x] 3) y)',
    );
  });

  it('\\dfrac{df(x)}{dx} — 분자에 본문이 붙은 표기도 D 로 읽힌다', () => {
    expect(opsOf(String.raw`\dfrac{\mathrm{d}f(x)}{\mathrm{d}x}`)).toBe(
      '(deriv (scalarMul f x) [x] 1)',
    );
  });

  it('\\left(\\dfrac{d}{dx}\\right)^3 f — 연산자 자체의 거듭제곱은 order로 접힌다', () => {
    expect(opsOf(String.raw`\left(\dfrac{\mathrm{d}}{\mathrm{d}x}\right)^3 f`)).toBe(
      '(deriv f [x] 3)',
    );
  });

  it('\\left(\\dfrac{d}{dx}f\\right)^3 — 미분한 결과를 세제곱', () => {
    expect(opsOf(String.raw`\left(\dfrac{\mathrm{d}}{\mathrm{d}x}f\right)^3`)).toBe(
      '(scalarPow (deriv f [x] 1) 3)',
    );
  });

  it('변수가 다른 중첩은 안 접힌다', () => {
    expect(opsOf(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}y}\left(\dfrac{\mathrm{d}}{\mathrm{d}x}f\right)`)).toBe(
      '(deriv (deriv f [x] 1) [y] 1)',
    );
  });

  it('열벡터를 스칼라로 미분하면 열벡터다 (원소별)', () => {
    expect(shapeOf(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}\left(v\right)`)).toBe('3x1');
  });
});

describe('다변수 미분 — 야코비안/그래디언트', () => {
  it('스칼라를 (x,y,z)로 미분하면 (1,3) 행벡터다', () => {
    expect(shapeOf(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}(x,y,z)}\left(f\right)`)).toBe('1x3');
    expect(opsOf(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}(x,y,z)}\left(f\right)`)).toBe(
      '(deriv f [x,y,z] 1)',
    );
  });

  it('열벡터 (3,1)을 (x,y)로 미분하면 (3,2) 야코비안이다', () => {
    expect(shapeOf(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}(x,y)}\left(v\right)`)).toBe('3x2');
  });

  it('행벡터 본문의 다변수 미분은 오류다 (3-텐서라 표현 불가)', () => {
    expect(errorCode(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}(x,y)}\left(r\right)`)).toBe(
      'shape-mismatch',
    );
  });

  it('단일 변수를 괄호로 감싼 표기도 통과한다', () => {
    expect(opsOf(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}(x)}\left(f\right)`)).toBe(
      '(deriv f [x] 1)',
    );
  });

  it('꾸밈 없는 d 로도 다변수 미분을 쓸 수 있다 (단일변수는 이미 되던 것)', () => {
    expect(opsOf(String.raw`\frac{d}{d\left(x,y\right)}x`)).toBe('(deriv x [x,y] 1)');
    expect(shapeOf(String.raw`\frac{d}{d\left(x,y,z\right)}\left(f\right)`)).toBe('1x3');
  });

  it('분자에 본문이 붙은 표기(df/d(x,y))도 D 로 읽힌다', () => {
    expect(opsOf(String.raw`\dfrac{\mathrm{d}f}{\mathrm{d}(x,y)}`)).toBe('(deriv f [x,y] 1)');
    expect(opsOf(String.raw`\frac{dx}{d\left(x,y\right)}`)).toBe('(deriv x [x,y] 1)');
    expect(shapeOf(String.raw`\dfrac{\mathrm{d}v}{\mathrm{d}(x,y)}`)).toBe('3x2');
  });
});

describe('바운드 변수 규칙', () => {
  const DEFINED: Env = { shapes: { x: { rows: 1, cols: 1 } }, bindings: { x: typedOf('3', { shapes: {} }) } };

  it('i 는 허수단위라 인덱스/미분변수로 못 쓴다', () => {
    expect(errorCode(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}i}\left(f\right)`)).toBe('malformed');
    expect(errorCode(String.raw`\sum_{i=1}^{n}\left(a\right)`)).toBe('malformed');
    expect(errorCode(String.raw`\int f\,\mathrm{d}i`)).toBe('malformed');
  });

  it('이미 정의된 이름을 바운드 변수로 쓰면 오류다', () => {
    expect(errorCode(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}\left(x^2\right)`, DEFINED)).toBe(
      'malformed',
    );
    expect(errorCode(String.raw`\sum_{x=1}^{n}\left(x\right)`, DEFINED)).toBe('malformed');
  });

  it('중첩된 바인더가 같은 이름을 재사용해도 오탐 없이 통과한다', () => {
    expect(opsOf(String.raw`\sum_{k=1}^{2}\left(\sum_{k=1}^{2}\left(k\right)\right)`)).toBe(
      '(sum (sum k k 1 2) k 1 2)',
    );
  });
});

describe('\\sum / \\prod', () => {
  it('기본형 — 상하한 있음', () => {
    expect(opsOf(String.raw`\sum_{k=1}^{n}\left(a_k\right)`)).toBe('(sum a_k k 1 n)');
    expect(shapeOf(String.raw`\sum_{k=1}^{n}\left(a_k\right)`)).toBe('scalar');
  });

  it('임의 모양 본문도 받는다', () => {
    expect(shapeOf(String.raw`\sum_{k=1}^{n}\left(A\right)`)).toBe('3x3');
  });

  it('상하한 없이 인덱스만', () => {
    expect(opsOf(String.raw`\sum_{k}\left(k\right)`)).toBe('(sum k k _ _)');
  });

  it('\\prod 는 정사각(스칼라 포함) 본문만 받는다', () => {
    expect(opsOf(String.raw`\prod_{k=1}^{n}\left(A_k\right)`)).toBe('(prod A_k k 1 n)');
    expect(shapeOf(String.raw`\prod_{k=1}^{n}\left(a_k\right)`)).toBe('scalar');
    expect(errorCode(String.raw`\prod_{k=1}^{n}\left(M\right)`)).toBe('shape-mismatch');
  });

  it('인덱스 변수 없이 쓰면 오류다', () => {
    expect(errorCode(String.raw`\sum x`)).toBe('malformed');
  });
});

describe('\\int', () => {
  it('정적분', () => {
    expect(opsOf(String.raw`\int_{0}^{1} x^2\,\mathrm{d}x`)).toBe('(integral (scalarPow x 2) x 0 1)');
  });

  it('부정적분', () => {
    expect(opsOf(String.raw`\int x^2\,\mathrm{d}x`)).toBe('(integral (scalarPow x 2) x _ _)');
  });

  it('dx 없이 쓰면 오류다', () => {
    expect(errorCode(String.raw`\int x^2`)).toBe('malformed');
  });

  it('임의 모양 본문도 받는다', () => {
    expect(shapeOf(String.raw`\int A\,\mathrm{d}t`)).toBe('3x3');
  });
});
