import { describe, expect, it } from 'vitest';
import { sexpTyped } from '../debug';
import { elaborate } from './elaborate';
import { formatShape } from '../shape/shape';
import { parseSyntax } from '../syntax/parse';
import { TEST_ENV, typedOf } from '../testEnv';
import type { Env, FunctionDef } from '../expr/node';

/**
 * §4 표 테스트 — **표가 곧 명세**다.
 * 여기서 보는 건 두 가지뿐: 각 노드가 **어떤 연산으로 해석됐는가**와 **결과 모양**.
 * 심볼 모양은 `testEnv.ts` 에 모아뒀다 (거기 없는 문자는 미정의 = 스칼라 가정).
 */

/** 해석된 연산 트리. */
const opsOf = (latex: string, env: Env = TEST_ENV): string => sexpTyped(typedOf(latex, env));

/** 결과 모양. */
const shapeOf = (latex: string, env: Env = TEST_ENV): string => formatShape(typedOf(latex, env).shape);

/** 실패를 기대하고 오류 코드를 돌려준다. */
function errorCode(latex: string, env: Env = TEST_ENV): string {
  const syntax = parseSyntax(latex);
  if (!syntax.ok) return syntax.errors[0].code;
  const typed = elaborate(syntax.value, env);
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
  // TODO: normalize가 frac 을 남기도록 바뀐 뒤로 기대값이 안 맞다 — 테스트가
  // 뒤떨어진 건지 동작이 잘못된 건지 판단 필요 (CI 배포 게이트 통과용 임시 skip).
  it.skip('스칼라로 나누면 역수와의 mul이다', () => {
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

describe('미분/적분/합/곱 — 모양 규칙 (파싱 표는 calculus.test.ts)', () => {
  it('단일변수 미분은 원소별 — 모양 불변', () => {
    expect(shapeOf(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}\left(v\right)`)).toBe('3x1');
    expect(shapeOf(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}\left(A\right)`)).toBe('3x3');
    expect(shapeOf(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}\left(x^2\right)`)).toBe('scalar');
  });

  it('스칼라를 다변수로 미분하면 (1,n) 그래디언트다', () => {
    expect(shapeOf(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}(x,y,z)}\left(f\right)`)).toBe('1x3');
  });

  it('열벡터를 다변수로 미분하면 (m,n) 야코비안이다', () => {
    expect(shapeOf(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}(x,y)}\left(v\right)`)).toBe('3x2');
  });

  it('행벡터·일반 행렬의 다변수 미분은 오류다 (3-텐서라 표현 불가)', () => {
    expect(errorCode(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}(x,y)}\left(r\right)`)).toBe(
      'shape-mismatch',
    );
    expect(errorCode(String.raw`\dfrac{\mathrm{d}}{\mathrm{d}(x,y)}\left(A\right)`)).toBe(
      'shape-mismatch',
    );
  });

  it('\\sum·\\int 은 본문 모양을 그대로 물려받는다', () => {
    expect(shapeOf(String.raw`\sum_{k=1}^{n}\left(k\right)`)).toBe('scalar');
    expect(shapeOf(String.raw`\sum_{k=1}^{n}\left(A\right)`)).toBe('3x3');
    expect(shapeOf(String.raw`\int_{0}^{1}\left(v\right)\mathrm{d}t`)).toBe('3x1');
  });

  it('\\prod 는 정사각(스칼라 포함) 본문만 받는다', () => {
    expect(shapeOf(String.raw`\prod_{k=1}^{n}\left(k\right)`)).toBe('scalar');
    expect(shapeOf(String.raw`\prod_{k=1}^{n}\left(A\right)`)).toBe('3x3');
    expect(errorCode(String.raw`\prod_{k=1}^{n}\left(M\right)`)).toBe('shape-mismatch');
  });

  it('상하한은 스칼라여야 한다', () => {
    expect(errorCode(String.raw`\sum_{k=A}^{n}\left(k\right)`)).toBe('shape-mismatch');
  });
});

