import { describe, expect, it } from 'vitest';
import { clearCellGraphCache, evaluateCells } from './cellGraph';
import { SOLVE_ENABLED } from './features';
import type { EvalResult, FormulaObject } from './types';

/**
 * 그래프 층 회귀 테스트. 구 엔진(`src/engine/`, 제거됨)의 그래프 계약(순서 비의존·순환·
 * 중복정의·캐시 정합성)을 그대로 옮겼다 — 그 파일이 이 작업의 사양서였다. 스칼라
 * 정리·행렬 연산 자체의 세부 계약(CE 함정 회피 등)은 `src/algebra` 쪽 테스트가 이미
 * 촘촘히 덮고 있으므로 여기서 반복하지 않는다.
 *
 * `mode` 는 없다 — 그래프 층은 항상 치환한다(symbolic 모드는 이미 도달 불가능한
 * 죽은 코드였다, `snazzy-baking-flute` 계획 참고).
 */

let seq = 0;
function obj(latex: string, enabled = true, solveFor: string | null = null): FormulaObject {
  seq += 1;
  return { id: `t${seq}`, latex, mode: 'scoped', resultDetached: false, enabled, solveFor };
}

/** 그래프를 입력 순서대로 평가하고 결과를 그 순서 배열로 되돌린다. */
function run(latexes: readonly string[]): EvalResult[] {
  const objects = latexes.map((latex) => obj(latex));
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
    // 정의가 남아 있으면 안 된다(구 엔진은 CE 전역 declare를 pushScope로 가뒀던 자리).
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

// SOLVE_ENABLED=false 인 동안(`src/features.ts`) 등식은 예전처럼 부등호와 같은 오류로
// 돌아간다 — CE 0.90이 초월식을 못 풀고 뉴턴 시작점을 넘길 API도 없어서 잠시 꺼둔
// 상태다. 아래 두 describe가 그 두 상태를 각각 지킨다 — 플래그를 켜면 자동으로
// 반대쪽이 돈다.
describe.runIf(!SOLVE_ENABLED)('등식 — SOLVE_ENABLED=false 인 동안은 오류다', () => {
  it('단일 심볼 정의가 아닌 최상위 `=` 도 부등호처럼 오류다', () => {
    expect(one('x^2=4')).toMatchObject({ kind: 'error' });
    expect(one('1=1')).toMatchObject({ kind: 'error' });
  });
});

describe('부등호는 항상 오류다 (플래그와 무관)', () => {
  it('< 와 \\geq', () => {
    expect(one('2<1')).toMatchObject({ kind: 'error' });
    expect(one(String.raw`x\geq 1`)).toMatchObject({ kind: 'error' });
  });
});

describe.skipIf(!SOLVE_ENABLED)('등식 — solve 대상을 안 고르면 결과가 비어 있다', () => {
  it('단일 심볼 정의가 아닌 최상위 `=` 는 오류가 아니라 빈 결과다', () => {
    expect(one('x^2=4')).toEqual({ kind: 'empty' });
    expect(one('1=1')).toEqual({ kind: 'empty' });
  });
});

describe.skipIf(!SOLVE_ENABLED)('등식 — solve for', () => {
  function solveOne(latex: string, symbol: string): EvalResult {
    const object = obj(latex, true, symbol);
    const { results } = evaluateCells([object]);
    return results.get(object.id) ?? { kind: 'empty' };
  }

  it('다중근은 한 줄에 모아 보여준다', () => {
    expect(latexOf(solveOne('x^2=4', 'x'))).toBe(norm('x=2,\\ x=-2'));
  });

  it('미정 심볼이 남아 있으면 수식 해', () => {
    expect(latexOf(solveOne('ax=b', 'x'))).toBe(norm(String.raw`x=\frac{b}{a}`));
  });

  it('참조하는 정의가 전부 리터럴이면 수치 해', () => {
    const a = obj('a=3');
    const b = obj('b=12');
    const eq = obj('ax=b', true, 'x');
    const { results } = evaluateCells([a, b, eq]);
    expect(latexOf(results.get(eq.id)!)).toBe('x=4');
  });

  it('풀 대상 심볼은 다른 셀에 같은 이름의 정의가 있어도 거기 안 먹힌다', () => {
    const x = obj('x=5');
    const eq = obj('2x=8', true, 'x');
    const { results } = evaluateCells([x, eq]);
    // x=5로 치환됐다면 2*5=8이 거짓이라 근이 없어 오류였을 것 — 4가 나와야 옳다.
    expect(latexOf(results.get(eq.id)!)).toBe('x=4');
  });

  it('근이 없으면 오류', () => {
    expect(solveOne('1=2', 'x').kind).toBe('error');
  });

  it('solve 대상을 끄면 다시 결과가 빈다', () => {
    const eq = obj('2x=8', true, 'x');
    const on = evaluateCells([eq]).results.get(eq.id);
    expect(on).toMatchObject({ kind: 'ok' });
    const off = evaluateCells([{ ...eq, solveFor: null }]).results.get(eq.id);
    expect(off).toEqual({ kind: 'empty' });
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

  it('미분 셀이 계산된 뒤 바운드 변수와 같은 이름을 정의하면 다시 계산돼 오류로 바뀐다', () => {
    // freeSymbols가 바운드 이름(x)을 포함해야만 이 시나리오에서 캐시 지문이 바뀐다 —
    // 안 그러면 x=3이 새로 추가돼도 예전에 캐시된 "2x" 결과가 그대로 남는다
    // (src/algebra/transform/evaluate.ts의 collectFreeSymbols 주석 참고).
    const before = run([String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}\left(x^2\right)`])[0];
    expect(latexOf(before)).toBe('2x');
    const [, after] = run(['x=3', String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}\left(x^2\right)`]);
    expect(after).toMatchObject({ kind: 'error' });
  });
});

describe('사용자 정의 함수', () => {
  it('정의한 함수를 호출한다', () => {
    const [, call] = run([String.raw`f\left(x\right)=x^2`, String.raw`f\left(3\right)`]);
    expect(latexOf(call)).toBe('9');
  });

  it('인수는 임의의 식일 수 있다', () => {
    const [, call] = run([String.raw`f\left(x\right)=x^2`, String.raw`f\left(y+1\right)`]);
    expect(latexOf(call)).toBe(norm(String.raw`\left(y+1\right)^{2}`));
  });

  it('인수 여러 개', () => {
    const [, call] = run([String.raw`f\left(x,y\right)=xy`, String.raw`f\left(2,3\right)`]);
    expect(latexOf(call)).toBe('6');
  });

  it('중첩 호출', () => {
    const rows = run([
      String.raw`f\left(x\right)=x^2`,
      String.raw`g\left(x\right)=x+1`,
      String.raw`f\left(g\left(2\right)\right)`,
    ]);
    expect(latexOf(rows[2])).toBe('9');
  });

  it('후위가 apply 바깥에 걸린다 — f(x)^2 는 (f(x))^2', () => {
    const [, call] = run([String.raw`f\left(x\right)=x+1`, String.raw`f\left(2\right)^2`]);
    expect(latexOf(call)).toBe('9');
  });

  it('미분 안의 함수 호출도 전개된다', () => {
    const rows = run([
      String.raw`f\left(x\right)=x^2`,
      String.raw`\dfrac{\mathrm{d}}{\mathrm{d}x}\left(f\left(x\right)\right)`,
    ]);
    expect(latexOf(rows[1])).toBe('2x');
  });

  describe('모양 다형 — 호출부 인수 모양에 따라 갈린다', () => {
    it('스칼라 인수 → 스칼라', () => {
      const rows = run([String.raw`f\left(x\right)=x^2`, String.raw`f\left(3\right)`]);
      expect(rows[1]).toMatchObject({ kind: 'ok' });
    });

    it('정사각 행렬 인수 → 행렬 거듭제곱', () => {
      const rows = run([String.raw`f\left(x\right)=x^2`, `A=${M.a}`, String.raw`f\left(A\right)`]);
      expect(rows[2]).toMatchObject({ kind: 'ok' });
    });

    it('정사각이 아닌 인수 → 오류', () => {
      const rows = run([
        String.raw`f\left(x\right)=x^2`,
        String.raw`v=\begin{pmatrix}1\\2\\3\end{pmatrix}`,
        String.raw`f\left(v\right)`,
      ]);
      expect(rows[2]).toMatchObject({ kind: 'error' });
    });
  });

  it('아직 정의되지 않은 이름은 기존대로 곱(행렬곱)으로 읽힌다', () => {
    const rows = run([`A=${M.a}`, String.raw`v=\begin{pmatrix}1\\1\end{pmatrix}`, String.raw`A\left(v\right)`]);
    expect(rows[2]).toMatchObject({ kind: 'ok' });
  });

  it('인수 개수가 안 맞으면 오류다', () => {
    const rows = run([String.raw`f\left(x,y\right)=x+y`, String.raw`f\left(1\right)`]);
    expect(rows[1]).toMatchObject({ kind: 'error' });
    expect((rows[1] as { message: string }).message).toContain('f');
  });

  it('변수와 함수는 한 이름 공간이다 — 같은 이름이면 둘 다 에러', () => {
    const rows = run(['a=3', String.raw`a\left(x\right)=x`]);
    expect(rows[0]).toMatchObject({ kind: 'error' });
    expect(rows[1]).toMatchObject({ kind: 'error' });
    expect((rows[0] as { message: string }).message).toContain('duplicate');
  });

  it('매개변수 이름이 다른 정의와 겹치면 에러', () => {
    const rows = run(['x=5', String.raw`f\left(x\right)=x^2`]);
    expect(rows[1]).toMatchObject({ kind: 'error' });
  });

  it('서로 다른 함수는 같은 매개변수 이름을 써도 된다', () => {
    const rows = run([
      String.raw`f\left(x\right)=x^2`,
      String.raw`g\left(x\right)=x+1`,
      String.raw`f\left(2\right)+g\left(2\right)`,
    ]);
    expect(latexOf(rows[2])).toBe('7');
  });

  it('자기 참조 함수 정의는 순환으로 본다', () => {
    const [self] = run([String.raw`f\left(x\right)=f\left(x-1\right)+1`]);
    expect(self).toMatchObject({ kind: 'error' });
  });

  it('정의 셀은 정리하지 않고 본문을 그대로 보여준다', () => {
    const [def] = run([String.raw`f\left(x\right)=x+x`]);
    expect(latexOf(def)).toBe(norm(String.raw`f\left(x\right)=x+x`));
  });

  it('함수 셀을 고치면 호출 셀도 다시 계산된다 (캐시 지문)', () => {
    expect(
      latexOf(run([String.raw`f\left(x\right)=x^2`, String.raw`f\left(3\right)`])[1]),
    ).toBe('9');
    expect(
      latexOf(run([String.raw`f\left(x\right)=x^3`, String.raw`f\left(3\right)`])[1]),
    ).toBe('27');
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

describe('셀 비활성화 (enabled)', () => {
  it('꺼진 셀은 결과가 비어 있다', () => {
    const objects = [obj('2+2', false)];
    const { results } = evaluateCells(objects);
    expect(results.get(objects[0].id)).toEqual({ kind: 'empty' });
  });

  it('꺼진 정의 셀은 다른 셀에 값을 전달하지 않는다 — 이름이 아예 없던 것처럼', () => {
    const objects = [obj('a=3', false), obj('a x')];
    const { results } = evaluateCells(objects);
    // 정의가 꺼졌으니 `a`는 미정의 심볼 취급 — 스칼라로 가정돼 그대로 남는다(오류 아님).
    expect(latexOf(results.get(objects[1].id)!)).toBe('ax');
  });

  it('같은 이름을 정의하는 셀이 꺼져 있으면 중복정의로 안 잡힌다', () => {
    const objects = [obj('a=3', false), obj('a=5'), obj('a x')];
    const { results } = evaluateCells(objects);
    expect(results.get(objects[1].id)).toMatchObject({ kind: 'ok' });
    expect(latexOf(results.get(objects[2].id)!)).toBe('5x');
  });

  it('꺼진 셀을 다시 켜면 그래프에 다시 들어간다', () => {
    const off = obj('a=3', false);
    const dependent = obj('a x');
    const { results: before } = evaluateCells([off, dependent]);
    expect(latexOf(before.get(dependent.id)!)).toBe('ax');

    const { results: after } = evaluateCells([{ ...off, enabled: true }, dependent]);
    expect(latexOf(after.get(dependent.id)!)).toBe('3x');
  });
});
