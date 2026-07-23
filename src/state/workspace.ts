import type { CellMode, FormulaObject } from '../types';

/** 셀 안 캐럿 위치. id는 오브젝트, offset은 MathLive 오프셋. */
export type Cursor = { id: string; offset: number } | null;

/**
 * 실행취소 한 단계 = 변경 **직전**의 문서와 캐럿.
 * undo는 이 지점으로 문서를 되돌리고 캐럿도 그 자리로 옮긴다 —
 * "모든 문서 변경은 (변경, 그 시점의 커서)를 함께 기록한다"는 원칙.
 * 셀 추가를 취소하면 커서가 원래 셀로 돌아가는 것도 이 규칙에서 자동으로 나온다.
 */
type HistoryEntry = { objects: readonly FormulaObject[]; cursor: Cursor };

/** 탭 단위 실행취소 히스토리. 비영속(새로고침하면 비어서 시작). */
export type History = { past: HistoryEntry[]; future: HistoryEntry[] };

/**
 * 워크스페이스 = 탭 여러 개. 각 탭이 독립된 문서(objects)를 갖고, 변수/정의는
 * 탭 안에서만 공유된다(평가를 탭별로 따로 돌리므로 격리는 공짜다).
 */
export type Tab = {
  id: string;
  name: string;
  objects: FormulaObject[];
  /**
   * 포커스(와 선택적으로 캐럿)를 옮길 지시. token은 같은 곳에 다시 지시할 때
   * 구분용. offset이 있으면 포커스 후 캐럿을 그 위치로 놓는다(실행취소 복원).
   */
  focus: { id: string; token: number; offset?: number } | null;
  history: History;
  /**
   * 실행취소/다시실행이 일어날 때마다 증가. 포커스된 mathfield에도 값을 강제
   * 반영하기 위한 신호다(평상시 draft 보호를 뚫는 유일한 경로).
   */
  syncNonce: number;
  /** 가장 최근 콘텐츠 변경 직후의 캐럿 — 다음 히스토리 entry의 cursor가 된다. */
  lastCursor: Cursor;
  /**
   * 마지막 변경의 종류. typing(키 입력)이면 평가를 디바운스하고,
   * structural(셀 추가/삭제/변환/실행취소 등)이면 즉시 평가한다.
   */
  lastChange: 'typing' | 'structural';
};

export type WorkspaceState = {
  tabs: Tab[];
  activeTabId: string;
};

/** 활성 탭의 문서를 대상으로 하는 액션. */
type ObjectAction =
  /** 키 입력 1회. cursor = 입력 직후의 캐럿 오프셋. 실행취소 1단계가 된다. */
  | { type: 'editInput'; id: string; latex: string; cursor: number }
  /** 명시적 편집(선택 변환 등). typing이 아니라 structural로 즉시 평가된다. */
  | { type: 'commitInput'; id: string; latex: string; cursor?: number }
  | { type: 'enter'; id: string; latex: string }
  | { type: 'setMode'; id: string; mode: CellMode }
  | { type: 'remove'; id: string }
  /** 드래그 재정렬. toIndex = 이동 후 위치. 표시 순서만 바뀐다(평가는 순서 무관). */
  | { type: 'moveObject'; id: string; toIndex: number }
  | { type: 'focus'; id: string }
  /**
   * 결과 행을 편집해 독립 식으로 분리한다. 편집한 latex로 새 오브젝트를 원본
   * 바로 뒤에 만들고, 원본은 결과 표시를 잃는다(resultDetached).
   */
  | { type: 'detachResult'; id: string; latex: string; cursor?: number };

/** 활성 탭의 히스토리를 다루는 액션. */
type HistoryAction = { type: 'undo' } | { type: 'redo' };

/** 탭 자체를 다루는 액션. */
type TabAction =
  | { type: 'addTab' }
  | { type: 'closeTab'; id: string }
  | { type: 'selectTab'; id: string }
  | { type: 'renameTab'; id: string; name: string };

export type Action = ObjectAction | HistoryAction | TabAction;

