import type { MathfieldElement } from 'mathlive';
import {
  ensureGhostLeftSupport,
  modelOf,
  type InternalAtom,
  type InternalModel,
} from './internals';
import { atomBounds, branchRangeAt, suspendNormalization } from './selection';

/**
 * 키 연산 레지스트리 — "파손을 애초에 만들지 않는" 편집 연산들.
 *
 * [rules.ts](rules.ts)의 구조 규칙이 사후 백스톱이라면, 여기는 예방이다.
 * 캐럿이 자연스러운 자리에 놓이는 것도 여기서 챙긴다.
 *
 * 연산 추가 = `KEY_OPS`에 항목 하나 + `scenarios` 몇 줄 (브라우저 테스트가
 * 시나리오를 자동 순회한다). 정책을 뒤집을 때도 항목 하나만 고치면 된다.
 *
 * 모든 `run`은 MathLive 편집 커맨드/`insert`로만 문서를 바꾼다 — 모델 정합성은
 * MathLive가 지키고, input 이벤트가 한 번만 나서 **실행취소 한 단위**가 된다.
 */

export type EditContext = {
  mf: MathfieldElement;
  model: InternalModel;
  /** 눌린 키 (KeyboardEvent.key) */
  key: string;
  /** 선택이 접혀 있는지 (캐럿 하나) */
  collapsed: boolean;
};

export type KeyOp = {
  id: string;
  summary: string;
  when: (ctx: EditContext) => boolean;
  run: (ctx: EditContext) => void;
  /** 브라우저 테스트가 순회하는 사양. caret은 실행 전 캐럿 오프셋. */
  scenarios: {
    start: string;
    caret?: number;
    /** 선택 범위를 두고 시작하려면 */
    selection?: [number, number];
    key: string;
    expect: string;
  }[];
};

/**
 * 닫는 구분자 키만 우리가 다룬다. **여는 키는 전부 네이티브 smartFence에 맡긴다** —
 * ghost 생성·선택 감싸기·ghost 승격을 이미 다 해준다(조사·실측 확인).
 * `|`는 여닫이 겸용이라 네이티브 특수 처리(집합 기호)가 있어 건드리지 않는다.
 */
const CLOSE_KEYS = new Set([')', ']', '}']);

/** 키 → fence LaTeX 구분자. `\left{` 는 불가라 중괄호는 `\lbrace`/`\rbrace`를 쓴다. */
const FENCE_LATEX: Record<string, { open: string; close: string }> = {
  ')': { open: '(', close: ')' },
  ']': { open: '\\lbrack', close: '\\rbrack' },
  '}': { open: '\\lbrace', close: '\\rbrace' },
};

/** 구분자 종류. 혼합 구분자(`(`…`]`)를 막으려면 종류가 같아야 한다. */
const DELIM_KIND: Record<string, string> = {
  '(': 'paren', ')': 'paren', '\\lparen': 'paren', '\\rparen': 'paren',
  '[': 'bracket', ']': 'bracket', '\\lbrack': 'bracket', '\\rbrack': 'bracket',
  '{': 'brace', '}': 'brace', '\\lbrace': 'brace', '\\rbrace': 'brace',
  '\\{': 'brace', '\\}': 'brace',
  '|': 'bar',
};

const kindOf = (delim: string | undefined): string | undefined =>
  delim === undefined ? undefined : DELIM_KIND[delim];

/**
 * 구분자를 LaTeX에 이어붙일 때의 표기. 명령형(`\lbrack`)은 뒤 글자를 삼키므로
 * (`\left\lbrack` + `x^2` → `\lbrackx^2` 파싱 실패, 실측) 공백을 붙인다.
 */
const delimLatex = (delim: string): string => (delim.startsWith('\\') ? `${delim} ` : delim);

/** 캐럿 왼쪽/오른쪽에 맞닿은 atom. */
function atomBefore(ctx: EditContext): InternalAtom | undefined {
  return ctx.model.at(ctx.model.position);
}

function atomType(atom: InternalAtom | undefined): string {
  return atom?.type ?? '';
}

