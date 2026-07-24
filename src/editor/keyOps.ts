import type { MathfieldElement } from 'mathlive';
import { modelOf, type InternalAtom, type InternalModel } from './internals';
import { matchingClose } from './latexScan';
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

const OPEN_KEYS = new Set(['(', '[']);
const CLOSE_KEYS = new Set([')', ']']);

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
 * "캐럿이 들어 있는 구조(소유 atom)를 통째로, 그 branch 내용으로 치환한다."
 * 괄호 벗기기와 첨자 강등이 같은 모양이라 공용으로 쓴다.
 *
 * 명령어 내비게이션(moveToPreviousChar 등) 대신 **모델 오프셋을 직접 계산**한다 —
 * 명령어는 구조 경계에서 엉뚱한 atom을 잡는다(실측).
 */
function replaceOwnerWithBranchContent(ctx: EditContext): boolean {
  const owner = owningAtom(ctx);
  if (owner === undefined) return false;
  const bounds = atomBounds(ctx.model, owner);
  const branch = branchRangeAt(ctx.model, ctx.model.position);
  if (bounds === null || branch === null) return false;
  const content = ctx.mf.getValue({ ranges: [branch] }, 'latex');
  ctx.mf.selection = { ranges: [bounds], direction: 'forward' };
  ctx.mf.insert(content, { insertionMode: 'replaceSelection', selectionMode: 'after' });
  return true;
}

/** run 안에서 마지막 미결 여는 괄호의 인덱스. 없으면 null. */
function lastUnmatchedOpenIndex(latex: string): number | null {
  const stack: number[] = [];
  for (let i = 0; i < latex.length; i += 1) {
    if (latex[i] === '(') stack.push(i);
    else if (latex[i] === ')') stack.pop();
  }
  return stack.length > 0 ? stack[stack.length - 1] : null;
}

/**
 * 선택이 있을 때 여는 구분자를 치면 선택을 감싼다.
 * (MathLive 기본은 선택을 지우고 빈 쌍을 넣는다 — 내용 손실)
 */
const wrapSelection: KeyOp = {
  id: 'wrap-selection',
  summary: '선택 상태에서 여는 구분자를 치면 선택을 감싼다',
  when: (ctx) => OPEN_KEYS.has(ctx.key) && !ctx.collapsed,
  run: (ctx) => {
    const inner = ctx.mf.getValue(ctx.mf.selection, 'latex');
    const close = matchingClose(ctx.key);
    ctx.mf.insert(`\\left${ctx.key}${inner}\\right${close}`, {
      insertionMode: 'replaceSelection',
      selectionMode: 'after',
    });
  },
  scenarios: [
    { start: 'a+b', selection: [0, 3], key: '(', expect: String.raw`\left(a+b\right)` },
    { start: 'x^2', selection: [0, 3], key: '[', expect: String.raw`\left[x^2\right]` },
  ],
};

/**
 * `)` 입력: ① 미결 여는 괄호가 있으면 그것을 닫고 ② 없으면 캐럿 왼쪽 같은 레벨
 * run 전체를 감싸고 ③ 감쌀 것도 없으면 빈 쌍을 만든다 (캐럿은 안쪽).
 * — 어느 경로든 결과는 항상 쌍이다.
 */
const closeDelim: KeyOp = {
  id: 'close-delim',
  summary: '닫는 구분자 입력은 항상 쌍을 만든다 (미결 닫기 / 왼쪽 감싸기 / 빈 쌍)',
  when: (ctx) => CLOSE_KEYS.has(ctx.key) && ctx.collapsed,
  run: (ctx) => {
    const { mf } = ctx;
    const pos = mf.position;
    mf.executeCommand('extendToGroupStart');
    const run = mf.getValue(mf.selection, 'latex');
    mf.position = pos; // 분석 후 복원
    const open = ctx.key === ')' ? '(' : '[';
    const close = ctx.key;
    if (run.trim() === '') {
      // 감쌀 것이 없다 — 여는 구분자를 치면 스마트펜스가 쌍을 만들고 캐럿을
      // 안쪽에 둔다 (실측). 우리가 latex를 직접 넣는 것보다 캐럿이 자연스럽다.
      mf.executeCommand(['typedText', open, { simulateKeystroke: true }]);
      return;
    }
    const openIdx = lastUnmatchedOpenIndex(run);
    mf.executeCommand('extendToGroupStart');
    const replacement =
      openIdx === null
        ? `\\left${open}${run}\\right${close}` // 왼쪽 run 전체 감싸기
        : `${run.slice(0, openIdx)}\\left${open}${run.slice(openIdx + 1)}\\right${close}`;
    mf.insert(replacement, { insertionMode: 'replaceSelection', selectionMode: 'after' });
  },
  scenarios: [
    { start: '', key: ')', expect: String.raw`\left(\right)` },
    { start: 'a+b', key: ')', expect: String.raw`\left(a+b\right)` },
    { start: '(a+b', key: ')', expect: String.raw`\left(a+b\right)` },
  ],
};