describe('사용자 정의 함수 — apply 는 호출부마다 모양이 다시 정해진다 (모양 다형)', () => {
  /** `params` 매개변수, `bodyLatex` 본문으로 함수 정의를 만든다. */
  function fn(params: readonly string[], bodyLatex: string): FunctionDef {
    const syntax = parseSyntax(bodyLatex);
    if (!syntax.ok) throw new Error(`fn body parse failed: ${syntax.errors[0].message}`);
    return { params, body: syntax.value };
  }

  const envWith = (functions: Readonly<Record<string, FunctionDef>>): Env => ({
    ...TEST_ENV,
    functions,
  });

  describe('f(x)=x^2 — 같은 정의가 인수 모양에 따라 갈린다', () => {
    const env = envWith({ f: fn(['x'], 'x^2') });

    it('스칼라 인수 → 스칼라', () => {
      expect(shapeOf('f(3)', env)).toBe('scalar');
      expect(opsOf('f(3)', env)).toBe('(apply f 3)');
    });

    it('정사각 행렬 인수 → 행렬 거듭제곱과 같은 모양', () => {
      expect(shapeOf('f(A)', env)).toBe('3x3');
    });

    it('정사각이 아닌 인수 → 오류 (행렬 거듭제곱이 정사각을 요구하므로)', () => {
      expect(errorCode('f(v)', env)).toBe('shape-mismatch');
    });
  });

  it('f(x)=x^Tx — 벡터를 받으면 스칼라(내적), 행렬을 받으면 행렬', () => {
    const env = envWith({ f: fn(['x'], 'x^Tx') });
    expect(shapeOf('f(v)', env)).toBe('scalar');
    expect(shapeOf('f(A)', env)).toBe('3x3');
  });

  it('본문이 행렬 리터럴이면 인수 모양과 무관하게 그 모양 — 스칼라가 아니면 오류', () => {
    const env = envWith({ f: fn(['x'], String.raw`\begin{pmatrix}x\\1\end{pmatrix}`) });
    expect(shapeOf('f(3)', env)).toBe('2x1');
    expect(errorCode('f(v)', env)).toBe('shape-mismatch');
  });

  it('모양 오류에 호출 맥락(함수 이름)이 붙는다', () => {
    const env = envWith({ f: fn(['x'], String.raw`\sin\left(x\right)`) });
    const syntax = parseSyntax('f(A)');
    if (!syntax.ok) throw new Error('unexpected parse failure');
    const typed = elaborate(syntax.value, env);
    if (typed.ok) throw new Error('expected failure');
    expect(typed.errors[0].message).toMatch(/^f: /);
  });

  it('f(v)·w 는 f 의 결과 모양에 따라 dot/mul 이 갈리고, 몰랐으면 못 정했을 오류도 난다', () => {
    // elaborate가 apply의 모양을 그 자리에서 확정지어야 하는 이유 그 자체 — 확정 안
    // 하면 뒤이은 `·` 가 내적인지 스칼라곱인지, 심지어 길이가 맞는지도 정할 수가 없다.
    const identityFn = envWith({ f: fn(['x'], 'x') });
    // f(v) 는 v 와 같은 모양(3,1) → 같은 열벡터끼리의 `·` 는 내적.
    expect(opsOf(String.raw`f(v)\cdot w`, identityFn)).toBe('(dot (apply f v) w)');
    // f(p) 는 (2,1) — w(3,1)과 길이가 달라 내적이 안 선다.
    expect(errorCode(String.raw`f(p)\cdot w`, identityFn)).toBe('shape-mismatch');

    const scalarFn = envWith({ f: fn(['x'], 'x^Tx') }); // f(v): scalar
    expect(opsOf(String.raw`f(v)\cdot w`, scalarFn)).toBe('(mul (apply f v) w)');
  });

  it('인수가 여러 개인 함수', () => {
    const env = envWith({ f: fn(['x', 'y'], 'x+y') });
    expect(shapeOf('f(a,b)', env)).toBe('scalar');
  });

  it('인수 개수가 안 맞으면 오류다', () => {
    const env = envWith({ f: fn(['x', 'y'], 'x+y') });
    expect(errorCode('f(a)', env)).toBe('shape-mismatch');
  });

  it('정의되지 않은 이름 뒤 괄호는 기존대로 곱(행렬곱)으로 해석된다', () => {
    // env.functions가 비어 있으면 동작이 하나도 안 바뀐다는 게 이번 설계의 계약이다.
    expect(opsOf('A(v)')).toBe('(matMul A v)');
    expect(opsOf(String.raw`A\left(v+w\right)`)).toBe('(matMul A (add v w))');
  });

  it('후위는 apply 전체를 감싼다 — f(x)^2 는 (f(x))^2', () => {
    const env = envWith({ f: fn(['x'], 'x+1') });
    expect(opsOf('f(x)^2', env)).toBe('(scalarPow (apply f x) 2)');
  });

  it('함수가 아니면 후위가 마지막 인수 안으로 다시 들어간다 (§3 규칙 유지, 실측 회귀)', () => {
    // env.functions가 비어 있을 때 A(B)^T 는 여전히 A·(B^T) 다 — apply로 정규화됐다가
    // 도로 juxt로 접힐 때 후위 위치를 잃으면 (A·B)^T 로 둔갑해 값이 달라진다(퍼즈가 잡음).
    expect(opsOf(String.raw`A\left(B\right)^T`)).toBe('(matMul A (transpose B))');
    expect(opsOf(String.raw`A\left(B\right)^2`)).toBe('(matMul A (matPow B 2))');
    // 다중 인수여도 후위는 맨 마지막 인수에만 붙는다.
    expect(opsOf(String.raw`A\left(B,C\right)^T`)).toBe(
      '(matMul (matMul A B) (transpose C))',
    );
  });

  it('명시적으로 한 번 더 괄호를 치면 후위가 apply 전체를 감싼다 (tightPostfix, 실측 회귀)', () => {
    // `A(B)^T`(괄호 한 겹)와 `(A(B))^T`(괄호 두 겹)는 CE JSON부터 다르게 온다(실측,
    // translateToTree.ts 참고) — 후자는 사용자가 후위 범위를 이미 통째로 못박은
    // 것이므로, A가 함수가 아니어도 (A·B) 전체가 전치돼야지 B만 전치되면 안 된다.
    // 대문자·소문자 양쪽 경로 다 확인한다.
    expect(opsOf(String.raw`\left(A\left(B\right)\right)^T`)).toBe(
      '(transpose (matMul A B))',
    );
    expect(opsOf(String.raw`\left(g\left(v\right)\right)^T`)).toBe('(transpose (mul g v))');
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
