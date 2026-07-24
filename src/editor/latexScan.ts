/**
 * 아주 작은 LaTeX 구조 스캐너.
 *
 * 구조 규칙(rules.ts)이 딛고 설 기반이다. 목표는 완전한 파서가 아니라
 * **구분자·첨자·그룹의 위치를 아는 것**뿐이다. 그래서:
 *  - 재직렬화하지 않는다. 규칙은 원본 문자열에 대한 `Splice`를 만들고,
 *    적용은 뒤에서부터 — 손대지 않은 부분은 바이트 그대로 보존된다.
 *  - 모르는 명령어는 그냥 토큰 하나로 둔다 (해석하지 않는다).
 */

export type TokenKind =
  /** `\alpha`, `\frac` 같은 명령어 (인자는 뒤따르는 group 토큰들) */
  | 'command'
  /** `{...}` 그룹 */
  | 'group'
  /** `\left(` — `delim`에 구분자 문자 */
  | 'fenceOpen'
  /** `\right)` — `delim`에 구분자 문자 (`.`이면 보이지 않는 구분자) */
  | 'fenceClose'
  /** 평평한 `(` `[` `\{` 등 (스마트펜스를 거치지 않은 낱개 구분자) */
  | 'delimOpen'
  /** 평평한 `)` `]` `\}` */
  | 'delimClose'
  /** `^` 또는 `_` (뒤따르는 토큰이 첨자 내용) */
  | 'script'
  /** 그 외 한 글자 */
  | 'char';

export type Token = {
  kind: TokenKind;
  /** 원본 문자열에서의 [시작, 끝) */
  start: number;
  end: number;
  /** 원본 조각 그대로 */
  text: string;
  /** fence/delim의 구분자 문자, script의 `^`/`_` */
  delim?: string;
  /** group 토큰의 내용물 (중괄호 안) */
  children?: Token[];
  /** group 토큰 내용의 [시작, 끝) — 중괄호 제외 */
  innerStart?: number;
  innerEnd?: number;
};

export type ScanDoc = {
  latex: string;
  /** 최상위 토큰 열 */
  tokens: Token[];
};

/** 원본 문자열의 한 구간을 다른 문자열로 바꾸는 지시. */
export type Splice = { start: number; end: number; text: string };

const OPEN_DELIMS = new Set(['(', '[']);
const CLOSE_DELIMS = new Set([')', ']']);
/** `\left`/`\right` 뒤에 올 수 있는 명령형 구분자. */
const FENCE_COMMANDS = new Set([
  '\\{', '\\}', '\\lbrace', '\\rbrace', '\\langle', '\\rangle',
  '\\lbrack', '\\rbrack', '\\vert', '\\Vert', '\\lvert', '\\rvert', '\\|',
]);

/** 위치 i에서 명령어 하나를 읽는다 (`\` 포함). 없으면 null. */
function readCommand(latex: string, i: number): { text: string; end: number } | null {
  if (latex[i] !== '\\') return null;
  const rest = latex.slice(i + 1);
  const letters = /^[a-zA-Z]+/.exec(rest);
  if (letters !== null) return { text: `\\${letters[0]}`, end: i + 1 + letters[0].length };
  // `\{`, `\|` 같은 한 글자 이스케이프
  if (rest.length > 0) return { text: `\\${rest[0]}`, end: i + 2 };
  return null;
}

/** `\left`/`\right` 바로 뒤의 구분자를 읽는다. */
function readFenceDelim(latex: string, i: number): { delim: string; end: number } | null {
  let p = i;
  while (p < latex.length && /\s/.test(latex[p])) p += 1;
  if (p >= latex.length) return null;
  const cmd = readCommand(latex, p);
  if (cmd !== null) {
    if (!FENCE_COMMANDS.has(cmd.text)) return null;
    return { delim: cmd.text, end: cmd.end };
  }
  const ch = latex[p];
  if (/[a-zA-Z\s]/.test(ch)) return null;
  return { delim: ch, end: p + 1 };
}