/** 캐럿이 그룹(분모·첨자 내용 등) 내용의 맨 앞인지. */
function atBranchStart(ctx: EditContext): boolean {
  const here = ctx.model.at(ctx.model.position);
  return atomType(here) === 'first';
}

/** 캐럿이 속한 branch를 소유한 atom (분수·첨자 등). 최상위면 undefined. */
function owningAtom(ctx: EditContext): InternalAtom | undefined {
  return ctx.model.at(ctx.model.position)?.parent ?? undefined;
}

/**
 * 눌린 닫는 키를 **네이티브 smartFence가 승격시킬 fence**가 있는지.
 *
 * 네이티브는 ① 감싸는 fence(조부모까지 거슬러 올라감) ② 같은 레벨에서 뒤로 스캔해
 * 찾은 ghost fence 를 승격 대상으로 삼는다(`insertSmartFence` 조사). 그 중 **종류가
 * 같은** 것이 있으면 우리는 손을 떼고 네이티브에 맡긴다 — ghost 승격, 캐럿 밖으로
 * 빼기, 본문 흡수/축출을 전부 제대로 해준다.
 *
 * 종류가 다르면(예: `(` 안에서 `]`) 대상으로 치지 않는다 → 혼합 구분자가 생기지
 * 않고, 호출부가 `]` 만의 fence를 따로 만든다.
 */
function hasSameKindPromotionTarget(ctx: EditContext): boolean {
  const want = kindOf(ctx.key);
  if (want === undefined) return false;

  // ① 감싸는 fence들 (부모 → 조부모 → …)
  for (
    let owner = owningAtom(ctx);
    owner !== undefined;
    owner = owner.parent ?? undefined
  ) {
    if (atomType(owner) === 'leftright' && kindOf(owner.leftDelim) === want) return true;
  }

  // ② 같은 레벨에서 캐럿 왼쪽으로 스캔해 찾은 ghost fence
  const branch = branchRangeAt(ctx.model, ctx.model.position);
  const start = branch === null ? 0 : branch[0];
  for (let q = ctx.model.position; q >= start; q -= 1) {
    const atom = ctx.model.at(q);
    if (
      atom !== undefined &&
      atomType(atom) === 'leftright' &&
      atom.rightDelim === '?' &&
      kindOf(atom.leftDelim) === want
    ) {
      return true;
    }
  }
  return false;
}

/**
 * "캐럿이 들어 있는 구조(소유 atom)를 통째로, 그 branch 내용으로 치환한다."
 * 괄호 벗기기와 첨자 강등이 같은 모양이라 공용으로 쓴다.
 *
 * 명령어 내비게이션(moveToPreviousChar 등) 대신 **모델 오프셋을 직접 계산**한다 —
 * 명령어는 구조 경계에서 엉뚱한 atom을 잡는다(실측).
 *
 * caret='before'면 치환된 내용 **맨 앞**에 캐럿을 둔다 (첨자 강등 시 커서가
 * "지수였던 자리"에 머물게). 'after'면 내용 뒤 (괄호 벗기기 등 기본).
 */
function replaceOwnerWithBranchContent(ctx: EditContext, caret: 'before' | 'after' = 'after'): boolean {
  const owner = owningAtom(ctx);
  if (owner === undefined) return false;
  const bounds = atomBounds(ctx.model, owner);
  const branch = branchRangeAt(ctx.model, ctx.model.position);
  if (bounds === null || branch === null) return false;
  const content = ctx.mf.getValue({ ranges: [branch] }, 'latex');
  ctx.mf.selection = { ranges: [bounds], direction: 'forward' };
  ctx.mf.insert(content, { insertionMode: 'replaceSelection', selectionMode: 'after' });
  if (caret === 'before') {
    // 치환된 내용은 bounds[0]에서 시작한다 (owner 자리) — 그 앞으로 캐럿을 옮긴다.
    ctx.mf.position = Math.max(0, Math.min(bounds[0], ctx.mf.lastOffset));
  }
  return true;
}

