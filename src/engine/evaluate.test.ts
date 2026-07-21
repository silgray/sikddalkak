import { describe, expect, it } from 'vitest';
import { clearEvaluationCache, evaluateCells } from './evaluate';
import type { Cell, CellMode, EvalResult } from '../types';

/**
 * 엔진 회귀 테스트.
 *
 * 여기 있는 기대값들은 전부 실측으로 확인한 것이고, 상당수는 Compute Engine 0.90의
 * 함정을 피해가느라 특정 구현을 강제한다. 값이 바뀌면 그건 개선이 아니라 회귀일
 * 가능성이 높으니, 고치기 전에 각 테스트의 주석을 먼저 읽을 것.
 */

let seq = 0;
function cell(input: string, mode: CellMode = 'scoped'): Cell {
  seq += 1;
  return { id: `t${seq}`, input, mode, committed: true };
}

function run(inputs: readonly (string | [string, CellMode])[]): EvalResult[] {
  return evaluateCells(
    inputs.map((i) => (typeof i === 'string' ? cell(i) : cell(i[0], i[1]))),
  );
}

/** 공백과 줄바꿈은 CE 직렬화 재량이라 비교에서 뺀다. */
const norm = (s: string) => s.replace(/\s+/g, '');

function latexOf(result: EvalResult): string {
  if (result.kind !== 'ok') {
    throw new Error(`expected kind 'ok', got '${result.kind}': ${JSON.stringify(result)}`);
  }
  return norm(result.latex);
}

/** 단일 셀을 심볼릭 모드로 평가한다 (정의 참조가 관여하지 않는 케이스용). */
function one(input: string): EvalResult {
  return run([[input, 'symbolic']])[0];
}

const M = {
  a: String.raw`\begin{pmatrix}1 & 1\\1 & 1\end{pmatrix}`,
  b: String.raw`\begin{pmatrix}2 & 2\\2 & 2\end{pmatrix}`,
  p: String.raw`\begin{pmatrix}1 & 2\\3 & 4\end{pmatrix}`,
  q: String.raw`\begin{pmatrix}0 & 1\\0 & 0\end{pmatrix}`,
  wide: String.raw`\begin{pmatrix}1 & 1 & 1\\2 & 2 & 2\end{pmatrix}`,
  rotation: String.raw`\begin{pmatrix}\cos x & -\sin x\\\sin x & \cos x\end{pmatrix}`,
};

describe('스칼라 정리', () => {
  it('같은 항을 합친다', () => {
    expect(latexOf(one('2x+3x'))).toBe('5x');
  });

  it('전개는 하지 않는다', () => {
    // simplify는 "정리"이지 "전개"가 아니다. 사용자가 명시적으로 요구할 때만
    // 전개해야 하므로 이건 의도된 동작이다.
    expect(latexOf(one('(x+1)^2'))).toBe(norm('(x+1)^2'));
  });

  it('유리식을 약분한다', () => {
    // evaluate()를 먼저 돌리면 약분되지 않는다. reduce()의 simplify -> evaluate
    // 순서를 지키는지 감시하는 테스트.
    expect(latexOf(one(String.raw`\frac{x^2-1}{x-1}`))).toBe(norm('x+1'));
  });

  it('삼각 항등식을 정리한다', () => {
    // strategy:'fu' 없이 기본 전략만으로 된다.
    expect(latexOf(one(String.raw`\sin^2 x+\cos^2 x`))).toBe('1');
  });

  it('유리수를 정확히 계산한다 (부동소수로 뭉개지 않는다)', () => {
    expect(latexOf(one(String.raw`\frac{1}{2}+\frac{1}{3}`))).toBe(norm(String.raw`\frac{5}{6}`));
  });

  it('상수는 기호로 유지한다', () => {
    // 6.283... 으로 수치화하면 안 된다. N()이 아니라 evaluate()를 쓰는지 확인.
    expect(latexOf(one(String.raw`2\pi`))).toBe(norm(String.raw`2\pi`));
  });
});