function scanTokens(latex: string, from: number, stopAtBrace: boolean): { tokens: Token[]; end: number } {
  const tokens: Token[] = [];
  let i = from;
  while (i < latex.length) {
    const ch = latex[i];
    if (ch === '}' && stopAtBrace) break;

    if (ch === '{') {
      const inner = scanTokens(latex, i + 1, true);
      const closeAt = inner.end; // '}' 위치 (없으면 문자열 끝)
      const end = closeAt < latex.length ? closeAt + 1 : closeAt;
      tokens.push({
        kind: 'group',
        start: i,
        end,
        text: latex.slice(i, end),
        children: inner.tokens,
        innerStart: i + 1,
        innerEnd: closeAt,
      });
      i = end;
      continue;
    }

    if (ch === '^' || ch === '_') {
      tokens.push({ kind: 'script', start: i, end: i + 1, text: ch, delim: ch });
      i += 1;
      continue;
    }

    if (ch === '\\') {
      const cmd = readCommand(latex, i);
      if (cmd === null) {
        tokens.push({ kind: 'char', start: i, end: i + 1, text: ch });
        i += 1;
        continue;
      }
      if (cmd.text === '\\left' || cmd.text === '\\right') {
        const fence = readFenceDelim(latex, cmd.end);
        if (fence !== null) {
          tokens.push({
            kind: cmd.text === '\\left' ? 'fenceOpen' : 'fenceClose',
            start: i,
            end: fence.end,
            text: latex.slice(i, fence.end),
            delim: fence.delim,
          });
          i = fence.end;
          continue;
        }
      }
      tokens.push({ kind: 'command', start: i, end: cmd.end, text: cmd.text });
      i = cmd.end;
      continue;
    }

    if (OPEN_DELIMS.has(ch) || CLOSE_DELIMS.has(ch)) {
      tokens.push({
        kind: OPEN_DELIMS.has(ch) ? 'delimOpen' : 'delimClose',
        start: i,
        end: i + 1,
        text: ch,
        delim: ch,
      });
      i += 1;
      continue;
    }

    tokens.push({ kind: 'char', start: i, end: i + 1, text: ch });
    i += 1;
  }
  return { tokens, end: i };
}

export function scanLatex(latex: string): ScanDoc {
  return { latex, tokens: scanTokens(latex, 0, false).tokens };
}

/** 모든 그룹을 포함해 토큰 열들을 순회한다 (규칙이 레벨별로 검사할 수 있게). */
export function forEachTokenList(doc: ScanDoc, visit: (tokens: Token[]) => void): void {
  const walk = (tokens: Token[]) => {
    visit(tokens);
    for (const t of tokens) if (t.children !== undefined) walk(t.children);
  };
  walk(doc.tokens);
}

/**
 * splice들을 원본에 적용한다. 뒤에서부터 적용해 인덱스가 밀리지 않는다.
 * 겹치는 splice는 뒤쪽을 버린다 (규칙 간 충돌 방어 — 다음 고정점 반복에서 재시도).
 */
export function applySplices(latex: string, splices: readonly Splice[]): string {
  const sorted = [...splices].sort((a, b) => b.start - a.start);
  let out = latex;
  let lastStart = Number.POSITIVE_INFINITY;
  for (const s of sorted) {
    if (s.end > lastStart) continue; // 앞서 적용한 구간과 겹침
    out = out.slice(0, s.start) + s.text + out.slice(s.end);
    lastStart = s.start;
  }
  return out;
}

/** 여는 구분자면 대응하는 닫는 구분자 (짝 만들기용). */
export function matchingClose(open: string): string {
  switch (open) {
    case '(':
      return ')';
    case '[':
      return ']';
    case '\\{':
    case '\\lbrace':
      return '\\}';
    case '\\lbrack':
      return '\\rbrack';
    case '\\langle':
      return '\\rangle';
    case '|':
    case '\\vert':
    case '\\lvert':
      return '|';
    case '\\|':
    case '\\Vert':
      return '\\|';
    default:
      return open;
  }
}
