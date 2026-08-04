import { describe, expect, it } from 'vitest';
import { sexpTyped } from './debug';
import { elaborate } from './elaborate';
import { formatShape } from './types-shape';
import { parseSyntax } from './parseSymbol';
import { TEST_ENV, typedOf } from './testEnv';

/**
 * §4 표 테스트 — **표가 곧 명세**다.
 * 여기서 보는 건 두 가지뿐: 각 노드가 **어떤 연산으로 해석됐는가**와 **결과 모양**.
 * 심볼 모양은 `testEnv.ts` 에 모아뒀다 (거기 없는 문자는 미정의 = 스칼라 가정).
 */

/** 해석된 연산 트리. */
const opsOf = (latex: string): string => sexpTyped(typedOf(latex));

/** 결과 모양. */
const shapeOf = (latex: string): string => formatShape(typedOf(latex).shape);

/** 실패를 기대하고 오류 코드를 돌려준다. */
function errorCode(latex: string): string {
  const syntax = parseSyntax(latex);
  if (!syntax.ok) return syntax.errors[0].code;
  const typed = elaborate(syntax.value, TEST_ENV);
  if (typed.ok) throw new Error(`expected failure, got shape ${formatShape(typed.value.shape)}`);
  return typed.errors[0].code;
}

describe('사용자 예시 — 설계가 답해야 하는 것들', () => {
  it('v^T v 는 하드코딩 없이 스칼라가 된다', () => {
    // (1,3)(3,1) = (1,1) 이고 (1,1) 이 곧 스칼라라서 그냥 떨어진다.
    expect(shapeOf('v^Tv')).toBe('scalar');
    expect(opsOf('v^Tv')).toBe('(matMul (transpose v) v)');
  });

  it('(v^T v)A 는 스칼라 x 행렬이다', () => {
    expect(opsOf(String.raw`\left(v^Tv\right)A`)).toBe(
      '(mul (matMul (transpose v) v) A)',
    );
    expect(shapeOf(String.raw`\left(v^Tv\right)A`)).toBe('3x3');
  });

  it('Av 는 벡터다', () => {
    expect(shapeOf('Av')).toBe('3x1');
  });

  it('w x Av 가 외적으로 성립한다', () => {
    // 병치가 먼저 묶여 Av 가 3-벡터가 되고, 그 뒤에 외적이 성립한다.
    expect(opsOf(String.raw`w\times Av`)).toBe('(cross w (matMul A v))');
    expect(shapeOf(String.raw`w\times Av`)).toBe('3x1');
  });

  it('A + 1 은 오류다', () => {
    expect(errorCode('A+1')).toBe('shape-mismatch');
  });

  it('(v.w)v x A(v x w) 가 통째로 성립한다', () => {
    const latex = String.raw`\left(v\cdot w\right)v\times A\left(v\times w\right)`;
    expect(opsOf(latex)).toBe(
      '(cross (mul (dot v w) v) (matMul A (cross v w)))',
    );
    expect(shapeOf(latex)).toBe('3x1');
  });

  it('a^T 는 (a가 스칼라이므로) 전치가 아니라 일반 지수연산이다', () => {
    expect(opsOf('a^T')).toBe('(scalarPow a T)');
    expect(shapeOf('a^T')).toBe('scalar');
  });
});

describe('cdot — 모양이 연산을 고른다', () => {
  it('스칼라가 끼면 mul(scalar, matrix) — 순수 스칼라끼리의 scalarMul과 구분된다', () => {
    expect(opsOf(String.raw`a\cdot v`)).toBe('(mul a v)');
    expect(shapeOf(String.raw`a\cdot v`)).toBe('3x1');
    expect(opsOf(String.raw`v\cdot a`)).toBe('(mul a v)');
  });

  it('같은 방향 같은 길이 벡터면 내적 -> 스칼라', () => {
    expect(opsOf(String.raw`v\cdot w`)).toBe('(dot v w)');
    expect(shapeOf(String.raw`v\cdot w`)).toBe('scalar');
  });

  it('방향이 다르면 오류다 (열 . 행)', () => {
    expect(errorCode(String.raw`v\cdot r`)).toBe('shape-mismatch');
  });

  it('길이가 다르면 오류다', () => {
    expect(errorCode(String.raw`v\cdot p`)).toBe('shape-mismatch');
  });

  it('행렬끼리면 행렬곱이다', () => {
    expect(opsOf(String.raw`A\cdot B`)).toBe('(matMul A B)');
    expect(shapeOf(String.raw`A\cdot B`)).toBe('3x3');
  });
});

describe('times — 모양이 연산을 고른다', () => {
  it('스칼라가 끼면 mul(scalar, matrix)', () => {
    expect(opsOf(String.raw`a\times v`)).toBe('(mul a v)');
  });

  it('3-벡터끼리면 외적 -> 3-벡터', () => {
    expect(opsOf(String.raw`v\times w`)).toBe('(cross v w)');
    expect(shapeOf(String.raw`v\times w`)).toBe('3x1');
  });

  it('3-벡터가 아니면 외적이 아니다', () => {
    expect(errorCode(String.raw`p\times p`)).toBe('shape-mismatch');
  });

  it('행렬끼리면 행렬곱이다', () => {
    expect(opsOf(String.raw`A\times B`)).toBe('(matMul A B)');
  });
});

