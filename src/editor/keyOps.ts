import type { MathfieldElement } from 'mathlive';
import {
  captureGhostFlags,
  ensureGhostLeftSupport,
  modelOf,
  restoreGhostFlags,
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
 * 눌린 닫는 키로 **네이티브가 실제로 승격시킬 ghost fence**가 있는지.
 *
 * ⚠ "같은 종류 fence가 감싸고 있으면 위임"으로 넓게 잡으면 안 된다. 네이티브가
 * 승격시키는 건 그 fence가 **ghost일 때뿐**이고, 진짜 fence에서는 전혀 다른 짓을
 * 한다(실측):
 *   - 캐럿이 본문 **끝**: 타이핑 오버 — 캐럿만 밖으로 빼고 새 괄호를 안 만든다.
 *     (여는 괄호는 같은 자리에서 새 중첩 fence를 만드는데, 이러면 여닫이가 비대칭)
 *   - 캐럿이 본문 **중간**: 승격에 실패해 평범한 `)` 를 삽입 → 짝이 없어
 *     `rules.ts` 의 `unmatched-delim` 이 지운다 = 입력이 취소된 것처럼 보인다.
 * 그래서 **ghost일 때만** 위임하고, 진짜 fence면 호출부가 새 fence를 만든다.
 *
 * 종류가 다르면(예: `(` 안에서 `]`) 대상으로 치지 않는다 → 혼합 구분자가 생기지
 * 않고, 호출부가 `]` 만의 fence를 따로 만든다.
 */
function hasGhostPromotionTarget(ctx: EditContext): boolean {
  const want = kindOf(ctx.key);
  if (want === undefined) return false;

  // ① 감싸는 fence — **처음 만나는 같은 종류**에서 판정을 끝낸다. 진짜 fence를
  //    건너뛰고 더 바깥 ghost를 찾으면 안 된다: 네이티브도 안쪽 진짜 fence에서
  //    먼저 타이핑 오버를 해버려 바깥까지 가지 않는다.
  for (let owner = owningAtom(ctx); owner !== undefined; owner = owner.parent ?? undefined) {
    if (atomType(owner) !== 'leftright') continue;
    if (kindOf(owner.leftDelim) !== want) continue;
    return owner.rightDelim === '?';
  }

  // ② 캐럿 **바로 왼쪽**의 ghost fence (인접할 때만).
  //    멀리까지 뒤로 스캔하면 안 된다: 네이티브는 찾은 ghost를 승격시키면서
  //    **그 사이의 내용을 전부 자기 본문으로 흡수**한다(`extractAtoms`). 그래서
  //    `()?()?()` 뒤에서 `)` 를 치면 두 번째 ghost가 세 번째 fence를 삼켜
  //    `()?(())` 가 됐다. 인접이 아니면 위임하지 않고 호출부가 전체를 감싼다.
  const left = ctx.model.at(ctx.model.position);
  return (
    left !== undefined &&
    atomType(left) === 'leftright' &&
    left.rightDelim === '?' &&
    kindOf(left.leftDelim) === want
  );
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
 * 삭제 대상 fence와 캐럿이 갈 쪽. 네 자리에서만 성립한다:
 *
 * | 키 | 캐럿 위치 | 지우는 쪽 | 캐럿 |
 * |---|---|---|---|
 * | Backspace | fence 본문 시작 | 여는 쪽 | 내용 맨 앞 |
 * | Delete    | fence 바로 앞   | 여는 쪽 | 내용 맨 앞 |
 * | Delete    | fence 본문 끝   | 닫는 쪽 | 내용 맨 뒤 |
 * | Backspace | fence 바로 뒤   | 닫는 쪽 | 내용 맨 뒤 |
 */
function fenceDeletionAt(ctx: EditContext): { fence: InternalAtom; caret: 'start' | 'end' } | null {
  if (!ctx.collapsed) return null;
  const { model } = ctx;
  const pos = model.position;

  if (ctx.key === 'Backspace') {
    const here = model.at(pos);
    // 캐럿 바로 왼쪽이 fence 전체 → 닫는 쪽을 지운다.
    if (atomType(here) === 'leftright' && here !== undefined) return { fence: here, caret: 'end' };
    // 본문 맨 앞 → 여는 쪽을 지운다.
    const owner = owningAtom(ctx);
    if (atBranchStart(ctx) && atomType(owner) === 'leftright' && owner !== undefined) {
      return { fence: owner, caret: 'start' };
    }
    return null;
  }

  if (ctx.key === 'Delete') {
    const next = model.at(pos + 1);
    if (next === undefined) return null;
    // 본문 끝: 자식이 부모보다 먼저 오므로 `at(pos + 1)` 이 **자기를 감싼** fence다.
    if (atomType(next) === 'leftright' && owningAtom(ctx) === next) {
      return { fence: next, caret: 'end' };
    }
    // fence 바로 앞: 오른쪽 fence의 **본문 첫 자리**가 먼저 온다(그 부모가 fence).
    const owner = next.parent ?? undefined;
    if (
      atomType(next) === 'first' &&
      atomType(owner) === 'leftright' &&
      owner !== undefined &&
      owningAtom(ctx) !== owner
    ) {
      return { fence: owner, caret: 'start' };
    }
    return null;
  }

  return null;
}

/**
 * fence atom을 그 **본문 내용으로 치환**하고 캐럿을 지정한 쪽에 둔다.
 *
 * 캐럿을 여기서 직접 정하는 게 핵심이다. 네이티브에 맡기면 반쪽 fence(`\left.`)가
 * 남고, 그걸 교정 규칙이 지우면서 LaTeX이 바뀌어 캐럿을 **문자열로 다시 추측**해야
 * 하는데, 구조 경계에서는 그 추측이 원리적으로 불가능하다(같은 내용 카운트를 갖는
 * 위치가 여럿). 여기서 없애면 그 추측 자체가 필요 없다.
 */
function unwrapFence(ctx: EditContext, fence: InternalAtom, caret: 'start' | 'end'): boolean {
  const { mf, model } = ctx;
  const bounds = atomBounds(model, fence);
  if (bounds === null) return false;
  // 자식이 부모보다 먼저 오는 순서라 `bounds[0] + 1` 이 본문의 첫 자리다.
  const body = branchRangeAt(model, bounds[0] + 1);
  if (body === null) return false;

  const content = mf.getValue({ ranges: [body] }, 'latex');
  // 치환은 LaTeX 왕복이라 안쪽 ghost가 확정돼버린다 — 상태를 떠뒀다 되돌린다.
  const ghosts = captureGhostFlags(model, body);

  mf.selection = { ranges: [bounds], direction: 'forward' };
  // 빈 본문(`(())`)이면 내용이 `''` 이라 fence만 사라진다 — 같은 경로로 처리된다.
  mf.insert(content, { insertionMode: 'replaceSelection', selectionMode: 'after' });
  const contentEnd = mf.position; // insert 후 캐럿은 내용 뒤
  restoreGhostFlags(model, [bounds[0], contentEnd], ghosts);

  const clamp = (q: number) => Math.max(0, Math.min(q, mf.lastOffset));
  mf.position = caret === 'start' ? clamp(bounds[0]) : clamp(contentEnd);
  return true;
}

/**
 * 괄호 구분자를 지우면 **쌍이 함께** 사라지고 내용은 남는다 (프로젝트 정책).
 *
 * 네이티브 `onDelete` 는 한쪽만 `.` 로 만들어 반쪽 fence를 남기고, 그걸 `rules.ts` 의
 * `orphan-fence` 가 뒤늦게 치우는 구조였다. 결과는 같지만 그 과정에서 문서 LaTeX이
 * 바뀌어 **캐럿을 다시 추측**해야 했고, 그 추측이 구조 경계에서 계속 틀렸다.
 * 여기서 한 번에 처리하면 반쪽 fence도, 추측도 생기지 않는다.
 * (`rules.ts` 의 백스톱은 붙여넣기·저장본 대비로 그대로 남는다.)
 */
const deleteFencePair: KeyOp = {
  id: 'delete-fence-pair',
  summary: '구분자를 지우면 괄호 쌍이 함께 사라지고 캐럿은 내용의 그 자리에 남는다',
  when: (ctx) => fenceDeletionAt(ctx) !== null,
  run: (ctx) => {
    const target = fenceDeletionAt(ctx);
    if (target === null) return;
    unwrapFence(ctx, target.fence, target.caret);
  },
  scenarios: [
    // 여는 쪽 삭제 — 내용은 남고 캐럿은 내용 맨 앞
    { start: String.raw`\left(a+b\right)`, caret: 1, key: 'Backspace', expect: 'a+b' },
    // 닫는 쪽 삭제 — fence 바로 뒤에서
    { start: String.raw`\left(a+b\right)`, caret: 5, key: 'Backspace', expect: 'a+b' },
    // Delete: fence 바로 앞에서 여는 쪽
    { start: String.raw`x\left(a\right)`, caret: 1, key: 'Delete', expect: 'xa' },
    // 빈 본문 중첩 — 한 겹만 벗겨진다
    {
      start: String.raw`\left(\left(\right)\right)`,
      caret: 2,
      key: 'Backspace',
      expect: String.raw`\left(\right)`,
    },
  ],
};

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
    const { mf, model } = ctx;
    const { open, close } = FENCE_LATEX[ctx.key];
    const inner = mf.getValue(mf.selection, 'latex');
    const ghosts = captureGhostFlags(model, mf.selection.ranges[0]);
    mf.insert(`\\left${delimLatex(open)}${inner}\\right${close}`, {
      insertionMode: 'replaceSelection',
      selectionMode: 'after',
    });
    // 감싼 **본문을 다시 선택**해 여는 키와 동작을 맞춘다 (네이티브도 선택을 유지한다).
    // insert 후 캐럿은 fence 바로 뒤이므로 `position - 1` 은 본문 안(마지막 본문 atom)이다.
    const body = branchRangeAt(model, mf.position - 1);
    if (body === null) return;
    restoreGhostFlags(model, body, ghosts);
    mf.selection = { ranges: [body], direction: 'forward' };
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
    !hasGhostPromotionTarget(ctx) &&
    ensureGhostLeftSupport(),
  run: (ctx) => {
    const { mf, model } = ctx;
    const { open, close } = FENCE_LATEX[ctx.key];
    const branch = branchRangeAt(model, model.position);
    const start = branch === null ? 0 : branch[0];
    mf.selection = { ranges: [[start, mf.position]], direction: 'forward' };
    const inner = mf.getValue(mf.selection, 'latex');
    // 감싸는 동안 안쪽 ghost가 직렬화로 확정되는 걸 막으려고 상태를 떠둔다.
    const ghosts = captureGhostFlags(model, [start, mf.position]);
    // **닫힌** fence를 먼저 넣고 왼쪽만 ghost로 바꾼다. `\left?…` 를 직접 파싱시키면
    // MathLive가 그 원본 문자열을 verbatim 캐시에 담아 직렬화 때 그대로 뱉어서
    // `\left?` 가 문서로 샌다(실측). `isDirty` 로 그 캐시를 버린다.
    mf.insert(`\\left${delimLatex(open)}${inner}\\right${close}`, {
      insertionMode: 'replaceSelection',
      selectionMode: 'after',
    });
    const body = branchRangeAt(model, mf.position - 1);
    if (body !== null) restoreGhostFlags(model, body, ghosts);
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

/**
 * `\` 입력을 통째로 막는다.
 *
 * MathLive에서 `\` 는 **LaTeX 모드로 들어가는 유일한 문**이다. 그 모드는 명령어를
 * 직접 타이핑하는 자리라 이 앱의 입력 모델(인라인 숏컷·키바인딩·툴바)과 겹치고,
 * 반쯤 친 명령어가 문서에 남으면 구조 규칙도 계산도 다룰 수 없는 꼴이 된다.
 * 앞서 자동완성 팝오버만 껐지만(`MathField.tsx` 의 `popoverPolicy`), 모드 자체는
 * 그대로였다 — 여기서 키를 아예 삼킨다.
 *
 * 선택이 있든 없든 막는다(`collapsed` 를 안 본다) — 선택 위에서 쳐도 마찬가지다.
 */
const blockBackslash: KeyOp = {
  id: 'block-backslash',
  summary: '`\\` 는 입력할 수 없다 (LaTeX 모드 차단)',
  when: (ctx) => ctx.key === '\\',
  run: () => {
    // 아무것도 하지 않는다 (입력 차단).
  },
  scenarios: [
    { start: '', key: '\\', expect: '' },
    { start: 'x+1', key: '\\', expect: 'x+1' },
    { start: 'x+1', selection: [0, 3], key: '\\', expect: 'x+1' },
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

const PLACEHOLDER_LATEX = '\\placeholder{}';

/**
 * 캐럿이 든 branch의 내용이 **`\placeholder{}` 하나뿐**인가 — 즉 "비어 있음이
 * 눈에 보이게 표시된" 상태인가.
 */
function branchIsJustPlaceholder(ctx: EditContext): boolean {
  const branch = branchRangeAt(ctx.model, ctx.model.position);
  if (branch === null) return false;
  return ctx.mf.getValue({ ranges: [branch] }, 'latex').trim() === PLACEHOLDER_LATEX;
}

/**
 * 이 자리의 placeholder가 **지울 수 없는** 것인가.
 *
 * `\int`/`\sum`/`\prod` 계열은 위·아래 범위가 **항상** 있어야 하는 표기라, 범위를
 * 비웠다고 기호까지 사라지면 안 된다. MathLive는 이 기호들을 `extensible-symbol`
 * atom 하나로 두고 첨자를 그 atom의 branch로 단다(실측) — 반면 보통 거듭제곱은
 * 별도 `subsup` atom이다. 그래서 소유 atom의 **타입 하나**로 정확히 갈린다
 * (`\int \sum \prod \oint \bigcup …` 목록을 따로 들고 다닐 필요가 없다).
 */
function isProtectedSlot(ctx: EditContext): boolean {
  return atomType(owningAtom(ctx)) === 'extensible-symbol';
}

/** 삭제 방향 키 둘. placeholder 자리에서는 둘 다 "이 자리를 지운다"는 뜻이다. */
const DELETE_KEYS = new Set(['Backspace', 'Delete']);

/**
 * 지우는 쪽의 **반대편 첨자**를 다시 붙일 LaTeX (`_1` / `^{2}`). 없으면 빈 문자열.
 *
 * ⚠ MathLive는 위·아래 첨자를 **한 `subsup` atom** 이 함께 들고 있다(실측). 그래서
 * "이 첨자를 지운다" 를 atom 통째 삭제로 구현하면 **반대쪽까지 같이 사라진다**
 * (사용자 보고: `x_1^{▢}` 에서 지수를 지우면 `_1` 도 없어졌다). 살릴 쪽을 꺼내
 * 다시 붙여 넣는다.
 */
function survivingScriptLatex(ctx: EditContext, owner: InternalAtom, branch: string): string {
  const otherKey = branch === 'superscript' ? 'subscript' : 'superscript';
  const atoms = owner[otherKey];
  // 첫 원소는 `first` 센티넬 — 그것뿐이면 그쪽은 비어 있다.
  if (atoms === undefined || atoms.length <= 1) return '';
  const inside = ctx.model.offsetOf(atoms[atoms.length - 1]);
  if (inside < 0) return '';
  const range = branchRangeAt(ctx.model, inside);
  if (range === null) return '';
  const content = ctx.mf.getValue({ ranges: [range] }, 'latex').trim();
  if (content === '') return '';
  return `${otherKey === 'superscript' ? '^' : '_'}{${content}}`;
}

/**
 * 빈 자리(placeholder)에서 한 번 더 지우면 **구조까지** 사라진다 —
 * `e^{|\placeholder{}}` + Backspace → `e`.
 *
 * 정책: 첨자·`\overline` 의 내용을 다 지우면 `rules.ts` 의 `empty-script`/
 * `empty-wrapper` 가 `\placeholder{}` 를 남긴다(빈 채로 두면 무엇을 지워야 구조가
 * 사라지는지 화면에서 알 수 없다). 그 placeholder를 지워야 비로소 구조가 없어진다.
 *
 * 단 큰 연산자의 범위(`isProtectedSlot`)는 **영구**다 — 지우려 해도 아무 일도 안
 * 일어나고 캐럿도 그대로 있는다. 그래서 `run` 이 정말 아무것도 안 하는 갈래가 있다.
 */
const deletePlaceholderSlot: KeyOp = {
  id: 'delete-placeholder-slot',
  summary: 'placeholder만 남은 자리에서 한 번 더 지우면 구조까지 사라진다 (큰 연산자 범위는 예외)',
  when: (ctx) => {
    if (!ctx.collapsed || !DELETE_KEYS.has(ctx.key)) return false;
    if (!atBranchStart(ctx)) return false;
    const owner = owningAtom(ctx);
    if (owner === undefined) return false;
    const kind = atomType(owner);
    const isScript = kind === 'subsup' || kind === 'extensible-symbol';
    const isWrapper = owner.command === '\\overline';
    if (!isScript && !isWrapper) return false;
    return branchIsJustPlaceholder(ctx);
  },
  run: (ctx) => {
    // 큰 연산자의 범위 — 키를 삼키고 **아무것도 안 한다**. 캐럿을 안 건드리는 게
    // 요점이라(범위 밖으로 튀면 안 된다) 정말로 빈 몸이어야 한다.
    if (isProtectedSlot(ctx)) return;
    const owner = owningAtom(ctx);
    if (owner === undefined) return;
    const bounds = atomBounds(ctx.model, owner);
    if (bounds === null) return;
    // 반대쪽 첨자는 살린다 (`survivingScriptLatex` 의 경고 참고). `\overline` 처럼
    // branch가 하나뿐인 구조는 살릴 게 없어 빈 문자열이 된다.
    const branch = ctx.model.at(ctx.model.position)?.parentBranch;
    const keep =
      atomType(owner) === 'subsup' && typeof branch === 'string'
        ? survivingScriptLatex(ctx, owner, branch)
        : '';
    // `\overline` 은 atom 자체가 구조다. 첨자(`subsup`)는 밑이 왼쪽 형제라 atom
    // 범위에 안 들어가므로, 둘 다 "소유 atom을 지운다" 로 밑은 살고 첨자만 사라진다.
    ctx.mf.selection = { ranges: [bounds], direction: 'forward' };
    ctx.mf.insert(keep, { insertionMode: 'replaceSelection', selectionMode: 'after' });
    // 살릴 게 없으면 캐럿을 구조가 있던 자리에 둔다. 있으면 MathLive가 새로 넣은
    // 첨자 뒤에 놔둔 자리를 그대로 쓴다 — 이어서 편집할 자리가 거기다.
    if (keep === '') ctx.mf.position = Math.max(0, Math.min(bounds[0], ctx.mf.lastOffset));
  },
  scenarios: [
    // 첨자: placeholder만 남은 자리에서 한 번 더 → 첨자가 통째로 사라진다.
    { start: String.raw`e^{\placeholder{}}`, caret: 2, key: 'Backspace', expect: 'e' },
    { start: String.raw`a_{\placeholder{}}`, caret: 2, key: 'Backspace', expect: 'a' },
    { start: String.raw`e^{\placeholder{}}`, caret: 2, key: 'Delete', expect: 'e' },
    // 회귀(사용자 보고): 위·아래 첨자가 **한 atom** 이라, 지수를 지우면서 아래첨자까지
    // 같이 사라졌다. 반대쪽은 살아남아야 한다.
    // ⚠ 오프셋 주의: `subsup` 은 아래첨자 branch 가 먼저 온다(실측 — 큰 연산자와 반대).
    { start: String.raw`x_1^{\placeholder{}}`, caret: 4, key: 'Backspace', expect: 'x_1' },
    { start: String.raw`x_{\placeholder{}}^2`, caret: 2, key: 'Backspace', expect: 'x^2' },
    // \overline 도 같은 규칙.
    { start: String.raw`\overline{\placeholder{}}`, caret: 1, key: 'Backspace', expect: '' },
    // 큰 연산자의 범위는 영구 — 아무것도 안 바뀐다.
    // ⚠ 오프셋 주의: 큰 연산자는 위·아래 첨자가 **한 atom의 두 branch**라 위첨자
    //   branch가 먼저 온다(실측). `\sum_{…}^{n}` 에서 아래첨자 시작은 3, `\int_{0}^{…}`
    //   에서 위첨자 시작은 1이다.
    {
      start: String.raw`\sum_{\placeholder{}}^{n}x`,
      caret: 3,
      key: 'Backspace',
      expect: String.raw`\sum_{\placeholder{}}^{n}x`,
    },
    {
      start: String.raw`\int_{0}^{\placeholder{}}x`,
      caret: 1,
      key: 'Delete',
      expect: String.raw`\int_{0}^{\placeholder{}}x`,
    },
  ],
};

/**
 * 큰 연산자(`\int`/`\sum`/`\prod`…) **바로 뒤**에서 backspace → 기호를 통째로 지운다.
 *
 * MathLive 기본은 여기서 **아무것도 안 한다**(실측: `\int_{0}^{1}` 끝에서
 * `deleteBackward` 해도 값이 그대로다). 위·아래 범위가 그 atom의 branch라 지울 "마지막
 * 글자" 가 없어서인데, 그러면 한 번 넣은 `\int` 를 지울 방법이 아예 없어진다 —
 * 범위 안의 placeholder는 영구라 거기서도 못 지운다(`delete-placeholder-slot`).
 *
 * 그래서 기호 뒤에서는 범위까지 **통째로** 지운다. 큰 연산자는 범위가 딸린 기호 하나가
 * 한 덩어리라, 반쪽만 남기는 게 오히려 이상하다.
 */
const deleteExtensibleSymbol: KeyOp = {
  id: 'delete-extensible-symbol',
  summary: '큰 연산자 바로 뒤 backspace는 기호와 범위를 통째로 지운다',
  when: (ctx) => {
    if (!ctx.collapsed || ctx.key !== 'Backspace') return false;
    return atomType(atomBefore(ctx)) === 'extensible-symbol';
  },
  run: (ctx) => {
    const symbol = atomBefore(ctx);
    if (symbol === undefined) return;
    const bounds = atomBounds(ctx.model, symbol);
    if (bounds === null) return;
    ctx.mf.selection = { ranges: [bounds], direction: 'forward' };
    ctx.mf.insert('', { insertionMode: 'replaceSelection', selectionMode: 'after' });
    ctx.mf.position = Math.max(0, Math.min(bounds[0], ctx.mf.lastOffset));
  },
  scenarios: [
    { start: String.raw`\int_{0}^{1}`, key: 'Backspace', expect: '' },
    { start: String.raw`\sum_{i}^{n}`, key: 'Backspace', expect: '' },
    // 뒤따르는 식은 남는다 — 지우는 건 기호와 그 범위뿐이다.
    { start: String.raw`\int_{0}^{1}x`, caret: 5, key: 'Backspace', expect: 'x' },
    // 앞의 식도 남는다.
    { start: String.raw`2\sum_{i}^{n}`, key: 'Backspace', expect: '2' },
  ],
};

/**
 * 첨자 내용 맨 앞에서 backspace → 첨자를 벗기고 내용을 밑 레벨로 내린다.
 * (`e^{|1}` → `e1`) MathLive 기본은 아무것도 안 하고 캐럿만 빠져나온다(실측).
 *
 * ⚠ 내용이 placeholder 하나뿐인 경우는 여기 오지 않는다 — 그건 "빈 자리" 라
 * 강등할 내용이 없다. `delete-placeholder-slot` 이 앞서서 잡는다(`KEY_OPS` 순서).
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
  deleteFencePair,
  blockBackslash,
  blockBaselessScript,
  // `demote-script-content` 보다 **앞**에 있어야 한다 — 둘 다 "첨자 내용 맨 앞
  // Backspace" 를 보는데, 내용이 placeholder뿐이면 강등이 아니라 삭제여야 한다.
  deletePlaceholderSlot,
  // `delete-placeholder-slot` 뒤여야 한다 — 큰 연산자의 **범위 안**에서 누른 건
  // 저쪽이 먼저 잡아 삼킨다(범위 placeholder는 영구). 여기 오는 건 기호 **바깥**
  // 바로 뒤에서 누른 경우뿐이다.
  deleteExtensibleSymbol,
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