describe('관계식', () => {
  // 관계식에는 simplify를 태우면 안 된다. CE 0.90의 simplify가
  // `x+1=1+x` 를 `NaN=NaN` 으로 바꿔놓고, 그러면 evaluate가 참인 항등식을
  // 거짓으로 판정한다. evaluate만 돌려야 올바르다.

  it.each([
    ['1=1', true],
    ['1=2', false],
    ['2<1', false],
    ['1<2', true],
  ])('%s -> %s', (input, expected) => {
    expect(one(input)).toEqual({ kind: 'boolean', value: expected });
  });

  it('재배열된 항등식도 참으로 판정한다', () => {
    // 이 테스트가 깨지면 관계식에 simplify가 다시 끼어든 것이다.
    expect(one('x+1=1+x')).toEqual({ kind: 'boolean', value: true });
  });

  it('풀 수 없는 방정식은 그대로 둔다', () => {
    // solve는 이번 범위가 아니므로 참/거짓 판정이 아니라 식 자체가 나와야 한다.
    expect(latexOf(one('x^2=4'))).toBe(norm('x^2=4'));
  });

  it('부등식도 미지수가 있으면 그대로 둔다', () => {
    expect(latexOf(one('x<3'))).toBe(norm(String.raw`x\lt3`));
  });
});

describe('행렬', () => {
  it('행렬 곱을 계산한다', () => {
    // simplify만으로는 계산되지 않는다. evaluate가 필요하다.
    expect(latexOf(one(M.a + M.b))).toBe(norm(String.raw`\begin{pmatrix}4 & 4\\4 & 4\end{pmatrix}`));
  });

  it('결과를 List가 아니라 pmatrix로 낸다', () => {
    // evaluate는 ["List",["List",...]] 를 돌려준다. 그대로 두면 `[[4,4],[4,4]]`
    // 로 렌더되므로 asMatrixIfRows가 Matrix로 되감아야 한다.
    const latex = latexOf(one(M.a + M.b));
    expect(latex).toContain('pmatrix');
    expect(latex).not.toContain('lbrack');
  });

  it('행렬 거듭제곱을 계산한다', () => {
    // MatrixPower(...) 가 미계산 상태로 남으면 안 된다.
    expect(latexOf(one(`${M.a}^3`))).toBe(norm(String.raw`\begin{pmatrix}4 & 4\\4 & 4\end{pmatrix}`));
  });

  it('심볼이 든 행렬도 거듭제곱을 전개한다', () => {
    const latex = latexOf(one(`${M.rotation}^3`));
    expect(latex).toContain('pmatrix');
    expect(latex).not.toContain('MatrixPower');
  });

  it('행렬 곱의 비가환성을 지킨다 (pq != qp)', () => {
    // 이 프로젝트에서 가장 중요한 테스트. CE는 곱셈 피연산자를 정렬하므로
    // 순서가 뒤집히면 수학적으로 틀린 답이 나온다.
    const pq = latexOf(one(M.p + M.q));
    const qp = latexOf(one(M.q + M.p));
    expect(pq).toBe(norm(String.raw`\begin{pmatrix}0 & 1\\0 & 3\end{pmatrix}`));
    expect(qp).toBe(norm(String.raw`\begin{pmatrix}3 & 4\\0 & 0\end{pmatrix}`));
    expect(pq).not.toBe(qp);
  });

  it('진짜 리스트는 행렬로 오인하지 않는다', () => {
    const latex = latexOf(one(String.raw`\lbrack 1, 2, 3\rbrack`));
    expect(latex).not.toContain('pmatrix');
  });
});

