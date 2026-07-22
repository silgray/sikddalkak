import type { CellMode, FormulaObject } from '../types';

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

/** 탭 자체를 다루는 액션. */
type TabAction =
  | { type: 'addTab' }
  | { type: 'closeTab'; id: string }
  | { type: 'selectTab'; id: string }
  | { type: 'renameTab'; id: string; name: string };

export type Action = ObjectAction | TabAction;

export function makeObject(): FormulaObject {
  return { id: crypto.randomUUID(), latex: '', mode: 'scoped', resultDetached: false };
}

export function makeTab(name: string): Tab {
  return { id: crypto.randomUUID(), name, objects: [makeObject()], focus: null };
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

/** 활성 탭 하나의 문서를 변형한다. 워크스페이스/탭 구조는 모른다. */
function tabReducer(tab: Tab, action: ObjectAction): Tab {
  switch (action.type) {
    case 'commitInput': {
      const target = tab.objects.find((o) => o.id === action.id);
      // 값이 그대로면 새 상태를 만들지 않는다 — 불필요한 재평가/리렌더를 막는다.
      if (target === undefined || target.latex === action.latex) return tab;
      // latex가 바뀌면 분리 상태를 푼다 — 재평가된 새 결과를 다시 보여준다.
      return { ...tab, objects: patch(tab.objects, action.id, { latex: action.latex, resultDetached: false }) };
    }

    case 'setMode':
      return { ...tab, objects: patch(tab.objects, action.id, { mode: action.mode }) };

    case 'enter': {
      const objects = patch(tab.objects, action.id, { latex: action.latex, resultDetached: false });
      const index = objects.findIndex((o) => o.id === action.id);
      const next = objects[index + 1];
      if (next !== undefined) {
        // 이미 아래 오브젝트가 있으면 새로 만들지 않고 거기로 이동한다.
        return { ...tab, objects, focus: { id: next.id, token: nextToken(tab) } };
      }
      const created = makeObject();
      return { ...tab, objects: [...objects, created], focus: { id: created.id, token: nextToken(tab) } };
    }

    case 'remove': {
      const objects = tab.objects.filter((o) => o.id !== action.id);
      // 스택이 비지 않도록 항상 최소 한 개는 남긴다.
      return { ...tab, objects: objects.length > 0 ? objects : [makeObject()] };
    }

    case 'focus':
      return { ...tab, focus: { id: action.id, token: nextToken(tab) } };
  }
}

function mapActiveTab(state: WorkspaceState, fn: (tab: Tab) => Tab): WorkspaceState {
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.id === state.activeTabId ? fn(t) : t)),
  };
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