// 키 입력 단위로 쌓이므로 넉넉하게. 스냅샷은 구조 공유라 저렴하다.
const HISTORY_LIMIT = 500;
const emptyHistory = (): History => ({ past: [], future: [] });

export function makeObject(): FormulaObject {
  return { id: crypto.randomUUID(), latex: '', mode: 'scoped', resultDetached: false };
}

export function makeTab(name: string): Tab {
  return {
    id: crypto.randomUUID(),
    name,
    objects: [makeObject()],
    focus: null,
    history: emptyHistory(),
    syncNonce: 0,
    lastCursor: null,
    lastChange: 'structural',
  };
}

/** 저장본에서 복원할 때 비영속 필드(focus/history 등)를 채우고 불변식을 맞춘다. */
export function hydrateTab(base: { id: string; name: string; objects: FormulaObject[] }): Tab {
  return {
    ...base,
    objects: ensureTrailingEmpty(base.objects),
    focus: null,
    history: emptyHistory(),
    syncNonce: 0,
    lastCursor: null,
    lastChange: 'structural',
  };
}

export function initialWorkspace(): WorkspaceState {
  const tab = makeTab('Tab 1');
  return { tabs: [tab], activeTabId: tab.id };
}

function patch(objects: FormulaObject[], id: string, change: Partial<FormulaObject>): FormulaObject[] {
  return objects.map((o) => (o.id === id ? { ...o, ...change } : o));
}

function nextToken(tab: Tab): number {
  return tab.focus ? tab.focus.token + 1 : 1;
}

type Content = {
  objects: FormulaObject[];
  focus: Tab['focus'];
  /** 이 변경 직후의 캐럿. 없으면 이전 lastCursor 유지. */
  cursorAfter?: Cursor;
};

/**
 * 문서 콘텐츠(objects/focus)만 변형한다. 히스토리는 모른다 —
 * tabReducer가 이 결과의 변화 여부를 보고 실행취소 스냅샷을 관리한다.
 */
function reduceContent(tab: Tab, action: ObjectAction): Content {
  switch (action.type) {
    case 'editInput':
    case 'commitInput': {
      const target = tab.objects.find((o) => o.id === action.id);
      // 값이 그대로면 변화 없음 — objects 참조를 유지해 히스토리·재평가를 막는다.
      if (target === undefined || target.latex === action.latex) {
        return { objects: tab.objects, focus: tab.focus };
      }
      // latex가 바뀌면 분리 상태를 푼다 — 재평가된 새 결과를 다시 보여준다.
      return {
        objects: patch(tab.objects, action.id, { latex: action.latex, resultDetached: false }),
        focus: tab.focus,
        cursorAfter:
          action.cursor !== undefined ? { id: action.id, offset: action.cursor } : undefined,
      };
    }

    case 'setMode':
      return { objects: patch(tab.objects, action.id, { mode: action.mode }), focus: tab.focus };

    case 'enter': {
      const objects = patch(tab.objects, action.id, { latex: action.latex, resultDetached: false });
      const index = objects.findIndex((o) => o.id === action.id);
      const next = objects[index + 1];
      if (next !== undefined) {
        // 이미 아래 오브젝트가 있으면 새로 만들지 않고 거기로 이동한다.
        return {
          objects,
          focus: { id: next.id, token: nextToken(tab) },
          cursorAfter: { id: next.id, offset: 0 },
        };
      }
      const created = makeObject();
      return {
        objects: [...objects, created],
        focus: { id: created.id, token: nextToken(tab) },
        cursorAfter: { id: created.id, offset: 0 },
      };
    }

    case 'remove':
      // 비거나 마지막이 채워지는 경우는 ensureTrailingEmpty 불변식이 채운다.
      return { objects: tab.objects.filter((o) => o.id !== action.id), focus: tab.focus };

    case 'moveObject': {
      const from = tab.objects.findIndex((o) => o.id === action.id);
      if (from === -1) return { objects: tab.objects, focus: tab.focus };
      const to = Math.max(0, Math.min(action.toIndex, tab.objects.length - 1));
      if (to === from) return { objects: tab.objects, focus: tab.focus };
      const objects = [...tab.objects];
      const [moved] = objects.splice(from, 1);
      objects.splice(to, 0, moved);
      return { objects, focus: tab.focus };
    }

    case 'focus':
      return { objects: tab.objects, focus: { id: action.id, token: nextToken(tab) } };

    case 'detachResult': {
      const index = tab.objects.findIndex((o) => o.id === action.id);
      if (index === -1) return { objects: tab.objects, focus: tab.focus };
      const created = { ...makeObject(), latex: action.latex };
      const objects = tab.objects.flatMap((o, i) =>
        // 원본은 결과 표시를 잃고, 편집분이 새 독립 오브젝트로 바로 뒤에 선다.
        i === index ? [{ ...o, resultDetached: true }, created] : [o],
      );
      // 사용자가 편집을 이어가던 흐름을 유지하도록 새 오브젝트의 같은 캐럿 위치로.
      return {
        objects,
        focus: { id: created.id, token: nextToken(tab), offset: action.cursor },
        cursorAfter:
          action.cursor !== undefined ? { id: created.id, offset: action.cursor } : undefined,
      };
    }
  }
}

