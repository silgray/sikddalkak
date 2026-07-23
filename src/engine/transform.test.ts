import { describe, expect, it } from 'vitest';
import { transformSelection } from './transform';

const norm = (s: string | null) => s?.replace(/\s+/g, '') ?? null;

describe('선택 변환', () => {
  it('전개한다', () => {
    expect(norm(transformSelection('(x+1)^2', 'expand'))).toBe('x^2+2x+1');
    expect(norm(transformSelection('(x+1)^3', 'expand'))).toBe('x^3+3x^2+3x+1');
  });

  it('정리한다', () => {
    expect(norm(transformSelection(String.raw`\frac{x^2-1}{x-1}`, 'simplify'))).toBe('x+1');
    expect(norm(transformSelection(String.raw`\sin^2 x+\cos^2 x`, 'simplify'))).toBe('1');
    expect(norm(transformSelection('2x+3x', 'simplify'))).toBe('5x');
  });

  it('인수분해한다', () => {
    expect(norm(transformSelection('3x^2+3x', 'factor'))).toBe('3x(x+1)');
    expect(norm(transformSelection('x^2-1', 'factor'))).toBe('(x-1)(x+1)');
    expect(norm(transformSelection('x^2+2x+1', 'factor'))).toBe('(x+1)^2');
  });

  it('실질 변화가 없으면 null (버튼 숨김)', () => {
    expect(transformSelection('5x', 'expand')).toBeNull();
    expect(transformSelection('5x', 'factor')).toBeNull();
    expect(transformSelection('3x^2+3x', 'expand')).toBeNull();
  });

  it('정규화만 되는 건 변화가 아니다', () => {
    // 선행 단항 +가 사라지는 것: `+3x^2+3x` -> `3x^2+3x` 는 변환이 아니다.
    // 이걸 변화로 치면 버튼이 뜨고, 치환 시 +가 사라져 앞 항과 곱으로 붙어버린다.
    expect(transformSelection('+3x^2+3x', 'simplify')).toBeNull();
    // 항 재배열만 되는 것도 마찬가지.
    expect(transformSelection('1+x', 'simplify')).toBeNull();
    expect(transformSelection(String.raw`3+\sin(y)+\cos(y)`, 'simplify')).toBeNull();
  });

  it('선행 +로 시작한 선택은 치환도 +로 시작한다 (합류 연산자 보존)', () => {
    // x^3 + [+3x^2+3x] + 1 에서 치환이 3x(x+1)로 시작하면 x^3과 곱으로 붙는다.
    expect(norm(transformSelection('+3x^2+3x', 'factor'))).toBe('+3x(x+1)');
  });

  it('선행 -는 부호가 결과에 흡수되고, 필요하면 +를 붙인다', () => {
    // -3x^2+3x = 3x(1-x): 공통인자 3x 추출. 부호 없이 시작 -> + 합류
    expect(norm(transformSelection('-3x^2+3x', 'factor'))).toBe('+3x(1-x)');
    // -x^2+2x^2 -> x^2: 부호 없이 시작 -> +x^2 로 합류
    expect(norm(transformSelection('-x^2+2x^2', 'simplify'))).toBe('+x^2');
  });

  it('불완전한 선택 조각은 null', () => {
    expect(transformSelection('x+', 'expand')).toBeNull();
    expect(transformSelection('', 'simplify')).toBeNull();
    expect(transformSelection('   ', 'factor')).toBeNull();
  });

  it('평가하지 않는다 — 상수는 기호로 유지', () => {
    // 2\pi 를 6.28... 로 수치화하면 안 된다. 변화 없음 -> null.
    expect(transformSelection(String.raw`2\pi`, 'simplify')).toBeNull();
  });

  it('공통인자 추출: 다변수·비다항 인수도 뽑는다 (CE factor 보강)', () => {
    // CE factor는 단일 변수 다항 지향 — tx^2+tx 같은 다변수 공통인자를 못 뽑는다(실측).
    expect(norm(transformSelection('tx^2+tx', 'factor'))).toBe('tx(x+1)');
    // 글자 그대로 친 cosx(c·o·s·x 곱)의 공통인자
    expect(norm(transformSelection('cosxe^{x}+cosx', 'factor'))).toBe(
      norm(String.raw`cosx(\exponentialE^{x}+1)`),
    );
    // \cos(x) 함수 적용 공통인자 (비다항)
    expect(norm(transformSelection(String.raw`\cos\left(x\right)e^{x}+\cos\left(x\right)`, 'factor'))).toBe(
      norm(String.raw`(\exponentialE^{x}+1)\cos(x)`), // CE 정렬상 몫이 앞에 온다
    );
    // 전부 음수면 부호까지: -3x^2-3x -> -3x(x+1)
    expect(norm(transformSelection('-3x^2-3x', 'factor'))).toBe('-3x(x+1)');
    // 몫에는 CE factor가 이어진다: 2x^2+4x+2 -> 2(x+1)^2
    expect(norm(transformSelection('2x^2+4x+2', 'factor'))).toBe('2(x+1)^2');
  });

  it('행렬 선택: 곱·거듭제곱을 계산해 정리한다 (expand/simplify)', () => {
    const raw = String.raw`\begin{pmatrix}1 & y\\ x & 1\end{pmatrix}\begin{pmatrix}-1 & z\\ 0 & z\end{pmatrix}^2`;
    const out = transformSelection(raw, 'expand');
    expect(out).not.toBeNull();
    // A·B^2, B^2=[[1, z^2-z],[0, z^2]] → [[1, z^2-z+yz^2],[x, xz^2-xz+z^2]]
    expect(norm(out)).toContain(String.raw`\begin{pmatrix}`);
    expect(norm(out)).toBe(
      norm(String.raw`\begin{pmatrix}1 & yz^2+z^2-z\\ x & xz^2+z^2-xz\end{pmatrix}`),
    );
    // simplify도 같은 계산 경로
    expect(norm(transformSelection(raw, 'simplify'))).toBe(norm(out));
  });

  it('행렬 선택: factor는 없음, 변화 없는 단일 행렬은 null', () => {
    const single = String.raw`\begin{pmatrix}1 & x\\ x^2 & -1\end{pmatrix}`;
    expect(transformSelection(single, 'factor')).toBeNull();
    expect(transformSelection(single, 'expand')).toBeNull();
    expect(transformSelection(single, 'simplify')).toBeNull();
  });

  it('복소 계수 전개에 부동소수점 부스러기가 남지 않는다', () => {
    // CE의 expand는 복소 계수를 부동소수점 경로로 계산해 sin^3 계수가
    // -i가 아니라 (-3.9e-21 - i) 처럼 나온다. chop이 이를 정리해야 한다.
    const out = transformSelection(String.raw`(\mathrm{i}\sin x+\cos x)^3`, 'expand');
    expect(out).not.toBeNull();
    expect(out).not.toMatch(/10\^|e-|\d{8,}/); // 지수 표기·긴 가수가 없어야
    expect(norm(out)).toBe(
      norm(String.raw`(-\imaginaryI)\sin(x)^3+\cos(x)^3-3\cos(x)\sin(x)^2+(3\imaginaryI)\sin(x)\cos(x)^2`),
    );
  });
});
