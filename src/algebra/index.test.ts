import { describe, expect, it } from 'vitest';
import { analyze, buildEnv, formatShape, parse, solveFor, transform } from './index';
import { TEST_ENV } from './testEnv';

/**
 * 공개 API 테스트 — 바깥에서 이 모듈을 쓸 때의 모습.
 *
 * 특히 **환경만 바꾸면 같은 식이 다르게 변환되는지**를 본다. 이게 이번 재설계로 고치려던
 * 원래 문제다 (기존 `transformSelection` 은 문맥이 없어 심볼이 행렬인지 알 수 없었다).
 */

describe('transform — LaTeX 들어가고 LaTeX 나온다', () => {
  it('공통 좌인수 추출은 스칼라든 행렬이든 같게 동작한다', () => {
    // 구조적 추출이 먼저라 둘 다 같은 결과가 나온다. CE를 먼저 불렀다면 스칼라 쪽은
    // `AB+AC` 그대로 나왔을 것이다 (CE 0.90은 다변수 공통인수를 못 뽑는다).
    expect(transform('AB+AC', 'factor', TEST_ENV)).toEqual({
      ok: true,
      value: String.raw`A\left(B+C\right)`,
    });
    expect(transform('AB+AC', 'factor', { shapes: {} })).toEqual({
      ok: true,
      value: String.raw`A\left(B+C\right)`,
    });
  });

  it('스칼라일 때만 가능한 정리가 실제로 갈린다', () => {
    // 행렬이면 순서를 바꿀 수 없어 그대로 남는다.
    const asMatrices = transform('AB+BA', 'simplify', TEST_ENV);
    expect(asMatrices.ok && asMatrices.value).toBe('AB+BA');

    // 스칼라라면 교환 가능하므로 합쳐진다.
    const asScalars = transform('AB+BA', 'simplify', { shapes: {} });
    expect(asScalars.ok && asScalars.value).toBe('2AB');
  });

  it('오류는 변환 결과가 아니라 오류로 나온다', () => {
    const result = transform('A+1', 'expand', TEST_ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].code).toBe('shape-mismatch');
  });

  it('모호한 순서도 변환 전에 걸린다', () => {
    const result = transform(String.raw`u\cdot v\times w`, 'expand', TEST_ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].code).toBe('ambiguous-order');
  });
});

describe('buildEnv — LaTeX 정의로 환경 만들기', () => {
  it('행렬·벡터 리터럴에서 모양을 읽는다', () => {
    const { env, unresolved } = buildEnv({
      v: String.raw`\begin{pmatrix}1\\2\\3\end{pmatrix}`,
      A: String.raw`\begin{pmatrix}1&2&3\\4&5&6\\7&8&9\end{pmatrix}`,
      a: '3',
    });
    expect(unresolved).toEqual([]);
    expect(formatShape(env.shapes.v)).toBe('3x1');
    expect(formatShape(env.shapes.A)).toBe('3x3');
    expect(formatShape(env.shapes.a)).toBe('scalar');
  });

  it('서로를 참조하는 정의도 순서와 무관하게 풀린다', () => {
    // `B` 가 `A` 보다 먼저 나오지만 고정점 반복이 알아서 해결한다.
    const { env, unresolved } = buildEnv({
      B: 'A^T',
      A: String.raw`\begin{pmatrix}1&2&3\\4&5&6\end{pmatrix}`,
    });
    expect(unresolved).toEqual([]);
    expect(formatShape(env.shapes.A)).toBe('2x3');
    expect(formatShape(env.shapes.B)).toBe('3x2');
  });

  it('정의로 치환할 수 있다', () => {
    const { env } = buildEnv({ D: 'AB' });
    // D 는 스칼라 A,B 의 곱으로 잡히고, 치환은 그 정의를 그대로 꽂는다.
    const result = transform('Dv', 'substitute', env);
    expect(result.ok && result.value).toBe('ABv');
  });

  it('끝내 정의되지 않는 심볼은 스칼라로 넘어간다', () => {
    // 1판에서는 `a` 를 기다리다 실패하고, 2판에서 스칼라 가정으로 풀린다.
    const { env, unresolved } = buildEnv({
      D: 'aB',
      B: String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`,
    });
    expect(unresolved).toEqual([]);
    expect(formatShape(env.shapes.D)).toBe('2x2');
  });

  it('순환 참조는 여기서 잡지 않는다 — 스칼라 가정으로 풀려버린다', () => {
    // 아무것도 땅에 닿아 있지 않은 순환이라 2판에서 둘 다 스칼라가 된다.
    // 순환 검출은 셀 사이 의존 그래프의 일이지 이 모듈의 일이 아니다 (buildEnv 주석 참고).
    const { env, unresolved } = buildEnv({ P: 'Q^T', Q: 'P^T' });
    expect(unresolved).toEqual([]);
    expect(formatShape(env.shapes.P)).toBe('scalar');
  });

  it('풀 수 없는 정의는 오류 목록으로 남는다', () => {
    const { unresolved } = buildEnv({
      A: String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}+\begin{pmatrix}1\\2\end{pmatrix}`,
    });
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].where).toBe('A');
  });
});

describe('analyze — 단계별 진단', () => {
  it('구조와 해석된 연산·모양을 함께 준다', () => {
    const d = analyze('v^TAv', TEST_ENV);
    expect(d.errors).toEqual([]);
    expect(d.syntax).not.toBeNull();
    expect(d.typed).not.toBeNull();
    expect(d.shape && formatShape(d.shape)).toBe('scalar');
  });

  it('구조는 읽혔지만 모양이 안 맞으면 거기까지 보여준다', () => {
    const d = analyze('A+v', TEST_ENV);
    expect(d.syntax).not.toBeNull(); // 구문은 정상
    expect(d.typed).toBeNull(); // 모양에서 걸렸다
    expect(d.errors[0].code).toBe('shape-mismatch');
  });
});

describe('아직 없는 것', () => {
  it('solveFor 는 자리만 있고 구현은 없다', () => {
    const parsed = parse('x+1', { shapes: {} });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = solveFor(parsed.value, 'x', { shapes: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].code).toBe('unsupported');
  });
});