describe('정의와 변수 바인딩', () => {
  it('정의한 값을 아래 셀에서 쓴다', () => {
    const [, second] = run(['a=3', 'a x + a x']);
    expect(latexOf(second)).toBe('6x');
  });

  it('정의가 다른 정의를 참조한다 (전이 참조)', () => {
    const [, b, third] = run(['a=3', 'b=a+1', 'b x']);
    expect(latexOf(b)).toBe(norm('b = 4'));
    expect(latexOf(third)).toBe('4x');
  });

  it('symbolic 모드에서는 치환하지 않는다', () => {
    const [, second] = run(['a=3', ['a x + a x', 'symbolic']]);
    expect(latexOf(second)).toBe('2ax');
  });

  it('정의 셀에 정의된 이름을 표시한다', () => {
    const [first] = run(['a=3']);
    expect(first).toMatchObject({ kind: 'ok', definitionName: 'a' });
  });

  it('행렬 변수의 곱셈 순서를 보존한다', () => {
    // 심볼을 declare하지 않으면 CE가 `a`를 스칼라로 보고 피연산자를 정렬해
    // `(2x2)a` 가 `a(2x2)` 로 뒤집힌다. 그러면 차원이 안 맞아 계산이 안 되거나
    // 틀린 답이 나온다.
    const [, second] = run([`a=${M.wide}`, M.a + 'a']);
    expect(latexOf(second)).toBe(
      norm(String.raw`\begin{pmatrix}3 & 3 & 3\\3 & 3 & 3\end{pmatrix}`),
    );
  });

  it('한 평가의 심볼 선언이 다음 평가로 새지 않는다', () => {
    // ce.declare는 엔진 전역을 건드리므로 pushScope/popScope로 가둔다.
    // (ce.forget()은 선언을 되돌리지 못한다.)
    run([`a=${M.wide}`]);
    const [onlyCell] = run([['a+1', 'symbolic']]);
    expect(latexOf(onlyCell)).toBe(norm('a+1'));
  });
});

describe('그래프 평가 (순서 비의존)', () => {
  // 캔버스에는 "위/아래"가 없으므로 의존성이 배열 순서가 아니라 이름으로
  // 결정된다. 아래 테스트들이 그 성질을 고정한다.

  it('정의가 아래에 있어도 참조한다', () => {
    // 스택 시절에는 정의가 위에 있어야만 보였다. 이제는 위치와 무관하다.
    const [user] = run(['a x + a x', 'a=3']);
    expect(latexOf(user)).toBe('6x');
  });

  it('정의 순서가 뒤섞여도 전이 참조가 풀린다', () => {
    // 배열 순서는 b -> 사용처 -> a 지만 실제 계산은 a -> b -> 사용처 순이어야 한다.
    const [b, user, a] = run(['b=a+1', 'b x', 'a=3']);
    expect(latexOf(a)).toBe(norm('a = 3'));
    expect(latexOf(b)).toBe(norm('b = 4'));
    expect(latexOf(user)).toBe('4x');
  });

  it('행렬 정의가 아래에 있어도 곱셈 순서를 보존한다', () => {
    // 위상 순서대로 재파싱하므로 참조 셀이 먼저 나와도 declare가 제때 걸린다.
    const [user] = run([M.a + 'a', `a=${M.wide}`]);
    expect(latexOf(user)).toBe(
      norm(String.raw`\begin{pmatrix}3 & 3 & 3\\3 & 3 & 3\end{pmatrix}`),
    );
  });

  it('순환 참조를 감지하고 무한 루프에 빠지지 않는다', () => {
    const [a, b] = run(['a=b+1', 'b=a+1']);
    expect(a).toMatchObject({ kind: 'error' });
    expect(b).toMatchObject({ kind: 'error' });
    expect((a as { message: string }).message).toContain('cyclic');
    expect((a as { message: string }).message).toContain('a, b');
  });

  it('자기 참조도 순환으로 본다', () => {
    // `x=x` 는 자기 자신으로 정의하는 것이라 의미가 없다.
    const [self] = run(['x=x']);
    expect(self).toMatchObject({ kind: 'error' });
  });

  it('순환에 걸리지 않은 셀은 계속 평가한다', () => {
    const [, , ok] = run(['a=b+1', 'b=a+1', '2x+3x']);
    expect(latexOf(ok)).toBe('5x');
  });

  it('같은 이름을 두 곳에서 정의하면 양쪽 다 에러다', () => {
    // 캔버스에는 "나중"이 없으므로 어느 쪽도 이기지 않는다.
    const [first, second] = run(['a=3', 'a=5']);
    expect(first).toMatchObject({ kind: 'error' });
    expect(second).toMatchObject({ kind: 'error' });
    expect((first as { message: string }).message).toContain('duplicate');
  });

  it('충돌한 이름은 바인딩을 만들지 않는다', () => {
    // 어느 값이 맞는지 모르므로 참조하는 쪽은 치환 없이 심볼로 남는다.
    const [, , user] = run(['a=3', 'a=5', 'a x']);
    expect(latexOf(user)).toBe('ax');
  });
});

