import { describe, expect, it } from 'vitest';
import { clearEvaluationCache, evaluateGraph, type EvalInput } from './evaluate';
import type { CellMode, EvalResult } from '../types';

/**
 * 엔진 회귀 테스트.
 *
 * 여기 있는 기대값들은 전부 실측으로 확인한 것이고, 상당수는 Compute Engine 0.90의
 * 함정을 피해가느라 특정 구현을 강제한다. 값이 바뀌면 그건 개선이 아니라 회귀일
 * 가능성이 높으니, 고치기 전에 각 테스트의 주석을 먼저 읽을 것.
 */

let seq = 0;
function input(latex: string, mode: CellMode = 'scoped'): EvalInput {
  seq += 1;
  return { id: `t${seq}`, latex, mode };
}

/** 엔진을 입력 순서대로 평가하고 결과를 그 순서 배열로 되돌린다. */
function run(inputs: readonly (string | [string, CellMode])[]): EvalResult[] {
  const evalInputs = inputs.map((i) =>
    typeof i === 'string' ? input(i) : input(i[0], i[1]),
  );
  const results = evaluateGraph(evalInputs);
  return evalInputs.map((i) => results.get(i.id) ?? { kind: 'empty' });
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

  // A = 행 1,2 교환 순열행렬. A²=I 라서 simplify가 교환법칙 가정으로
  // ABA -> A²B 로 집계하면 결과가 그냥 B가 되는 오답이 나온다.
  const PERM = String.raw`\begin{pmatrix}0 & 1 & 0\\1 & 0 & 0\\0 & 0 & 1\end{pmatrix}`;
  const B3 = String.raw`\begin{pmatrix}1 & 2 & 3\\4 & 5 & 6\\7 & 8 & 9\end{pmatrix}`;
  const ABA = norm(String.raw`\begin{pmatrix}5 & 4 & 6\\2 & 1 & 3\\8 & 7 & 9\end{pmatrix}`);

  it('연속 심볼 행렬 곱의 순서와 반복을 지킨다 (ABA ≠ A²B)', () => {
    const [, , r] = run([`A=${PERM}`, `B=${B3}`, 'ABA']);
    expect(latexOf(r)).toBe(ABA);
  });

  it('정의된 행렬 이름의 괄호 적용은 함수가 아니라 곱셈이다 (A(BA))', () => {
    // A가 matrix로 declare돼 있어도 CE는 A(...)를 함수 적용으로 파싱한다.
    // 우리 정의는 전부 값이므로 곱셈으로 재작성돼야 한다.
    const [, , r] = run([`A=${PERM}`, `B=${B3}`, String.raw`A\left(BA\right)`]);
    expect(latexOf(r)).toBe(ABA);
  });

  // 열벡터 b = (1,2,3)ᵀ. CE는 Transpose(b)를 (b가 matrix declare여도) 행렬로
  // 인정하지 않고 곱을 재배열한다 — b^Tb가 b·b^T로 뒤집히면 스칼라가 아니라
  // 3×3 외적이 나오는 오답. 행렬 경로의 축소 정규화 파싱이 이를 막는다.
  const COLVEC = String.raw`\begin{pmatrix}1\\2\\3\end{pmatrix}`;

  it('b^Tb는 스칼라다 (전치 곱 순서 보존 + 1×1 접기)', () => {
    const [, r] = run([`b=${COLVEC}`, 'b^Tb']);
    expect(latexOf(r)).toBe('14');
  });

  it('bb^T는 3×3 외적이다', () => {
    const [, r] = run([`b=${COLVEC}`, 'bb^T']);
    expect(latexOf(r)).toBe(
      norm(String.raw`\begin{pmatrix}1 & 2 & 3\\2 & 4 & 6\\3 & 6 & 9\end{pmatrix}`),
    );
  });

  it('b^T 단독은 행벡터다', () => {
    const [, r] = run([`b=${COLVEC}`, 'b^T']);
    expect(latexOf(r)).toBe(norm(String.raw`\begin{pmatrix}1 & 2 & 3\end{pmatrix}`));
  });

  it('b^Tb를 정의하면 스칼라로 바인딩돼 이후 스칼라 연산에 쓰인다', () => {
    const [, , r] = run([`b=${COLVEC}`, 'c=b^Tb', 'c x + c x']);
    expect(latexOf(r)).toBe('28x');
  });

  // \cdot/\times는 CE 파싱에서 Multiply로 뭉개져 의미가 사라진다.
  // 행렬 경로에서 마커로 살려 벡터면 Dot/Cross, 아니면 일반 곱으로 해석한다.
  it('벡터 \\cdot 은 내적이다', () => {
    const [, r] = run([`b=${COLVEC}`, String.raw`b\cdot b`]);
    expect(latexOf(r)).toBe('14');
  });

  it('벡터 \\times 는 외적이다 (평행이면 영벡터, e1×e2=e3)', () => {
    const [, r1] = run([`b=${COLVEC}`, String.raw`b\times b`]);
    expect(latexOf(r1)).toBe(norm(String.raw`\begin{pmatrix}0\\0\\0\end{pmatrix}`));
    const e1 = String.raw`\begin{pmatrix}1\\0\\0\end{pmatrix}`;
    const e2 = String.raw`\begin{pmatrix}0\\1\\0\end{pmatrix}`;
    const [, , r2] = run([`u=${e1}`, `v=${e2}`, String.raw`u\times v`]);
    expect(latexOf(r2)).toBe(norm(String.raw`\begin{pmatrix}0\\0\\1\end{pmatrix}`));
  });

  it('행렬 문맥의 스칼라 \\cdot 은 일반 곱셈으로 남는다', () => {
    const [, r] = run([`b=${COLVEC}`, String.raw`2\cdot b`]);
    expect(latexOf(r)).toBe(norm(String.raw`\begin{pmatrix}2\\4\\6\end{pmatrix}`));
  });

  it('스칼라 전용 \\cdot 은 영향 없다 (행렬 경로 밖)', () => {
    expect(latexOf(one(String.raw`2\cdot 3`))).toBe('6');
  });

  // 원소가 심볼인 벡터/행렬 연산. CE는 심볼이어도 정확히 계산하는데(실측),
  // 예전엔 리터럴 게이트가 심볼 벡터를 거부해 마커가 벗겨지거나 전치가 안 접혀
  // 쓰레기가 나왔다. 게이트를 구조 기반으로 완화해 바로잡는다.
  const SYMCOL = (x: string, y: string, z: string) =>
    String.raw`\begin{pmatrix}${x}\\${y}\\${z}\end{pmatrix}`;

  it('심볼 벡터 \\cdot 은 내적이다', () => {
    const [, , r] = run([
      `u=${SYMCOL('x_1', 'y_1', 'z_1')}`,
      `v=${SYMCOL('x_2', 'y_2', 'z_2')}`,
      String.raw`u\cdot v`,
    ]);
    expect(latexOf(r)).toBe(norm('x_1x_2+y_1y_2+z_1z_2'));
  });

  it('심볼 벡터 \\times 는 외적이다', () => {
    // (1,0,x) × (1,1,0) = (0·0-x·1, x·1-1·0, 1·1-0·1) = (-x, x, 1)
    const [, , r] = run([
      `u=${SYMCOL('1', '0', 'x')}`,
      `v=${SYMCOL('1', '1', '0')}`,
      String.raw`u\times v`,
    ]);
    expect(latexOf(r)).toBe(norm(String.raw`\begin{pmatrix}-x\\x\\1\end{pmatrix}`));
  });

  it('심볼 벡터 u^Tv 는 스칼라 내적이다 (전치 곱 → 1×1 접기)', () => {
    const [, , r] = run([
      `u=${SYMCOL('x_1', 'y_1', 'z_1')}`,
      `v=${SYMCOL('x_2', 'y_2', 'z_2')}`,
      'u^Tv',
    ]);
    expect(latexOf(r)).toBe(norm('x_1x_2+y_1y_2+z_1z_2'));
  });

  // 괄호가 계산 순서를 정한다. 예전엔 파싱이 괄호를 평탄화해 마커를 좌→우로 훑는
  // 바람에 `(A×B)·(C×D)` 가 `((A×B)·C)×D` 로 계산됐다 (사용자 보고 버그).
  describe('괄호 우선순위', () => {
    const V3 = (a: string, b: string, c: string) =>
      String.raw`\begin{pmatrix}${a}\\${b}\\${c}\end{pmatrix}`;
    const P = (s: string) => String.raw`\left(${s}\right)`;
    const X = String.raw`\times`;
    const DOT = String.raw`\cdot`;

    it('외적은 결합법칙이 없다 — 괄호 위치에 따라 답이 다르다', () => {
      // A=(1,0,0), B=(1,0,0), C=(0,1,0)
      // A×(B×C) = e1×e3 = -e2 ,  (A×B)×C = 0×e2 = 0
      const [a] = run([V3('1', '0', '0') + X + P(V3('1', '0', '0') + X + V3('0', '1', '0'))]);
      expect(latexOf(a)).toBe(norm(V3('0', '-1', '0')));
      const [b] = run([P(V3('1', '0', '0') + X + V3('1', '0', '0')) + X + V3('0', '1', '0')]);
      expect(latexOf(b)).toBe(norm(V3('0', '0', '0')));
    });

    it('(A×B)·(C×D) 는 스칼라다', () => {
      const [r] = run([
        P(V3('1', '2', '3') + X + V3('1', '1', '0')) +
          DOT +
          P(V3('x', 'y', 'z') + X + V3('x', 'y', 'z')),
      ]);
      expect(latexOf(r)).toBe('0'); // 오른쪽이 영벡터
    });

    it('괄호 안 외적을 먼저 계산한 뒤 내적한다', () => {
      // (-3,3,-1)·((1,2,3)×(x,y,z)) = 11x+8y-9z
      const [r] = run([
        V3('-3', '3', '-1') + DOT + P(V3('1', '2', '3') + X + V3('x', 'y', 'z')),
      ]);
      expect(latexOf(r)).toBe(norm('11x+8y-9z'));
    });

    // 괄호 안이 마커 없는 산술이면 미평가 노드로 남아 모양을 알 수 없다 →
    // 마커가 조용히 버려지고 차원 불일치로 오판됐다(사용자 보고). 값으로 접어야 한다.
    it('괄호 안 산술도 값으로 접어 내적한다', () => {
      const V = (a: string, b: string, c: string) =>
        String.raw`\begin{pmatrix}${a}\\${b}\\${c}\end{pmatrix}`;
      const defs = [`v=${V('x_1', 'y_1', 'z_1')}`, `w=${V('x_2', 'y_2', 'z_2')}`];
      // v·(v+w) = v·v + v·w
      const [, , dot] = run([...defs, String.raw`v\cdot\left(v+w\right)`]);
      expect(latexOf(dot)).toBe(norm('x_1^2+y_1^2+z_1^2+x_1x_2+y_1y_2+z_1z_2'));
      // 숫자로도: (1,2,3)·((1,2,3)+(4,5,6)) = 1·5+2·7+3·9 = 46
      const [, , num] = run([
        `a=${V('1', '2', '3')}`,
        `b=${V('4', '5', '6')}`,
        String.raw`a\cdot\left(a+b\right)`,
      ]);
      expect(latexOf(num)).toBe('46');
    });

    it('괄호 안 외적의 차원이 안 맞으면 에러다', () => {
      const [r] = run([
        V3('-3', '3', '-1') +
          DOT +
          P(V3('1', '2', '3') + X + String.raw`\begin{pmatrix}x\\y\end{pmatrix}`),
      ]);
      expect(r.kind).toBe('error');
    });
  });

  // 행렬 크기는 삽입 후 불변이라 빈 칸이 남을 수 있다. 반쯤 채운 행렬로 계산하면
  // 엉뚱한 답이 나오므로 미완성으로 막는다.
  it('채우지 않은 칸이 있으면 미완성 에러다', () => {
    // 빈 마지막 행은 교정 규칙이 placeholder로 채운다 → 미완성으로 잡힌다
    const [trailing] = run([String.raw`\begin{pmatrix}1\\2\\\end{pmatrix}`]);
    expect(trailing).toMatchObject({ kind: 'error', message: 'incomplete expression' });
    // 마지막 행의 일부 칸만 빈 경우도 마찬가지
    const [partial] = run([String.raw`\begin{pmatrix}1 & 2\\3 & \end{pmatrix}`]);
    expect(partial).toMatchObject({ kind: 'error', message: 'incomplete expression' });
  });

  it('행렬 안에 행렬이 들어가면 에러다', () => {
    const [r] = run([String.raw`\begin{pmatrix}\begin{pmatrix}1\\2\end{pmatrix}\\3\end{pmatrix}`]);
    expect(r.kind).toBe('error');
  });

  // 원소가 값이든 정의된 문자든 미정의 문자든 같은 경로를 타야 한다.
  it('벡터 원소가 값이든 문자든 동작이 같다', () => {
    const V = (a: string) => String.raw`\begin{pmatrix}${a}\\2\\3\end{pmatrix}`;
    const ONES = String.raw`\begin{pmatrix}1\\1\\0\end{pmatrix}`;
    const [, withValue] = run(['a=1', `${V('a')}\\cdot${ONES}`]);
    expect(latexOf(withValue)).toBe('3'); // 정의된 문자 → 값과 같은 결과
    const [literal] = run([`${V('1')}\\cdot${ONES}`]);
    expect(latexOf(literal)).toBe('3');
    const [symbolic] = run([`${V('q')}\\cdot${ONES}`]); // 미정의 문자 → 심볼릭
    expect(latexOf(symbolic)).toBe(norm('q+2'));
  });

  // 차원이 안 맞으면 쓰레기가 아니라 에러다. CE는 곱은 미평가로(에러 없이) 남기고
  // 덧셈/내적/외적은 incompatible-dimensions Error를 낸다 — 둘 다 잡아낸다.
  it('차원 불일치 행렬곱은 에러다', () => {
    const [r] = run([
      String.raw`\begin{pmatrix}1 & 2\\3 & 2\end{pmatrix}\begin{pmatrix}1 & 2 & 3\\4 & 5 & 6\\7 & 7 & 8\end{pmatrix}`,
    ]);
    expect(r.kind).toBe('error');
  });

  it('차원 불일치 행렬 덧셈은 에러다', () => {
    const [r] = run([
      String.raw`\begin{pmatrix}1 & 2\\3 & 2\end{pmatrix}+\begin{pmatrix}1 & 2 & 3\\4 & 5 & 6\\7 & 7 & 8\end{pmatrix}`,
    ]);
    expect(r.kind).toBe('error');
  });

  it('길이가 다른 벡터 내적은 에러다', () => {
    const [, , r] = run([
      `u=${String.raw`\begin{pmatrix}1\\2\end{pmatrix}`}`,
      `v=${COLVEC}`,
      String.raw`u\cdot v`,
    ]);
    expect(r.kind).toBe('error');
  });

  // 불일치 곱이 상위 연산 안에 묻혀도 잡아야 한다. CE는 미평가 곱을 스칼라 취급해
  // broadcast하므로 최상위는 valid List가 된다 — 재귀 스캔이라야 걸린다.
  it('불일치 곱이 덧셈 안에 묻혀도 에러다', () => {
    const [r] = run([
      String.raw`\begin{pmatrix}1 & 2 & 3\\y & x & 54\end{pmatrix}\begin{pmatrix}1 & 2\\y & x\end{pmatrix}+\begin{pmatrix}1 & 2\\y & x\end{pmatrix}`,
    ]);
    expect(r.kind).toBe('error');
  });

  it('불일치 덧셈이 곱 안에 묻혀도 에러다', () => {
    const [r] = run([
      String.raw`2\left(\begin{pmatrix}1 & 2 & 3\\4 & 5 & 6\end{pmatrix}+\begin{pmatrix}1 & 2\\3 & 4\\5 & 6\end{pmatrix}\right)`,
    ]);
    expect(r.kind).toBe('error');
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


  it('에러 셀이 있어도 다른 셀은 계속 평가한다', () => {
    const [, , third] = run(['a=3', 'x+', 'a x']);
    expect(latexOf(third)).toBe('3x');
  });
});
