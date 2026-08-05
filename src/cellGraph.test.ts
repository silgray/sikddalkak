import { describe, expect, it } from 'vitest';
import { clearCellGraphCache, evaluateCells } from './cellGraph';
import type { EvalResult, FormulaObject } from './types';

/**
 * 그래프 층 회귀 테스트. `engine/evaluate.test.ts` 의 그래프 계약(순서 비의존·순환·
 * 중복정의·캐시 정합성)을 그대로 옮겼다 — 그 파일이 이 작업의 사양서였다. 스칼라
 * 정리·행렬 연산 자체의 세부 계약(CE 함정 회피 등)은 `src/algebra` 쪽 테스트가 이미
 * 촘촘히 덮고 있으므로 여기서 반복하지 않는다.
 *
 * `mode` 는 없다 — 그래프 층은 항상 치환한다(symbolic 모드는 이미 도달 불가능한
 * 죽은 코드였다, `snazzy-baking-flute` 계획 참고).
 */

let seq = 0;
function obj(latex: string): FormulaObject {
  seq += 1;
  return { id: `t${seq}`, latex, mode: 'scoped', resultDetached: false };
}

/** 그래프를 입력 순서대로 평가하고 결과를 그 순서 배열로 되돌린다. */
function run(latexes: readonly string[]): EvalResult[] {
  const objects = latexes.map(obj);
  const { results } = evaluateCells(objects);
  return objects.map((o) => results.get(o.id) ?? { kind: 'empty' });
}

/** 공백과 줄바꿈은 렌더 재량이라 비교에서 뺀다. */
const norm = (s: string) => s.replace(/\s+/g, '');

function latexOf(result: EvalResult): string {
  if (result.kind !== 'ok') {
    throw new Error(`expected kind 'ok', got '${result.kind}': ${JSON.stringify(result)}`);
  }
  return norm(result.latex);
}

function one(latex: string): EvalResult {
  return run([latex])[0];
}

const M = {
  a: String.raw`\begin{pmatrix}1 & 1\\1 & 1\end{pmatrix}`,
  wide: String.raw`\begin{pmatrix}1 & 1 & 1\\2 & 2 & 2\end{pmatrix}`,
};

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

  it('정의 셀에 정의된 이름을 표시한다', () => {
    const [first] = run(['a=3']);
    expect(first).toMatchObject({ kind: 'ok', definitionName: 'a' });
  });

  it('행렬 변수의 곱셈 순서를 보존한다', () => {
    const [, second] = run([`a=${M.wide}`, M.a + 'a']);
    expect(latexOf(second)).toBe(
      norm(String.raw`\begin{pmatrix}3 & 3 & 3\\3 & 3 & 3\end{pmatrix}`),
    );
  });

  it('한 평가가 다음 평가로 새지 않는다', () => {
    // env는 매번 evaluateCells 호출마다 그 objects만으로 새로 만들어진다 — 이전 호출의
    // 정의가 남아 있으면 안 된다(engine은 CE 전역 declare를 pushScope로 가뒀던 자리).
    run([`a=${M.wide}`]);
    const [onlyCell] = run(['a+1']);
    expect(latexOf(onlyCell)).toBe(norm('a+1'));
  });
});