/**
 * 여는 구분자 삭제 → 쌍을 함께 벗긴다 (내용 유지).
 * MathLive 기본은 한쪽만 지워 `\left(x\right.` 같은 반쪽을 만든다(실측).
 */
const unwrapOnOpenDelete: KeyOp = {
  id: 'unwrap-open-delete',
  summary: '여는 구분자를 지우면 짝도 함께 사라진다 (내용은 유지)',
  when: (ctx) => {
    if (!ctx.collapsed) return false;
    if (ctx.key !== 'Backspace' && ctx.key !== 'Delete') return false;
    // backspace: 캐럿 왼쪽이 leftright의 시작(=여는 구분자 직후, 내용 맨 앞)
    if (ctx.key === 'Backspace') {
      return atBranchStart(ctx) && atomType(owningAtom(ctx)) === 'leftright';
    }
    // delete: 캐럿 오른쪽 atom이 leftright 전체
    const next = ctx.model.at(ctx.model.position + 1);
    return atomType(next) === 'leftright';
  },
  run: (ctx) => {
    if (ctx.key === 'Backspace') {
      // 캐럿이 쌍 안 맨 앞이다 — 소유한 leftright를 내용으로 치환.
      replaceOwnerWithBranchContent(ctx);
      return;
    }
    // Delete: 캐럿 오른쪽 leftright atom을 통째로 잡아 구분자만 벗긴다.
    const { mf, model } = ctx;
    const next = model.at(model.position + 1);
    if (next === undefined) return;
    const bounds = atomBounds(model, next);
    if (bounds === null) return;
    const whole = mf.getValue({ ranges: [bounds] }, 'latex');
    const inner = whole.replace(/^\\left(\\[a-zA-Z]+|.)/, '').replace(/\\right(\\[a-zA-Z]+|.)$/, '');
    mf.selection = { ranges: [bounds], direction: 'forward' };
    mf.insert(inner, { insertionMode: 'replaceSelection', selectionMode: 'after' });
  },
  scenarios: [
    // `(a+b)` 안 맨 앞에서 backspace → 괄호만 벗겨짐
    { start: String.raw`\left(a+b\right)`, caret: 1, key: 'Backspace', expect: 'a+b' },
  ],
};

/**
 * 닫는 구분자 뒤에서 backspace → 지우지 않고 캐럿만 그룹 안으로 (정책).
 * 미결 괄호가 생기지 않고, 한 번 더 누르면 내용이 지워진다.
 */
const enterGroupOnClose: KeyOp = {
  id: 'enter-group-on-close',
  summary: '닫는 구분자 뒤 backspace는 지우지 않고 커서만 그룹 안으로',
  when: (ctx) => {
    if (!ctx.collapsed || ctx.key !== 'Backspace') return false;
    return atomType(atomBefore(ctx)) === 'leftright';
  },
  run: (ctx) => {
    // 그룹 안 끝으로 (닫는 구분자 바로 앞).
    ctx.mf.executeCommand('moveToPreviousChar');
    ctx.mf.executeCommand('moveToGroupEnd');
  },
  scenarios: [
    // 값은 그대로여야 한다 (캐럿만 이동)
    {
      start: String.raw`\left(a+b\right)`,
      key: 'Backspace',
      expect: String.raw`\left(a+b\right)`,
    },
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
    replaceOwnerWithBranchContent(ctx);
  },
  scenarios: [
    { start: 'e^1', caret: 2, key: 'Backspace', expect: 'e1' },
    { start: 'a_1', caret: 2, key: 'Backspace', expect: 'a1' },
  ],
};

export const KEY_OPS: readonly KeyOp[] = [
  wrapSelection,
  closeDelim,
  unwrapOnOpenDelete,
  enterGroupOnClose,
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