/**
 * 선택 + 닫는 구분자 → 선택을 짝 fence로 감싼다.
 *
 * **여는 키는 네이티브가 이미 잘 한다** (선택을 감싸고 선택 범위까지 유지 — 조사 확인).
 * 반면 닫는 키는 네이티브 버그가 있다: 선택 감싸기 경로가 여닫이 공통인데 닫는 키는
 * 짝 구분자가 `undefined`라 `\left)a+b\right)` 같은 기형이 나온다(실측).
 * 그래서 **닫는 키일 때만** 우리가 가로챈다.
 */
const wrapSelectionOnClose: KeyOp = {
  id: 'wrap-selection-close',
  summary: '선택 상태에서 닫는 구분자를 치면 선택을 짝 fence로 감싼다',
  when: (ctx) => CLOSE_KEYS.has(ctx.key) && !ctx.collapsed,
  run: (ctx) => {
    const { open, close } = FENCE_LATEX[ctx.key];
    const inner = ctx.mf.getValue(ctx.mf.selection, 'latex');
    ctx.mf.insert(`\\left${delimLatex(open)}${inner}\\right${close}`, {
      insertionMode: 'replaceSelection',
      selectionMode: 'after',
    });
  },
  scenarios: [
    { start: 'a+b', selection: [0, 3], key: ')', expect: String.raw`\left(a+b\right)` },
    {
      start: 'x^2',
      selection: [0, 3],
      key: ']',
      expect: String.raw`\left\lbrack x^2\right\rbrack`,
    },
  ],
};

/**
 * 승격할 fence가 없을 때의 닫는 구분자 → **ghost 여는 괄호** fence를 만든다.
 *
 * 여는 괄호의 정확한 거울상이다. 네이티브가 `(` 에서 하는 일(`\left(\right?` 를 넣고
 * **캐럿부터 branch 끝까지** 본문으로 흡수)을 반대 방향으로 한다: `\left?…\right)` 로
 * **branch 시작부터 캐럿까지** 흡수하고, 캐럿은 fence 밖(닫는 구분자 뒤)에 둔다.
 *
 * 네이티브는 닫는 괄호로 ghost를 절대 만들지 않아 짝 없는 `)` 를 그냥 흘린다.
 * 여기서 만든 ghost 왼쪽 구분자는 나중에 `(` 를 치면 **네이티브가 알아서 승격**시킨다
 * (`insertSmartFence` 의 ghost-left 분기들) — 승격 로직은 새로 짤 필요가 없다.
 *
 * 렌더·직렬화는 MathLive가 왼쪽 ghost를 모르므로 `internals.ts` 의 프로토타입 패치가
 * 채운다. 패치가 실패하면 `?` 글리프가 그대로 보이는 깨진 렌더가 되므로, 그때는
 * 이 연산을 켜지 않고(`when` 이 false) 네이티브 기본 동작에 맡긴다.
 */
const closeFence: KeyOp = {
  id: 'close-fence',
  summary: '승격 대상이 없는 닫는 구분자는 ghost 여는 괄호 fence를 만든다',
  when: (ctx) =>
    CLOSE_KEYS.has(ctx.key) &&
    ctx.collapsed &&
    !hasSameKindPromotionTarget(ctx) &&
    ensureGhostLeftSupport(),
  run: (ctx) => {
    const { mf, model } = ctx;
    const { open, close } = FENCE_LATEX[ctx.key];
    const branch = branchRangeAt(model, model.position);
    const start = branch === null ? 0 : branch[0];
    mf.selection = { ranges: [[start, mf.position]], direction: 'forward' };
    const inner = mf.getValue(mf.selection, 'latex');
    // **닫힌** fence를 먼저 넣고 왼쪽만 ghost로 바꾼다. `\left?…` 를 직접 파싱시키면
    // MathLive가 그 원본 문자열을 verbatim 캐시에 담아 직렬화 때 그대로 뱉어서
    // `\left?` 가 문서로 샌다(실측). `isDirty` 로 그 캐시를 버린다.
    mf.insert(`\\left${delimLatex(open)}${inner}\\right${close}`, {
      insertionMode: 'replaceSelection',
      selectionMode: 'after',
    });
    const fence = model.at(mf.position);
    if (fence !== undefined && fence.type === 'leftright') {
      fence.leftDelim = '?';
      fence.isDirty = true;
    }
  },
  scenarios: [
    // ghost 왼쪽 구분자는 직렬화 시 짝으로 나온다 (internals.ts 패치)
    { start: '', key: ')', expect: String.raw`\left(\right)` },
    { start: 'a+b', key: ')', expect: String.raw`\left(a+b\right)` },
    { start: 'x^2', key: ']', expect: String.raw`\left\lbrack x^2\right\rbrack` },
  ],
};

