import {
  applySplices,
  forEachTokenList,
  scanLatex,
  type ScanDoc,
  type Splice,
  type Token,
} from './latexScan';

/**
 * 구조 규칙 레지스트리 — "정상적인 식"의 사양이 여기 데이터로 모여 있다.
 *
 * 규칙을 추가/변경하려면 `RULES`에 항목 하나(+ `examples` 몇 줄)만 넣으면 된다.
 * 테스트가 `examples`를 자동 순회하고, 규칙과 무관한 성질 테스트(멱등·내용 보존
 * 등)가 새 규칙이 기존 불변식을 깨지 않는지 검사한다.
 *
 * **미완성과 파손을 구분한다.** `\placeholder{}`, 빈 분모, 연산자로 끝나는 식은
 * 미완성이며 정상이다(계산만 에러). 여기서 다루는 건 구조가 파손된 경우뿐이다.
 */

export type Violation = {
  ruleId: string;
  /** 원본 문자열에서 문제 구간 (경고 메시지용) */
  start: number;
  end: number;
  detail?: string;
};

export type StructureRule = {
  id: string;
  /** 한 줄 사양 — DEV 경고와 테스트 이름이 재사용한다. */
  summary: string;
  find: (doc: ScanDoc) => Violation[];
  /** 위반 하나를 없애는 splice들. 빈 배열이면 이번 회차에 못 고친 것. */
  fix: (doc: ScanDoc, violation: Violation) => Splice[];
  /** 테스트가 순회하는 사양 예시. */
  examples: { before: string; after: string }[];
};

/** 첨자의 밑이 될 수 있는 토큰인가 (연산자·다른 첨자는 밑이 될 수 없다). */
function canBeBase(token: Token | undefined): boolean {
  if (token === undefined) return false;
  if (token.kind === 'script') return false;
  if (token.kind === 'fenceOpen' || token.kind === 'delimOpen') return false;
  if (token.kind === 'char' && /[+\-*/=<>,;&]/.test(token.text)) return false;
  if (token.kind === 'command' && /^\\(cdot|times|div|pm|mp|le|ge|ne|approx)$/.test(token.text)) {
    return false;
  }
  return true;
}

/** script 토큰 뒤의 내용 토큰 (그룹이면 그룹 전체, 아니면 한 토큰). */
function scriptContent(tokens: Token[], index: number): Token | undefined {
  return tokens[index + 1];
}

const scriptNeedsBase: StructureRule = {
  id: 'script-needs-base',
  summary: '^ 와 _ 는 항상 밑이 있어야 한다 (밑 없으면 첨자를 벗기고 내용을 그 자리로)',
  find: (doc) => {
    const out: Violation[] = [];
    forEachTokenList(doc, (tokens) => {
      tokens.forEach((token, i) => {
        if (token.kind !== 'script') return;
        if (canBeBase(tokens[i - 1])) return;
        const content = scriptContent(tokens, i);
        out.push({
          ruleId: 'script-needs-base',
          start: token.start,
          end: content?.end ?? token.end,
          detail: `밑 없는 ${token.delim}`,
        });
      });
    });
    return out;
  },
  fix: (doc, v) => {
    const scanned = scanLatex(doc.latex);
    let target: { tokens: Token[]; index: number } | null = null;
    forEachTokenList(scanned, (tokens) => {
      tokens.forEach((token, i) => {
        if (token.kind === 'script' && token.start === v.start) target = { tokens, index: i };
      });
    });
    if (target === null) return [];
    const { tokens, index } = target as { tokens: Token[]; index: number };
    const script = tokens[index];
    const content = scriptContent(tokens, index);
    if (content === undefined) {
      // 내용 없는 첨자 — 기호만 지운다.
      return [{ start: script.start, end: script.end, text: '' }];
    }
    // 첨자를 벗기고 내용을 그 자리에 남긴다 (그룹이면 중괄호도 벗김).
    const inner =
      content.kind === 'group'
        ? doc.latex.slice(content.innerStart ?? content.start, content.innerEnd ?? content.end)
        : content.text;
    return [{ start: script.start, end: content.end, text: inner }];
  },
  examples: [
    { before: '^1', after: '1' },
    { before: '_1', after: '1' },
    { before: '^{2y}', after: '2y' },
    { before: 'x+^2', after: 'x+2' },
    { before: 'x^2', after: 'x^2' },
    { before: 'x_1^2', after: 'x_1^2' },
  ],
};

