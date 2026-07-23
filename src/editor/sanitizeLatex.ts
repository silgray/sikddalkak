/**
 * MathLive 직렬화를 앱 정준형으로 교정하는 순수 함수.
 *
 * MathLive는 `\left(\right)` 쌍에서 괄호 하나를 지우면 남은 쪽을
 * `\left(\right.`(보이지 않는 구분자 `.`)로 직렬화한다 (실측 — backspace/del,
 * 앞/뒤, 내용 유무 모두). 렌더는 멀쩡해 보이지만 CE가 못 읽고, 이후 괄호
 * 편집이 연쇄로 망가진다. 여기서 한쪽이 `.`인 쌍을 평평한 낱개 구분자로
 * 편다: `\left(a+b\right.` → `(a+b`, `\left.a+b\right)` → `a+b)`.
 * 평평한 형태는 재직렬화가 안정적이고(실측: `(a+b` ↔ `(a+b`), 나중에 짝이
 * 입력되면 스마트펜스가 다시 쌍으로 묶는다.
 *
 * 앞으로 발견되는 직렬화 quirk 교정도 전부 이 모듈에 규칙으로 추가한다.
 */

export type SanitizeResult = {
  latex: string;
  changed: boolean;
  /**
   * 마지막으로 교정된 쌍에서 살아남은 쪽. 캐럿 보정 규칙의 근거:
   * 교정 직후 캐럿은 'left'면 그대로, 'right'면 1 줄인다 (실측 기반,
   * 최종적으로 [0, lastOffset]로 클램프).
   */
  survivor: 'left' | 'right' | null;
};

/** `\left`/`\right` 뒤에 오는 구분자 토큰: `\command`, `\{` 류, 낱글자. */
const FENCE_RE = /\\(left|right)(\\[a-zA-Z]+|\\[{}|]|[^a-zA-Z\s])/g;

export function sanitizeLatex(latex: string): SanitizeResult {
  if (!latex.includes('\\left') && !latex.includes('\\right')) {
    return { latex, changed: false, survivor: null };
  }

  type Token = { index: number; length: number; side: 'left' | 'right'; delim: string };
  const tokens: Token[] = [];
  for (const m of latex.matchAll(FENCE_RE)) {
    tokens.push({
      index: m.index,
      length: m[0].length,
      side: m[1] as 'left' | 'right',
      delim: m[2],
    });
  }

  // \left/\right를 짝지어 한쪽이 `.`인 쌍만 골라낸다.
  const rewrites: { token: Token; replacement: string }[] = [];
  let survivor: SanitizeResult['survivor'] = null;
  const stack: Token[] = [];
  for (const token of tokens) {
    if (token.side === 'left') {
      stack.push(token);
      continue;
    }
    const open = stack.pop();
    if (open === undefined) continue; // 고아 \right — 건드리지 않는다 (미지의 형태)
    if (open.delim !== '.' && token.delim !== '.') continue; // 정상 쌍
    // 한쪽(또는 양쪽)이 보이지 않는 구분자 — 평평한 낱개로 편다.
    rewrites.push({ token: open, replacement: open.delim === '.' ? '' : open.delim });
    rewrites.push({ token, replacement: token.delim === '.' ? '' : token.delim });
    survivor = token.delim !== '.' ? 'right' : 'left';
  }

  if (rewrites.length === 0) return { latex, changed: false, survivor: null };

  // 뒤에서부터 치환해 인덱스를 보존한다.
  rewrites.sort((a, b) => b.token.index - a.token.index);
  let out = latex;
  for (const { token, replacement } of rewrites) {
    out = out.slice(0, token.index) + replacement + out.slice(token.index + token.length);
  }
  return { latex: out, changed: true, survivor };
}
