
// 마커 전처리

export const DOT_MARKER = 'algDotMarker';
export const CROSS_MARKER = 'algCrossMarker';

/**
 * `\cdot`/`\times` 는 CE 파싱에서 전부 `Multiply` 로 뭉개져 어느 쪽이었는지 사라진다.
 * 파싱 전에 마커 심볼로 바꿔 살려둔다. (`\cdots` 같은 다른 커맨드를 건드리지 않게
 * 토큰 경계를 확인한다.)
 */
/**
 * `\left(\dfrac{\mathrm{d}}{\mathrm{d}x}\right)^{3}` → `\dfrac{\mathrm{d}^{3}}{\mathrm{d}x^{3}}`.
 *
 * "미분 연산자 자체의 거듭제곱"(N번 미분)을 CE는 못 읽는다(실측: `isValid=false`,
 * `\left(\right)`/맨괄호·`\frac`/`\dfrac` 어느 조합이든 똑같이 막힌다). 반면
 * `\dfrac{\mathrm{d}^N}{\mathrm{d}x^N}` 형태는 CE가 중첩 `D` 로 그대로 읽어준다(실측) —
 * 그래서 파싱 전에 앞의 표기를 뒤의 표기로 고쳐 쓴다. ("미분한 결과를 거듭제곱"하는
 * `\left(\dfrac{\mathrm{d}}{\mathrm{d}x}f\right)^3` 은 본문이 괄호 **안**에 있어 이 패턴에
 * 안 걸린다 — CE가 이미 잘 읽는다.)
 */
const OPERATOR_POWER_RE =
  /(?:\\left)?\(\s*\\d?frac\{\\mathrm\{d\}\}\{\\mathrm\{d\}([a-zA-Z])\}\s*(?:\\right)?\)\^\{?(\d+)\}?/g;

export function preprocess(latex: string): string {
  return latex
    .replace(OPERATOR_POWER_RE, (_, v: string, n: string) => `\\frac{\\mathrm{d}^{${n}}}{\\mathrm{d}${v}^{${n}}}`)
    .replace(/\\cdot(?![a-zA-Z])/g, ` \\mathrm{${DOT_MARKER}} `)
    .replace(/\\times(?![a-zA-Z])/g, ` \\mathrm{${CROSS_MARKER}} `);
}


export const isMarker = (json: unknown): json is string =>
  json === DOT_MARKER || json === CROSS_MARKER;