/** 밑 없는 `^`/`_` 입력은 막는다 (정책: 첨자는 항상 밑이 있어야 한다). */
const blockBaselessScript: KeyOp = {
  id: 'block-baseless-script',
  summary: '밑이 없으면 ^ / _ 를 만들 수 없다',
  when: (ctx) => {
    if ((ctx.key !== '^' && ctx.key !== '_') || !ctx.collapsed) return false;
    const before = atomBefore(ctx);
    const type = atomType(before);
    if (type === 'first') return true; // 그룹 맨 앞 — 밑 없음
    if (type === 'mbin' || type === 'mrel' || type === 'mopen') return true; // 연산자 뒤
    return false;
  },
  run: () => {
    // 아무것도 하지 않는다 (입력 차단).
  },
  scenarios: [
    { start: '', key: '^', expect: '' },
    { start: '', key: '_', expect: '' },
    { start: 'x+', key: '^', expect: 'x+' },
  ],
};

/**
 * 첨자 내용 맨 앞에서 backspace → 첨자를 벗기고 내용을 밑 레벨로 내린다.
 * (`e^{|1}` → `e1`) MathLive 기본은 아무것도 안 하고 캐럿만 빠져나온다(실측).
 */
const demoteScriptContent: KeyOp = {
  id: 'demote-script-content',
  summary: '첨자 내용 맨 앞 backspace는 첨자를 벗기고 내용을 밑 레벨로 내린다',
  when: (ctx) => {
    if (!ctx.collapsed || ctx.key !== 'Backspace') return false;
    if (!atBranchStart(ctx)) return false;
    return atomType(owningAtom(ctx)) === 'subsup';
  },
  run: (ctx) => {
    // 첨자 atom을 통째로 그 내용으로 치환 → 내용이 밑 레벨로 내려온다.
    // 커서는 "지수였던 자리"(내용 맨 앞, 밑 바로 뒤)에 머문다.
    replaceOwnerWithBranchContent(ctx, 'before');
  },
  scenarios: [
    { start: 'e^1', caret: 2, key: 'Backspace', expect: 'e1' },
    { start: 'a_1', caret: 2, key: 'Backspace', expect: 'a1' },
  ],
};

export const KEY_OPS: readonly KeyOp[] = [
  wrapSelectionOnClose,
  closeFence,
  blockBaselessScript,
  demoteScriptContent,
];

/**
 * 키 입력을 레지스트리에 넘긴다. 처리했으면 true (호출자가 preventDefault).
 * 내부 API 접근이 실패하면 false — MathLive 기본 동작으로 폴백하고,
 * 구조 규칙이 뒤에서 백스톱한다.
 */
export function dispatchKeyOp(mf: MathfieldElement, key: string): boolean {
  try {
    const model = modelOf(mf);
    if (model === null) return false;
    const ctx: EditContext = { mf, model, key, collapsed: mf.selectionIsCollapsed };
    const op = KEY_OPS.find((candidate) => candidate.when(ctx));
    if (op === undefined) return false;
    // 연산이 고른 범위를 선택 정규화 게이트가 다시 넓히면 안 된다 (selection.ts).
    suspendNormalization(() => op.run(ctx));
    return true;
  } catch {
    return false;
  }
}