function cappedPush(past: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const next = [...past, entry];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

/**
 * 편집 한 번이 어떤 종류인지 diff로 판정한다 (키워드 단위 실행취소의 심장).
 *
 * - tokenKind: 순수하게 글자/숫자 1개가 삽입된 편집. char = 그 문자 —
 *   undo 시점 그룹핑이 run 텍스트를 복원해 키워드 사전과 대조할 재료다.
 * - shortcut: 글자 run이 그것을 확장하는 `\command`로 치환된 편집
 *   (예: `co` + s → `\cos `). 현재 MathLive 설정에선 발생하지 않지만(실측),
 *   inlineShortcuts를 켜는 순간을 대비해 판정만 남겨둔다.
 * - 그 외(연산자, 괄호/지수 구조 삽입, 삭제, 다중 문자)는 둘 다 아니어서
 *   자기만의 실행취소 단계가 된다.
 */
export function classifyEdit(
  prevLatex: string,
  nextLatex: string,
): { tokenKind: 'alpha' | 'digit' | null; char: string | null; shortcut: boolean } {
  // 공통 접두사/접미사를 걷어내 실제 바뀐 조각만 남긴다.
  const minLen = Math.min(prevLatex.length, nextLatex.length);
  let prefix = 0;
  while (prefix < minLen && prevLatex[prefix] === nextLatex[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    prevLatex[prevLatex.length - 1 - suffix] === nextLatex[nextLatex.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = prevLatex.slice(prefix, prevLatex.length - suffix);
  const added = nextLatex.slice(prefix, nextLatex.length - suffix);

  const kindOf = (ch: string): 'alpha' | 'digit' | null =>
    /^[a-zA-Z]$/.test(ch) ? 'alpha' : /^[0-9]$/.test(ch) ? 'digit' : null;

  if (removed === '') {
    const plain = kindOf(added);
    if (plain !== null) return { tokenKind: plain, char: added, shortcut: false };
    // 지수/아래첨자 진입이 첫 글자와 한 이벤트로 합쳐져 온다 (실측: `e`→`e^{s}`,
    // `x`→`x^2` — `^` 단독은 input 이벤트가 없다). 그 글자를 run의 일부로 삼아야
    // undo가 `e^{s}` 같은 첫 글자 잔재를 남기지 않는다.
    const sup = added.match(/^[\^_](?:\{([a-zA-Z0-9])\}|([a-zA-Z0-9]))$/);
    if (sup !== null) {
      const ch = sup[1] ?? sup[2];
      return { tokenKind: kindOf(ch), char: ch, shortcut: false };
    }
  }
  // 빈 구조의 placeholder를 첫 글자가 치환하는 경우 (실측: `\frac{1}{\placeholder{}}`
  // → `\frac{1}{c}`). 이 글자도 run의 일부여야 undo가 첫 글자를 남기지 않는다.
  if (removed === '\\placeholder{}') {
    const fill = kindOf(added);
    if (fill !== null) return { tokenKind: fill, char: added, shortcut: false };
  }
  if (removed !== '' && /^[a-zA-Z]+$/.test(removed)) {
    const command = added.match(/^\\([a-zA-Z]+) ?$/);
    if (command !== null && command[1].startsWith(removed)) {
      return { tokenKind: null, char: null, shortcut: true };
    }
  }
  return { tokenKind: null, char: null, shortcut: false };
}

/**
 * undo 그룹핑이 "한 단위"로 취급하는 함수형 키워드. 최장 일치 우선으로 쓰인다.
 * 그리스 문자명(pi 등)은 p·i 곱과 구분할 수 없어 넣지 않는다. 추가는 자유.
 */
export const KEYWORDS: readonly string[] = [
  'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh', 'sqrt', 'prod',
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
  'log', 'exp', 'lim', 'sum', 'int', 'det',
  'ln',
];
const KEYWORDS_LONGEST_FIRST = [...KEYWORDS].sort((a, b) => b.length - a.length);

/**
 * 글자/숫자 run을 실행취소 단위 토큰들로 나눈다. 반환은 앞에서부터 각 토큰의
 * 글자 수. 숫자 구간은 통째 한 토큰(수 하나), 글자 구간은 키워드 사전과
 * 왼쪽부터 최장 일치 — 사전에 없으면 글자 1개(=변수 하나)가 토큰이다.
 * (`cosx` → [3,1], `asdf` → [1,1,1,1], `12` → [2], `si` → [1,1])
 */
export function tokenizeRun(
  run: readonly { char: string; kind: 'alpha' | 'digit' }[],
): number[] {
  const sizes: number[] = [];
  let i = 0;
  while (i < run.length) {
    let j = i;
    while (j < run.length && run[j].kind === run[i].kind) j += 1;
    if (run[i].kind === 'digit') {
      sizes.push(j - i);
    } else {
      const seg = run.slice(i, j).map((c) => c.char).join('');
      let p = 0;
      while (p < seg.length) {
        const kw = KEYWORDS_LONGEST_FIRST.find((k) => seg.startsWith(k, p));
        const len = kw?.length ?? 1;
        sizes.push(len);
        p += len;
      }
    }
    i = j;
  }
  return sizes;
}

type TokenChar = { char: string; kind: 'alpha' | 'digit' };

/**
 * 인접 스냅샷 쌍이 "한 셀에 토큰 문자 1개 삽입"인지 판정한다.
 * 상시 빈 셀 불변식 때문에 빈 셀의 첫 입력은 목록 끝에 새 빈 셀을 덧붙인다 —
 * 그 경우(prev보다 딱 하나 많고 마지막이 빈 셀)도 같은 편집으로 인정한다.
 */
function tokenStep(
  prev: readonly FormulaObject[],
  next: readonly FormulaObject[],
): { cellId: string; char: string; kind: 'alpha' | 'digit' } | null {
  let core = next;
  if (next.length === prev.length + 1) {
    if (next[next.length - 1].latex.trim() !== '') return null;
    core = next.slice(0, -1);
  }
  if (core.length !== prev.length) return null;
  let step: { cellId: string; char: string; kind: 'alpha' | 'digit' } | null = null;
  for (let i = 0; i < prev.length; i += 1) {
    if (prev[i].id !== core[i].id) return null;
    if (prev[i].latex === core[i].latex) continue;
    if (step !== null) return null; // 두 셀 이상 바뀜 — 토큰 편집이 아니다
    const edit = classifyEdit(prev[i].latex, core[i].latex);
    if (edit.tokenKind === null || edit.char === null) return null;
    step = { cellId: prev[i].id, char: edit.char, kind: edit.tokenKind };
  }
  return step;
}

/**
 * 시간 순 스냅샷 열의 끝(가장 최근 편집)에서 뒤로, 같은 셀에 캐럿 연속으로
 * 이어진 토큰 삽입들을 모아 run 텍스트를 복원한다 (undo 그룹핑용).
 * states[j].cursor는 그 상태의 캐럿 — past entry가 "변경 직전 문서+캐럿"이라
 * past 열과 현재 상태를 이어 붙이면 정확히 이 모양이 된다.
 */
function trailingTokenRun(states: readonly HistoryEntry[]): TokenChar[] {
  const run: TokenChar[] = [];
  for (let i = states.length - 1; i >= 1; i -= 1) {
    const step = tokenStep(states[i - 1].objects, states[i].objects);
    const after = states[i].cursor;
    if (step === null || after === null || after.id !== step.cellId) break;
    if (run.length > 0) {
      const newer = states[i + 1].cursor; // run이 비어있지 않으면 i+1은 수집됐다
      if (newer === null || newer.id !== after.id || newer.offset !== after.offset + 1) break;
    }
    run.unshift({ char: step.char, kind: step.kind });
  }
  return run;
}

/** trailingTokenRun의 거울상 — 열의 처음에서 앞으로 (redo 그룹핑용). */
function leadingTokenRun(states: readonly HistoryEntry[]): TokenChar[] {
  const run: TokenChar[] = [];
  for (let i = 1; i < states.length; i += 1) {
    const step = tokenStep(states[i - 1].objects, states[i].objects);
    const after = states[i].cursor;
    if (step === null || after === null || after.id !== step.cellId) break;
    if (run.length > 0) {
      const older = states[i - 1].cursor;
      if (older === null || older.id !== after.id || after.offset !== older.offset + 1) break;
    }
    run.push({ char: step.char, kind: step.kind });
  }
  return run;
}

/**
 * 불변식: 맨 아래에는 항상 빈 셀이 하나 있다 — 언제든 눌러서 이어서 쓸 수 있게.
 * 마지막 셀이 채워지면(또는 문서가 비면) 빈 셀을 덧붙인다.
 * 변화가 없으면 같은 참조를 돌려줘 히스토리/리렌더를 건드리지 않는다.
 */
function ensureTrailingEmpty(objects: FormulaObject[]): FormulaObject[] {
  const last = objects[objects.length - 1];
  if (last !== undefined && last.latex.trim() === '') return objects;
  return [...objects, makeObject()];
}

/** 활성 탭 하나를 변형한다. 콘텐츠 변화면 실행취소 히스토리를 기록한다. */
function tabReducer(tab: Tab, action: ObjectAction | HistoryAction): Tab {
  if (action.type === 'undo') {
    const { past, future } = tab.history;
    if (past.length === 0) return tab;
    // 키워드 단위 그룹핑: 최근 편집들이 이어 친 글자/숫자 run이면 마지막 토큰
    // (키워드·변수·수) 크기만큼 entry를 한 번에 되돌린다. run이 아니면 1개.
    const states = [...past, { objects: tab.objects, cursor: tab.lastCursor }];
    const sizes = tokenizeRun(trailingTokenRun(states));
    const k = sizes.length > 0 ? sizes[sizes.length - 1] : 1;
    const idx = past.length - k;
    const entry = past[idx];
    return {
      ...tab,
      objects: entry.objects as FormulaObject[],
      history: {
        past: past.slice(0, idx),
        // pop된 상태들은 가까운 순으로 future 앞에 붙는다 — redo가 같은
        // 토큰화를 앞으로 적용하면 정확히 역연산이 된다.
        future: [...states.slice(idx + 1), ...future],
      },
      // 캐럿을 그 편집이 일어났던 자리로 되돌린다 (포커스 + 오프셋).
      focus: entry.cursor
        ? { id: entry.cursor.id, token: nextToken(tab), offset: entry.cursor.offset }
        : tab.focus,
      lastCursor: entry.cursor,
      syncNonce: tab.syncNonce + 1,
      lastChange: 'structural',
    };
  }
  if (action.type === 'redo') {
    const { past, future } = tab.history;
    if (future.length === 0) return tab;
    const states = [{ objects: tab.objects, cursor: tab.lastCursor }, ...future];
    const sizes = tokenizeRun(leadingTokenRun(states));
    const k = sizes.length > 0 ? sizes[0] : 1;
    const entry = future[k - 1];
    return {
      ...tab,
      objects: entry.objects as FormulaObject[],
      history: {
        past: [...past, ...states.slice(0, k)],
        future: future.slice(k),
      },
      focus: entry.cursor
        ? { id: entry.cursor.id, token: nextToken(tab), offset: entry.cursor.offset }
        : tab.focus,
      lastCursor: entry.cursor,
      syncNonce: tab.syncNonce + 1,
      lastChange: 'structural',
    };
  }

  const content = reduceContent(tab, action);
  const objects =
    content.objects === tab.objects ? content.objects : ensureTrailingEmpty(content.objects);
  const { focus, cursorAfter } = content;
  const objectsChanged = objects !== tab.objects;

  if (!objectsChanged) {
    // 콘텐츠 변화 없음. 포커스만 바뀌면 반영한다.
    if (focus === tab.focus) return tab;
    return { ...tab, focus };
  }

  // 변경 직전 상태를 히스토리에 남긴다. 키 입력마다 entry 하나 — 키워드 단위
  // 묶음은 여기가 아니라 undo/redo 시점의 그룹핑이 맡는다 (위 trailingTokenRun).
  const entry: HistoryEntry = { objects: tab.objects, cursor: tab.lastCursor };
  return {
    ...tab,
    objects,
    focus,
    history: { past: cappedPush(tab.history.past, entry), future: [] },
    lastCursor: cursorAfter ?? tab.lastCursor,
    lastChange: action.type === 'editInput' ? 'typing' : 'structural',
  };
}

function mapActiveTab(state: WorkspaceState, fn: (tab: Tab) => Tab): WorkspaceState {
  const active = state.tabs.find((t) => t.id === state.activeTabId);
  if (active === undefined) return state;
  const next = fn(active);
  // 활성 탭이 그대로면 워크스페이스 정체성을 유지한다 — no-op이 새 객체를 만들지 않게.
  if (next === active) return state;
  return { ...state, tabs: state.tabs.map((t) => (t.id === state.activeTabId ? next : t)) };
}

/** 새 탭 이름은 "Tab N" 중 안 쓰는 가장 작은 N. */
function nextTabName(tabs: readonly Tab[]): string {
  const used = new Set(tabs.map((t) => t.name));
  for (let n = 1; ; n += 1) {
    const name = `Tab ${n}`;
    if (!used.has(name)) return name;
  }
}

export function workspaceReducer(state: WorkspaceState, action: Action): WorkspaceState {
  switch (action.type) {
    case 'addTab': {
      const tab = makeTab(nextTabName(state.tabs));
      return { tabs: [...state.tabs, tab], activeTabId: tab.id };
    }

    case 'closeTab': {
      // 마지막 탭은 닫지 않는다 — 워크스페이스가 비지 않도록.
      if (state.tabs.length <= 1) return state;
      const index = state.tabs.findIndex((t) => t.id === action.id);
      if (index === -1) return state;
      const tabs = state.tabs.filter((t) => t.id !== action.id);
      // 활성 탭을 닫으면 인접 탭(이전 우선, 없으면 다음)으로 활성 이동.
      const activeTabId =
        state.activeTabId === action.id
          ? (tabs[index - 1] ?? tabs[index] ?? tabs[0]).id
          : state.activeTabId;
      return { tabs, activeTabId };
    }

    case 'selectTab':
      return state.tabs.some((t) => t.id === action.id)
        ? { ...state, activeTabId: action.id }
        : state;

    case 'renameTab': {
      const name = action.name.trim();
      if (name === '') return state;
      return { ...state, tabs: state.tabs.map((t) => (t.id === action.id ? { ...t, name } : t)) };
    }

    default:
      return mapActiveTab(state, (tab) => tabReducer(tab, action));
  }
}
