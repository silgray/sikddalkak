import type { CellMode, FormulaObject } from '../types';

/** objects의 불변 스냅샷. 구조 공유라 저렴하다. */
type Snapshot = readonly FormulaObject[];

/**
 * 탭 단위 실행취소 히스토리. 비영속(새로고침하면 비어서 시작).
 * coalesceId: 지금 히스토리 최상단이 이 id의 연속 편집으로 만들어졌음을 표시.
 * 같은 id에 이어지는 commitInput은 새 단계를 만들지 않고 합친다.
 */
export type History = { past: Snapshot[]; future: Snapshot[]; coalesceId: string | null };

/**
 * 워크스페이스 = 탭 여러 개. 각 탭이 독립된 문서(objects)를 갖고, 변수/정의는
 * 탭 안에서만 공유된다(평가를 탭별로 따로 돌리므로 격리는 공짜다).
 */
export type Tab = {
  id: string;
  name: string;
  objects: FormulaObject[];
  /** 포커스를 옮길 오브젝트. token은 같은 곳에 다시 포커스를 줄 때 구분용. */
  focus: { id: string; token: number } | null;
  history: History;
  /**
   * 실행취소/다시실행이 일어날 때마다 증가. 포커스된 mathfield에도 값을 강제
   * 반영하기 위한 신호다(평상시 draft 보호를 뚫는 유일한 경로).
   */
  syncNonce: number;
};

export type WorkspaceState = {
  tabs: Tab[];
  activeTabId: string;
};

/** 활성 탭의 문서를 대상으로 하는 액션. */
type ObjectAction =
  | { type: 'commitInput'; id: string; latex: string }
  | { type: 'enter'; id: string; latex: string }
  | { type: 'setMode'; id: string; mode: CellMode }
  | { type: 'remove'; id: string }
  | { type: 'focus'; id: string };

/** 활성 탭의 히스토리를 다루는 액션. */
type HistoryAction = { type: 'undo' } | { type: 'redo' };

/** 탭 자체를 다루는 액션. */
type TabAction =
  | { type: 'addTab' }
  | { type: 'closeTab'; id: string }
  | { type: 'selectTab'; id: string }
  | { type: 'renameTab'; id: string; name: string };

export type Action = ObjectAction | HistoryAction | TabAction;

const HISTORY_LIMIT = 100;
const emptyHistory = (): History => ({ past: [], future: [], coalesceId: null });

export function makeObject(): FormulaObject {
  return { id: crypto.randomUUID(), latex: '', mode: 'scoped', resultDetached: false };
}

export function makeTab(name: string): Tab {
  return { id: crypto.randomUUID(), name, objects: [makeObject()], focus: null, history: emptyHistory(), syncNonce: 0 };
}

/** 저장본에서 복원할 때 비영속 필드(focus/history/syncNonce)를 채워 넣는다. */
export function hydrateTab(base: { id: string; name: string; objects: FormulaObject[] }): Tab {
  return { ...base, focus: null, history: emptyHistory(), syncNonce: 0 };
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

type Content = { objects: FormulaObject[]; focus: Tab['focus'] };

/**
 * 문서 콘텐츠(objects/focus)만 변형한다. 히스토리는 모른다 —
 * tabReducer가 이 결과의 변화 여부를 보고 실행취소 스냅샷을 관리한다.
 */
function reduceContent(tab: Tab, action: ObjectAction): Content {
  switch (action.type) {
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
        return { objects, focus: { id: next.id, token: nextToken(tab) } };
      }
      const created = makeObject();
      return { objects: [...objects, created], focus: { id: created.id, token: nextToken(tab) } };
    }

    case 'remove': {
      const objects = tab.objects.filter((o) => o.id !== action.id);
      // 스택이 비지 않도록 항상 최소 한 개는 남긴다.
      return { objects: objects.length > 0 ? objects : [makeObject()], focus: tab.focus };
    }

    case 'focus':
      return { objects: tab.objects, focus: { id: action.id, token: nextToken(tab) } };
  }
}

function cappedPush(past: Snapshot[], snapshot: Snapshot): Snapshot[] {
  const next = [...past, snapshot];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

/** 활성 탭 하나를 변형한다. 콘텐츠 변화면 실행취소 히스토리를 기록한다. */
function tabReducer(tab: Tab, action: ObjectAction | HistoryAction): Tab {
  if (action.type === 'undo') {
    const { past, future } = tab.history;
    if (past.length === 0) return tab;
    const prev = past[past.length - 1];
    return {
      ...tab,
      objects: prev as FormulaObject[],
      history: { past: past.slice(0, -1), future: [tab.objects, ...future], coalesceId: null },
      syncNonce: tab.syncNonce + 1,
    };
  }
  if (action.type === 'redo') {
    const { past, future } = tab.history;
    if (future.length === 0) return tab;
    const next = future[0];
    return {
      ...tab,
      objects: next as FormulaObject[],
      history: { past: [...past, tab.objects], future: future.slice(1), coalesceId: null },
      syncNonce: tab.syncNonce + 1,
    };
  }

  const { objects, focus } = reduceContent(tab, action);
  const objectsChanged = objects !== tab.objects;

  if (!objectsChanged) {
    // 콘텐츠 변화 없음. 포커스만 바뀌면 반영하고 코얼레싱을 끊는다(다른 셀로 이동).
    if (focus === tab.focus) return tab;
    return { ...tab, focus, history: { ...tab.history, coalesceId: null } };
  }

  // 같은 id에 이어지는 commitInput은 한 단계로 합친다(디바운스 커밋이 쌓이지 않게).
  const coalesceId = action.type === 'commitInput' ? action.id : null;
  const coalesce = coalesceId !== null && tab.history.coalesceId === coalesceId;
  const past = coalesce ? tab.history.past : cappedPush(tab.history.past, tab.objects);
  return { ...tab, objects, focus, history: { past, future: [], coalesceId } };
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