describe('캐시 정합성', () => {
  // 증분 재계산은 캐시로 구현된다. 캐시 버그는 "조용히 틀린 답"으로 나타나므로
  // 여기서 집중적으로 감시한다.

  it('상류 정의가 바뀌면 하류가 따라 바뀐다', () => {
    // 지문에 의존 대상의 지문이 들어가는지 확인하는 핵심 테스트.
    // 이게 깨지면 a를 고쳐도 ax가 옛날 값을 유지한다.
    expect(latexOf(run(['a=3', 'a x'])[1])).toBe('3x');
    expect(latexOf(run(['a=5', 'a x'])[1])).toBe('5x');
    expect(latexOf(run(['a=3', 'a x'])[1])).toBe('3x');
  });

  it('전이 참조도 끝까지 전파된다', () => {
    expect(latexOf(run(['a=3', 'b=a+1', 'b x'])[2])).toBe('4x');
    expect(latexOf(run(['a=10', 'b=a+1', 'b x'])[2])).toBe('11x');
  });

  it('같은 식이라도 의존 문맥이 다르면 결과가 다르다', () => {
    // 'a x' 라는 같은 latex가 서로 다른 a 값 아래에서 평가된다.
    // 지문이 latex만으로 만들어지면 여기서 오염된다.
    const withThree = latexOf(run(['a=3', 'a x'])[1]);
    const withSeven = latexOf(run(['a=7', 'a x'])[1]);
    expect(withThree).toBe('3x');
    expect(withSeven).toBe('7x');
  });

  it('정의가 사라지면 심볼로 되돌아간다', () => {
    expect(latexOf(run(['a=3', 'a x'])[1])).toBe('3x');
    expect(latexOf(run([['a x', 'scoped']])[0])).toBe('ax');
  });

  it('캐시를 비워도 같은 결과가 나온다', () => {
    const scenario: (string | [string, CellMode])[] = [
      'a=3',
      'b=a+1',
      'b x',
      `p=${M.p}`,
      `q=${M.q}`,
      'pq',
      'x+1=1+x',
      String.raw`\frac{x^2-1}{x-1}`,
    ];
    const cached = run(scenario);
    clearEvaluationCache();
    const cold = run(scenario);
    expect(cold).toEqual(cached);
  });

  it('캐시 적중 시에도 행렬 선언이 유지된다', () => {
    // 캐시에 맞은 정의는 계산을 건너뛰지만 ce.declare는 여전히 걸어야 한다.
    // 안 그러면 두 번째 실행부터 곱셈 순서가 뒤집힌다.
    const expected = norm(String.raw`\begin{pmatrix}3 & 3 & 3\\3 & 3 & 3\end{pmatrix}`);
    expect(latexOf(run([`a=${M.wide}`, M.a + 'a'])[1])).toBe(expected);
    expect(latexOf(run([`a=${M.wide}`, M.a + 'a'])[1])).toBe(expected);
  });
});

describe('에러 처리', () => {
  it('불완전한 식을 에러로 표시하고 죽지 않는다', () => {
    expect(one('x+')).toEqual({ kind: 'error', message: 'unexpected-operator' });
  });

  it('빈 셀은 결과가 없다', () => {
    expect(one('')).toEqual({ kind: 'empty' });
    expect(one('   ')).toEqual({ kind: 'empty' });
  });

  it('미확정 셀은 평가하지 않는다', () => {
    const results = evaluateCells([{ ...cell('2x+3x'), committed: false }]);
    expect(results[0]).toEqual({ kind: 'empty' });
  });

  it('에러 셀이 있어도 다른 셀은 계속 평가한다', () => {
    const [, , third] = run(['a=3', 'x+', 'a x']);
    expect(latexOf(third)).toBe('3x');
  });
});
