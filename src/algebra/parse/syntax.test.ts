import { describe, expect, it } from 'vitest';
import { sexpSyntax } from '../debug';
import { parseSyntax } from './parseSymbol';

/**
 * Syntax 층 테스트 — **구조**(우선순위·그룹)와 **어느 곱 기호였는가**만 검증한다.
 * 모양·연산 의미는 elaborate의 몫이라 여기서 다루지 않는다.
 */

const V = String.raw`\begin{pmatrix}1\\2\\3\end{pmatrix}`;

/** 성공을 기대하고 s-식을 돌려준다. */
function parsed(latex: string): string {
  const r = parseSyntax(latex);
  if (!r.ok) throw new Error(`parse failed: ${r.errors.map((e) => e.message).join(', ')}`);
  return sexpSyntax(r.value);
}

/** 실패를 기대하고 오류 코드를 돌려준다. */
function errorCode(latex: string): string {
  const r = parseSyntax(latex);
  if (r.ok) throw new Error(`expected failure, got: ${sexpSyntax(r.value)}`);
  return r.errors[0].code;
}

describe('곱 기호 구분', () => {
  it('cdot / times / 병치를 서로 다르게 유지한다', () => {
    // CE는 셋 다 Multiply로 뭉개므로, 여기서 갈라지는지가 이 층의 존재 이유다.
    expect(parsed(String.raw`u\cdot v`)).toBe('(dot u v)');
    expect(parsed(String.raw`u\times v`)).toBe('(cross u v)');
    expect(parsed('uv')).toBe('(juxt u v)');
  });
});

describe('우선순위 — 병치가 곱 기호보다 강하다', () => {
  it('Av . w 는 (Av) . w 다', () => {
    expect(parsed(String.raw`Av\cdot w`)).toBe('(dot (juxt A v) w)');
  });

  it('2v x w 는 (2v) x w 다', () => {
    expect(parsed(String.raw`2v\times w`)).toBe('(cross (juxt 2 v) w)');
  });

  it('v^T A v 는 전부 병치라 좌결합이다', () => {
    expect(parsed('v^TAv')).toBe('(juxt (juxt (^ v T) A) v)');
  });

  it('덧셈이 곱보다 느슨하다', () => {
    expect(parsed(String.raw`u\cdot v+w`)).toBe('(+ (dot u v) w)');
  });
});

describe('모호성 — 조용히 좌결합하지 않고 오류를 낸다', () => {
  it('혼합 곱은 오류다', () => {
    // 좌결합이면 (u.v)xw 로 읽혀 타입은 통과하지만 스칼라 삼중곱과 다른 답이 나온다.
    expect(errorCode(String.raw`u\cdot v\times w`)).toBe('ambiguous-order');
  });

  it('외적 반복은 오류다 (비결합)', () => {
    expect(errorCode(String.raw`u\times v\times w`)).toBe('ambiguous-order');
  });

  it('괄호로 순서를 지정하면 통과한다', () => {
    expect(parsed(String.raw`u\cdot\left(v\times w\right)`)).toBe('(dot u (cross v w))');
    expect(parsed(String.raw`\left(u\cdot v\right)\times w`)).toBe('(cross (dot u v) w)');
    expect(parsed(String.raw`\left(u\times v\right)\times w`)).toBe('(cross (cross u v) w)');
  });

  it('내적 반복은 결합 순서가 답을 바꾸지 않으므로 허용한다', () => {
    expect(parsed(String.raw`u\cdot v\cdot w`)).toBe('(dot (dot u v) w)');
  });

  it('병치 반복은 허용한다 (행렬곱은 결합법칙이 있다)', () => {
    expect(parsed('ABC')).toBe('(juxt (juxt A B) C)');
  });
});

