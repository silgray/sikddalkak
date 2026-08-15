import { describe, expect, it } from 'vitest';
import { exprKey } from '../expression/key';
import { render } from '../render';
import { normalizedOf, sameValue } from '../testEnv';
import { prettify } from './prettify';

/**
 * `prettify` 의 안전망.
 *
 * 이 패스는 이제 **모든 결과 렌더 앞에** 깔린다(`cellGraph.ts`·`worker/readSelection.ts`·
 * `index.ts` 의 `transform()`). 정렬 기준(`prettifyOrder.ts`)은 아직 다듬는 중이라 꼴을
 * 통째로 못 박진 않지만, 깨지면 안 되는 **계약 셋**은 여기서 지킨다:
 *
 *  ① 값 — 재정렬은 값을 바꾸지 않는다 (교환 가능한 자리만 건드리므로).
 *  ② 멱등 — 두 번 돌려도 같다. 정렬이 비교기의 비일관성으로 흔들리면 여기서 걸린다.
 *  ③ 참조 보존 — 바뀐 게 없으면 **같은 노드 객체**가 나온다 (`prettify.ts` 서두의 계약).
 *
 * 그 위에 "사람이 읽기 좋아졌는가" 를 보이는 표 테스트를 얹는다 — 이 패스를 왜 넣었는지
 * 가 눈에 보여야 나중에 순서를 손볼 때 무엇을 지키려던 건지 알 수 있다.
 */

/** 정규화된 트리와 그걸 prettify한 트리를 짝으로. */
const pair = (latex: string) => {
  const before = normalizedOf(latex);
  return { before, after: prettify(before) };
};

describe('prettify — 계약', () => {
  const CONTRACT_CASES = [
    '3+2x+x^3',
    'x^{3}+x^{2}+x+1',
    '5x^2y+2xy^2+7',
    'A+aA+2B',
    'v^TAv+a',
    'xy+x+y',
    String.raw`\frac{1}{2}+x`,
    String.raw`\left(A+B\right)C+C`,
    '2ab+3',
    'aAv+v',
  ];

  it.each(CONTRACT_CASES)('값이 그대로다 — %s', (latex) => {
    const { before, after } = pair(latex);
    expect(sameValue(before, after)).toBe(true);
  });

  it.each(CONTRACT_CASES)('멱등이다 — %s', (latex) => {
    const { after } = pair(latex);
    expect(exprKey(prettify(after))).toBe(exprKey(after));
    // 두 번째 호출은 바꿀 게 없으니 참조까지 같아야 한다.
    expect(prettify(after)).toBe(after);
  });

  it.each(CONTRACT_CASES)('렌더가 멱등이다 — %s', (latex) => {
    const { after } = pair(latex);
    const once = render(after);
    expect(render(prettify(normalizedOf(once)))).toBe(once);
  });

  it('이미 보기 좋은 순서면 입력 노드를 그대로 돌려준다', () => {
    // 참조 보존 계약(`prettify.ts:16-19`) — `===` 로 "안 바뀌었다"를 보는 자리가 있다.
    const before = normalizedOf('x+y');
    expect(prettify(before)).toBe(before);
  });

  it('비가환 인수 순서는 절대 안 건드린다', () => {
    // matMul 은 정렬 대상이 아니다 — 여기가 흔들리면 값이 통째로 틀린다.
    const { after } = pair('ABC');
    expect(render(after)).toBe('ABC');
  });
});

describe('prettify — 사람이 읽기 좋은 순서', () => {
  // 왼쪽이 normalize 가 내는 정규 순서(노드 동일성용), 오른쪽이 prettify 뒤의 꼴.
  const TABLE: readonly (readonly [string, string, string])[] = [
    ['상수는 맨 뒤, 높은 차수 먼저', '3+2x+x^3', 'x^{3}+2x+3'],
    ['차수 내림차순', 'x^{3}+x^{2}+x+1', 'x^{3}+x^{2}+x+1'],
    ['여러 변수는 grlex', '5x^2y+2xy^2+7', '5x^{2}y+2xy^{2}+7'],
    ['계수 붙은 항이 맨 앞', 'A+aA+2B', 'aA+A+2B'],
  ];

  it.each(TABLE)('%s', (_name, input, expected) => {
    expect(render(prettify(normalizedOf(input)))).toBe(expected);
  });
});