const emptyScript: StructureRule = {
  id: 'empty-script',
  summary: '빈 첨자는 남기지 않는다 (x^{} → x)',
  find: (doc) => {
    const out: Violation[] = [];
    forEachTokenList(doc, (tokens) => {
      tokens.forEach((token, i) => {
        if (token.kind !== 'script') return;
        const content = scriptContent(tokens, i);
        if (content === undefined) return; // script-needs-base 쪽에서 처리
        const isEmptyGroup =
          content.kind === 'group' && (content.children === undefined || content.children.length === 0);
        if (isEmptyGroup) {
          out.push({ ruleId: 'empty-script', start: token.start, end: content.end });
        }
      });
    });
    return out;
  },
  fix: (_doc, v) => [{ start: v.start, end: v.end, text: '' }],
  examples: [
    { before: 'x^{}', after: 'x' },
    { before: 'x_{}', after: 'x' },
    { before: 'x^{2}', after: 'x^{2}' },
  ],
};

/** `\left`/`\right` 짝을 맞춰 고아를 찾는다. */
function fencePairs(tokens: Token[]): { open: Token; close: Token }[] {
  const pairs: { open: Token; close: Token }[] = [];
  const stack: Token[] = [];
  for (const t of tokens) {
    if (t.kind === 'fenceOpen') stack.push(t);
    else if (t.kind === 'fenceClose') {
      const open = stack.pop();
      if (open !== undefined) pairs.push({ open, close: t });
    }
  }
  return pairs;
}

const orphanFence: StructureRule = {
  id: 'orphan-fence',
  summary: '보이지 않는 구분자(\\left. / \\right.)로 반쪽이 된 쌍은 양쪽 다 벗긴다 (내용 유지)',
  find: (doc) => {
    const out: Violation[] = [];
    forEachTokenList(doc, (tokens) => {
      for (const { open, close } of fencePairs(tokens)) {
        if (open.delim !== '.' && close.delim !== '.') continue;
        out.push({
          ruleId: 'orphan-fence',
          start: open.start,
          end: close.end,
          detail: `${open.text} … ${close.text}`,
        });
      }
    });
    return out;
  },
  fix: (doc, v) => {
    const scanned = scanLatex(doc.latex);
    let found: { open: Token; close: Token } | null = null;
    forEachTokenList(scanned, (tokens) => {
      for (const pair of fencePairs(tokens)) {
        if (pair.open.start === v.start) found = pair;
      }
    });
    if (found === null) return [];
    const { open, close } = found as { open: Token; close: Token };
    // 구분자 둘 다 제거, 내용은 그대로 (쌍으로 생성/제거 원칙).
    return [
      { start: close.start, end: close.end, text: '' },
      { start: open.start, end: open.end, text: '' },
    ];
  },
  examples: [
    { before: String.raw`\left(a+b\right.`, after: 'a+b' },
    { before: String.raw`\left.a+b\right)`, after: 'a+b' },
    { before: String.raw`x\left(\right.`, after: 'x' },
    { before: String.raw`\left(a\right)`, after: String.raw`\left(a\right)` },
    // 혼합 구분자는 정상 (구간 표기 등)
    { before: String.raw`\left(0,1\right]`, after: String.raw`\left(0,1\right]` },
  ],
};

const unmatchedDelim: StructureRule = {
  id: 'unmatched-delim',
  summary: '짝 없는 낱개 구분자는 제거한다 — 괄호는 항상 쌍 (내용 유지)',
  find: (doc) => {
    const out: Violation[] = [];
    forEachTokenList(doc, (tokens) => {
      const stack: Token[] = [];
      const unmatchedClose: Token[] = [];
      for (const t of tokens) {
        if (t.kind === 'delimOpen') stack.push(t);
        else if (t.kind === 'delimClose') {
          if (stack.length > 0) stack.pop();
          else unmatchedClose.push(t);
        }
      }
      for (const t of [...stack, ...unmatchedClose]) {
        out.push({ ruleId: 'unmatched-delim', start: t.start, end: t.end, detail: t.text });
      }
    });
    return out;
  },
  fix: (_doc, v) => [{ start: v.start, end: v.end, text: '' }],
  examples: [
    { before: '(a+b', after: 'a+b' },
    { before: 'a+b)', after: 'a+b' },
    { before: 'x)', after: 'x' },
    // 짝이 맞으면 제거 대상이 아니다 (normalize-flat-pair가 fence로 통일한다)
    { before: '(a+b)', after: String.raw`\left(a+b\right)` },
    { before: String.raw`\left(a+b\right)`, after: String.raw`\left(a+b\right)` },
  ],
};

