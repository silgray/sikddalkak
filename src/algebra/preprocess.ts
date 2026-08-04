
// 마커 전처리

export const DOT_MARKER = 'algDotMarker';
export const CROSS_MARKER = 'algCrossMarker';

/**
 * `\cdot`/`\times` 는 CE 파싱에서 전부 `Multiply` 로 뭉개져 어느 쪽이었는지 사라진다.
 * 파싱 전에 마커 심볼로 바꿔 살려둔다. (`\cdots` 같은 다른 커맨드를 건드리지 않게
 * 토큰 경계를 확인한다.)
 */
export function preprocess(latex: string): string {
  return latex
    .replace(/\\cdot(?![a-zA-Z])/g, ` \\mathrm{${DOT_MARKER}} `)
    .replace(/\\times(?![a-zA-Z])/g, ` \\mathrm{${CROSS_MARKER}} `);
}


export const isMarker = (json: unknown): json is string =>
  json === DOT_MARKER || json === CROSS_MARKER;