describe('괄호는 트리 구조로 보존된다', () => {
  it('(AxB).(CxD) 의 그룹이 살아남는다', () => {
    expect(parsed(String.raw`\left(A\times B\right)\cdot\left(C\times D\right)`)).toBe(
      '(dot (cross A B) (cross C D))',
    );
  });
});

describe('기타 구성', () => {
  it('행렬 리터럴을 읽는다', () => {
    expect(parsed(V)).toBe('[1;2;3]');
  });

  it('거듭제곱·분수·음수·함수', () => {
    expect(parsed('x^2')).toBe('(^ x 2)');
    expect(parsed(String.raw`\frac{a}{b}`)).toBe('(/ a b)');
    expect(parsed('-x')).toBe('(- x)');
    expect(parsed(String.raw`\sin x`)).toBe('(sin x)');
  });

  it('전치는 지수 형태 그대로 둔다 (의미는 elaborate가 정한다)', () => {
    // 스칼라면 일반 지수, 비스칼라면 전치 — 모양을 알아야 갈리므로 여기선 판단하지 않는다.
    expect(parsed('v^T')).toBe('(^ v T)');
  });

  it('대문자 뒤 괄호는 함수 적용이 아니라 병치다', () => {
    // CE는 홑 대문자 뒤 괄호를 함수 호출로 읽는다(실측). 우리 도메인에선 행렬 곱이다.
    expect(parsed(String.raw`A\left(v+w\right)`)).toBe('(juxt A (+ v w))');
    expect(parsed(String.raw`AB\left(v\right)`)).toBe('(juxt A (juxt B v))');
    // 소문자·첨자 있는 이름은 CE도 병치로 준다 — 같은 결과가 나와야 한다.
    expect(parsed(String.raw`g\left(x\right)`)).toBe('(juxt g x)');
    expect(parsed(String.raw`A_1\left(v\right)`)).toBe('(juxt A_1 v)');
  });

  it('역삼각함수는 \\sin^{-1} 로 써도 \\arcsin 과 같은 곳에 도착한다', () => {
    // CE는 `Apply(InverseFunction(Sin), x)` 로 준다(실측) — 막히던 머리는 `Apply` 였다.
    expect(parsed(String.raw`\sin^{-1}(x)`)).toBe('(arcsin x)');
    expect(parsed(String.raw`\arcsin(x)`)).toBe('(arcsin x)');
    expect(parsed(String.raw`\cos^{-1}(x)`)).toBe('(arccos x)');
    expect(parsed(String.raw`\tan^{-1}(x)`)).toBe('(arctan x)');
    // `\sin^2` 은 `Apply` 경로를 안 탄다 — 일반 거듭제곱이다.
    expect(parsed(String.raw`\sin^2(x)`)).toBe('(^ (sin x) 2)');
  });

  it('대응하는 arc- 이름이 없는 역함수는 오류다', () => {
    // arsinh 를 우리 테이블에 안 두었으므로 조용히 틀리느니 못 한다고 한다.
    expect(errorCode(String.raw`\sinh^{-1}(x)`)).toBe('unsupported');
  });

  it('모르는 머리는 곱으로 둔갑시키지 않고 오류를 낸다', () => {
    // 위의 병치 되돌리기가 너무 넓어지면 여기서 조용한 오답이 생긴다.
    expect(errorCode(String.raw`\int x`)).toBe('unsupported');
    expect(errorCode(String.raw`\lfloor x\rfloor`)).toBe('unsupported');
  });

  it('A^{-1} 이 행렬 나눗셈으로 변질되지 않는다', () => {
    // Power 정규화 폼이 켜져 있으면 CE가 `Divide(1,A)` 로 바꿔버린다 — 역행렬이 사라진다.
    expect(parsed('A^{-1}')).toBe('(^ A -1)');
    expect(parsed('A^{-2}')).toBe('(^ A -2)');
  });

  it('빈 식은 오류다', () => {
    expect(errorCode('')).toBe('malformed');
    expect(errorCode('   ')).toBe('malformed');
  });
});