/**
 * 짝이 맞는 평평한 구분자를 `\left…\right` 쌍으로 통일한다.
 *
 * 괄호가 두 가지 표현(평평한 `(x)` / fence `\left(x\right)`)으로 공존하면
 * 편집 연산이 한쪽만 알아본다 — 실제로 factor 결과 `x(x+2)`는 CE가 평평한
 * 괄호로 내놓아서 "여는 괄호 삭제 → 쌍 벗기기"가 동작하지 않았다(실측).
 * 표현을 하나로 모으면 모든 규칙·연산이 균일하게 적용된다.
 */
const normalizeFlatPair: StructureRule = {
  id: 'normalize-flat-pair',
  summary: '짝 맞는 평평한 괄호는 \\left…\\right 쌍으로 통일한다 (표현 단일화)',
  find: (doc) => {
    const out: Violation[] = [];
    forEachTokenList(doc, (tokens) => {
      const stack: Token[] = [];
      for (const t of tokens) {
        if (t.kind === 'delimOpen') stack.push(t);
        else if (t.kind === 'delimClose') {
          const open = stack.pop();
          if (open !== undefined) {
            out.push({
              ruleId: 'normalize-flat-pair',
              start: open.start,
              end: t.end,
              detail: `${open.text}…${t.text}`,
            });
          }
        }
      }
    });
    return out;
  },
  fix: (doc, v) => {
    const scanned = scanLatex(doc.latex);
    let pair: { open: Token; close: Token } | null = null;
    forEachTokenList(scanned, (tokens) => {
      const stack: Token[] = [];
      for (const t of tokens) {
        if (t.kind === 'delimOpen') stack.push(t);
        else if (t.kind === 'delimClose') {
          const open = stack.pop();
          if (open !== undefined && open.start === v.start) pair = { open, close: t };
        }
      }
    });
    if (pair === null) return [];
    const { open, close } = pair as { open: Token; close: Token };
    return [
      { start: close.start, end: close.end, text: `\\right${close.text}` },
      { start: open.start, end: open.end, text: `\\left${open.text}` },
    ];
  },
  examples: [
    { before: 'x(x+2)', after: String.raw`x\left(x+2\right)` },
    { before: '[a]', after: String.raw`\left[a\right]` },
    { before: String.raw`x\left(x+2\right)`, after: String.raw`x\left(x+2\right)` },
  ],
};

export const RULES: readonly StructureRule[] = [
  scriptNeedsBase,
  emptyScript,
  orphanFence,
  normalizeFlatPair,
  unmatchedDelim,
];

/** 등록된 모든 규칙의 위반 (경고·테스트용). */
export function findViolations(latex: string): Violation[] {
  if (latex === '') return [];
  const doc = scanLatex(latex);
  return RULES.flatMap((rule) => rule.find(doc));
}

/** 교정이 또 다른 위반을 만들 수 있으므로 고정점까지 반복한다. */
const MAX_PASSES = 4;

export type RepairResult = { latex: string; changed: boolean; applied: string[] };

export function repairLatex(latex: string): RepairResult {
  let current = latex;
  const applied: string[] = [];
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const doc = scanLatex(current);
    const splices: Splice[] = [];
    const ids: string[] = [];
    for (const rule of RULES) {
      for (const violation of rule.find(doc)) {
        const fix = rule.fix(doc, violation);
        if (fix.length > 0) {
          splices.push(...fix);
          ids.push(rule.id);
        }
      }
    }
    if (splices.length === 0) break;
    const next = applySplices(current, splices);
    if (next === current) break; // 진전 없음 — 무한 루프 방지
    current = next;
    applied.push(...ids);
  }
  return { latex: current, changed: current !== latex, applied: [...new Set(applied)] };
}
