import { useEffect, useReducer } from 'react';
import { workspaceReducer, initialWorkspace, type WorkspaceState } from '../state/workspace';
import { loadWorkspace, saveWorkspace } from '../state/persist';
import { TabBar } from './TabBar';
import { CellStack } from './CellStack';

/** 저장된 워크스페이스가 있으면 거기서, 없으면 빈 워크스페이스로 시작한다. */
function init(): WorkspaceState {
  return loadWorkspace() ?? initialWorkspace();
}

const SAVE_DEBOUNCE_MS = 500;

export function Workspace() {
  const [state, dispatch] = useReducer(workspaceReducer, null, init);

  // 편집이 잦으므로 저장을 디바운스한다. 워크스페이스가 바뀔 때마다 타이머를 다시 건다.
  useEffect(() => {
    const timer = setTimeout(() => saveWorkspace(state), SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [state]);

  const activeTab = state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0];

  return (
    <div className="workspace">
      <TabBar
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        onSelect={(id) => dispatch({ type: 'selectTab', id })}
        onAdd={() => dispatch({ type: 'addTab' })}
        onClose={(id) => dispatch({ type: 'closeTab', id })}
        onRename={(id, name) => dispatch({ type: 'renameTab', id, name })}
      />
      {/* 탭이 바뀌면 CellStack을 새로 마운트한다 — 이전 탭의 mathfield DOM이 남지 않게. */}
      <CellStack key={activeTab.id} tab={activeTab} dispatch={dispatch} />
    </div>
  );
}
