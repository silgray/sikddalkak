import { describe, expect, it } from 'vitest';
import { parse, render, type Env } from '../index';
import { GREEK_COMMANDS } from './preprocess';

/**
 * 첨자 붙은 그리스 문자가 **심볼 하나**로 살아남는지.
 *
 * CE는 라틴 문자만 통째로 이름을 주고(`a_{xyi}` → `"a_xyi"`) 그리스 문자는
 * `["Subscript","mu",…]` 로 쪼갠다 — 첨자 안 글자들까지 곱으로 읽고 `i` 는 허수로
 * 만든다. `preprocess.ts` 가 파싱 전에 `\mathrm{mu_xyi}` 로 바꿔 그 차이를 없앤다.
 *
 * 이 스위트의 핵심은 **표 전체를 자동으로 훑는 왕복 테스트**다. 그리스 문자마다
 * 렌더 이름이 다르고(`\varepsilon` 은 `epsilonSymbol`, `\Pi` 는 `CapitalPi` 여야
 * 한다, 실측) 손으로 맞춘 표라, 새 항목이 틀리면 여기서 걸린다.
 */

const ENV: Env = { shapes: {} };

const parsed = (latex: string) => parse(latex, ENV);

const rendered = (latex: string): string => {
  const r = parsed(latex);
  if (!r.ok) throw new Error(`parse failed: ${r.errors[0].message}`);
  return render(r.value);
};

describe('그리스 문자 + 첨자 — 표 전체 왕복', () => {
  it.each(GREEK_COMMANDS)(String.raw`\%s_1`, (cmd) => {
    expect(rendered(`\\${cmd}_1`)).toBe(`\\${cmd}_1`);
  });

  it.each(GREEK_COMMANDS)(String.raw`\%s_{xyi} (여러 글자 첨자)`, (cmd) => {
    expect(rendered(`\\${cmd}_{xyi}`)).toBe(`\\${cmd}_{xyi}`);
  });

  it('첨자 없는 그리스 문자는 손대지 않는다 (기존 동작)', () => {
    expect(rendered(String.raw`\mu`)).toBe(String.raw`\mu`);
    expect(rendered(String.raw`\pi`)).toBe(String.raw`\pi`);
  });
});

describe('그리스 문자 + 첨자 — 잎 심볼로 쓰인다', () => {
  const CASES: readonly (readonly [string, string])[] = [
    // 첨자 안의 여러 글자가 곱으로 흩어지지 않는다 (`i` 도 허수가 아니다).
    [String.raw`\mu_{xyi}`, String.raw`\mu_{xyi}`],
    // 한 글자 첨자에도 중괄호가 붙는다 — 숫자 첨자(`\mu_1`)와 갈리는 CE 렌더 재량이고,
    // 다시 읽어도 같은 트리라 왕복은 성립한다.
    [String.raw`\mu_i`, String.raw`\mu_{i}`],
    // 라틴과 똑같이 동작해야 한다는 게 요구사항이었다.
    [String.raw`a_{xyi}`, String.raw`a_{xyi}`],
    // 곱·거듭제곱·분수 어디에 놓여도 원자다.
    [String.raw`2\mu_1`, String.raw`2\mu_1`],
    [String.raw`\mu_1^2`, String.raw`\mu_1^{2}`],
    [String.raw`\mu_1\nu_2`, String.raw`\mu_1\nu_2`],
    // 동류항 판정도 이름 위에서 돈다.
    [String.raw`\mu_1+\mu_1`, String.raw`2\mu_1`],
    [String.raw`\mu_1+\mu_2`, String.raw`\mu_1+\mu_2`],
  ];

  it.each(CASES)('%s → %s', (input, expected) => {
    expect(rendered(input)).toBe(expected);
  });

  it('렌더가 멱등이다', () => {
    for (const [input] of CASES) {
      const once = rendered(input);
      expect(rendered(once)).toBe(once);
    }
  });
});

describe('이름이 될 수 없는 첨자는 오류다', () => {
  const BAD = [
    String.raw`1_{xyz}`, // 밑이 숫자
    String.raw`\mu_{a+b}`, // 첨자가 식
    String.raw`\mu_{\alpha}`, // 첨자가 또 다른 커맨드
  ];

  it.each(BAD)('%s', (latex) => {
    const r = parsed(latex);
    expect(r.ok).toBe(false);
  });
});