describe('그래프 평가 (순서 비의존)', () => {
  // 캔버스에는 "위/아래"가 없으므로 의존성이 배열 순서가 아니라 이름으로 결정된다.

  it('정의가 아래에 있어도 참조한다', () => {
    const [user] = run(['a x + a x', 'a=3']);
    expect(latexOf(user)).toBe('6x');
  });

  it('정의 순서가 뒤섞여도 전이 참조가 풀린다', () => {
    const [b, user, a] = run(['b=a+1', 'b x', 'a=3']);
    expect(latexOf(a)).toBe(norm('a = 3'));
    expect(latexOf(b)).toBe(norm('b = 4'));
    expect(latexOf(user)).toBe('4x');
  });

  it('행렬 정의가 아래에 있어도 곱셈 순서를 보존한다', () => {
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
    const [self] = run(['x=x']);
    expect(self).toMatchObject({ kind: 'error' });
  });

  it('순환에 걸리지 않은 셀은 계속 평가한다', () => {
    const [, , ok] = run(['a=b+1', 'b=a+1', '2x+3x']);
    expect(latexOf(ok)).toBe('5x');
  });

  it('같은 이름을 두 곳에서 정의하면 양쪽 다 에러다', () => {
    const [first, second] = run(['a=3', 'a=5']);
    expect(first).toMatchObject({ kind: 'error' });
    expect(second).toMatchObject({ kind: 'error' });
    expect((first as { message: string }).message).toContain('duplicate');
  });

  it('충돌한 이름은 바인딩을 만들지 않는다', () => {
    const [, , user] = run(['a=3', 'a=5', 'a x']);
    expect(latexOf(user)).toBe('ax');
  });
});

describe('관계식은 아직 지원하지 않는다', () => {
  it('단일 심볼 정의가 아닌 최상위 `=` 는 오류다', () => {
    expect(one('x^2=4')).toMatchObject({ kind: 'error' });
    expect(one('1=1')).toMatchObject({ kind: 'error' });
  });

  it('부등호도 오류다', () => {
    expect(one('2<1')).toMatchObject({ kind: 'error' });
    expect(one(String.raw`x\geq 1`)).toMatchObject({ kind: 'error' });
  });
});

describe('캐시 정합성', () => {
  it('상류 정의가 바뀌면 하류가 따라 바뀐다', () => {
    expect(latexOf(run(['a=3', 'a x'])[1])).toBe('3x');
    expect(latexOf(run(['a=5', 'a x'])[1])).toBe('5x');
    expect(latexOf(run(['a=3', 'a x'])[1])).toBe('3x');
  });

  it('전이 참조도 끝까지 전파된다', () => {
    expect(latexOf(run(['a=3', 'b=a+1', 'b x'])[2])).toBe('4x');
    expect(latexOf(run(['a=10', 'b=a+1', 'b x'])[2])).toBe('11x');
  });

  it('같은 식이라도 의존 문맥이 다르면 결과가 다르다', () => {
    const withThree = latexOf(run(['a=3', 'a x'])[1]);
    const withSeven = latexOf(run(['a=7', 'a x'])[1]);
    expect(withThree).toBe('3x');
    expect(withSeven).toBe('7x');
  });

  it('정의가 사라지면 심볼로 되돌아간다', () => {
    expect(latexOf(run(['a=3', 'a x'])[1])).toBe('3x');
    expect(latexOf(run(['a x'])[0])).toBe('ax');
  });

  it('캐시를 비워도 같은 결과가 나온다', () => {
    const scenario = ['a=3', 'b=a+1', 'b x', `p=${M.a}`, `q=${M.wide}`, 'x^2=4'];
    const cached = run(scenario);
    clearCellGraphCache();
    const cold = run(scenario);
    expect(cold).toEqual(cached);
  });
});

describe('에러 처리', () => {
  it('불완전한 식(placeholder)을 에러로 표시하고 죽지 않는다', () => {
    expect(one(String.raw`x+\placeholder{}`)).toEqual({
      kind: 'error',
      message: 'incomplete expression',
    });
  });

  it('파싱 불가능한 식도 에러로 표시하고 죽지 않는다', () => {
    expect(one('x+')).toMatchObject({ kind: 'error' });
  });

  it('빈 셀은 결과가 없다', () => {
    expect(one('')).toEqual({ kind: 'empty' });
    expect(one('   ')).toEqual({ kind: 'empty' });
  });

  it('에러 셀이 있어도 다른 셀은 계속 평가한다', () => {
    const [, , third] = run(['a=3', 'x+', 'a x']);
    expect(latexOf(third)).toBe('3x');
  });
});