describe('병치 — 스칼라·행렬 조합에 따라 scalarMul/matMul/mul 셋 중 하나', () => {
  it('스칼라와 행렬이 섞이면 mul', () => {
    expect(opsOf('2A')).toBe('(mul 2 A)');
    expect(opsOf('av')).toBe('(mul a v)');
  });

  it('안쪽 차원이 맞으면 행렬곱', () => {
    expect(shapeOf('MA')).toBe('2x3');
  });

  it('안쪽 차원이 다르면 오류다', () => {
    expect(errorCode('AM')).toBe('shape-mismatch'); // (3,3)(2,3)
    expect(errorCode('vw')).toBe('shape-mismatch'); // (3,1)(3,1)
  });

  it('v v^T 는 외적 행렬이다', () => {
    expect(shapeOf('vv^T')).toBe('3x3');
  });
});

describe('덧셈 — 모양이 정확히 같아야 한다', () => {
  it('같은 모양끼리는 통과', () => {
    expect(shapeOf('A+B')).toBe('3x3');
    expect(shapeOf('v+w')).toBe('3x1');
    expect(shapeOf('a+b')).toBe('scalar');
  });

  it('행렬 + 벡터는 오류다', () => {
    expect(errorCode('A+v')).toBe('shape-mismatch');
  });

  it('열벡터 + 행벡터는 오류다 (전치해도 브로드캐스트하지 않는다)', () => {
    expect(errorCode('v+r')).toBe('shape-mismatch');
  });

  it('뺄셈도 같은 규칙이다', () => {
    expect(shapeOf('A-B')).toBe('3x3');
    expect(errorCode('A-1')).toBe('shape-mismatch');
  });
});

describe('거듭제곱', () => {
  it('비스칼라의 ^T 는 전치라 모양이 뒤집힌다', () => {
    expect(shapeOf('v^T')).toBe('1x3');
    expect(shapeOf('M^T')).toBe('3x2');
  });

  it('정사각 행렬의 정수 거듭제곱은 MatPow 다', () => {
    expect(opsOf('A^2')).toBe('(matPow A 2)');
    expect(shapeOf('A^2')).toBe('3x3');
  });

  it('역행렬 자리도 같은 경로로 열린다', () => {
    expect(opsOf('A^{-1}')).toBe('(matPow A -1)');
  });

  it('비정사각 행렬의 거듭제곱은 오류다', () => {
    expect(errorCode('M^2')).toBe('shape-mismatch');
    expect(errorCode('v^2')).toBe('shape-mismatch');
  });

  it('지수가 스칼라가 아니면 오류다', () => {
    expect(errorCode('a^v')).toBe('shape-mismatch');
  });

  it('스칼라 거듭제곱은 그냥 스칼라다', () => {
    expect(shapeOf('a^2')).toBe('scalar');
    expect(shapeOf('a^b')).toBe('scalar');
  });
});

describe('분수·함수', () => {
  it('스칼라로 나누면 역수와의 mul이다', () => {
    expect(opsOf(String.raw`\frac{A}{a}`)).toBe('(mul (scalarPow a -1) A)');
    expect(shapeOf(String.raw`\frac{A}{a}`)).toBe('3x3');
  });

  it('행렬로 나누는 건 오류다 (역행렬을 명시하게 한다)', () => {
    expect(errorCode(String.raw`\frac{1}{A}`)).toBe('shape-mismatch');
  });

  it('스칼라 함수에 비스칼라를 넣으면 오류다', () => {
    expect(shapeOf(String.raw`\sin a`)).toBe('scalar');
    expect(errorCode(String.raw`\sin A`)).toBe('shape-mismatch');
  });
});

describe('행렬 리터럴', () => {
  it('열벡터 리터럴', () => {
    expect(shapeOf(String.raw`\begin{pmatrix}1\\2\\3\end{pmatrix}`)).toBe('3x1');
  });

  it('1x1 리터럴은 스칼라와 같다', () => {
    expect(shapeOf(String.raw`\begin{pmatrix}5\end{pmatrix}`)).toBe('scalar');
  });

  it('리터럴 안의 원소는 스칼라여야 한다', () => {
    expect(errorCode(String.raw`\begin{pmatrix}v\\2\end{pmatrix}`)).toBe('shape-mismatch');
  });

  it('리터럴끼리 연산도 모양을 따라간다', () => {
    const m = String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`;
    expect(shapeOf(`${m}${m}`)).toBe('2x2');
    expect(errorCode(String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}+1`)).toBe('shape-mismatch');
  });
});

describe('미정의 심볼은 스칼라로 가정한다', () => {
  it('처음 보는 문자는 스칼라다', () => {
    expect(shapeOf('xyz')).toBe('scalar');
    expect(opsOf('xy')).toBe('(scalarMul x y)');
  });

  it('그래서 미정의 문자와 행렬의 곱은 mul이 된다', () => {
    expect(opsOf('kA')).toBe('(mul k A)');
  });
});
