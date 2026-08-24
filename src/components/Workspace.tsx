import { useEffect, useReducer } from 'react';
import { workspaceReducer, initialWorkspace, type WorkspaceState } from '../state/workspace';
import { loadWorkspace, saveWorkspace } from '../state/persist';
import { TabBar } from './TabBar';
import { CellStack } from './CellStack';
import { HelpPanel } from './HelpPanel';
import { KeyPalette } from './KeyPalette';

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

  // 전역 실행취소/다시실행. window의 capture 단계에서 잡으면 이벤트가 mathfield까지
  // 내려가기 전에 막혀서, MathLive의 필드 내 실행취소가 자연히 비활성화된다.
  // 히스토리가 탭 문서 단위로 하나만 남는다.
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      const key = ev.key.toLowerCase();
      if (key === 'z') {
        ev.preventDefault();
        ev.stopPropagation();
        dispatch(ev.shiftKey ? { type: 'redo' } : { type: 'undo' });
      } else if (key === 'y') {
        ev.preventDefault();
        ev.stopPropagation();
        dispatch({ type: 'redo' });
      }
    };
    window.addEventListener('keydown', onKeyDown, true); // capture
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const activeTab = state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0];

  return (
    <div className="workspace">
      {/* 데스크톱: 제목/도움말이 첫 줄, 탭 바가 그 아래(`.topbar` wrap + `.tabbar`
          flex-basis:100%, styles.css). 모바일(640px 이하)에서는 한 줄로 흡수된다. */}
      <div className="topbar">
        <span className="app-title">sikddalkak</span>
        <TabBar
          tabs={state.tabs}
          activeTabId={state.activeTabId}
          onSelect={(id) => dispatch({ type: 'selectTab', id })}
          onAdd={() => dispatch({ type: 'addTab' })}
          onClose={(id) => dispatch({ type: 'closeTab', id })}
          onRename={(id, name) => dispatch({ type: 'renameTab', id, name })}
        />
        <HelpPanel />
      </div>
      <p className="app-intro">
        Type an expression and press <kbd>Enter</kbd> to evaluate.
        <br />
        Write <code>a = 3</code> to define a variable other cells can use.
      </p>
      {/* 탭이 바뀌면 CellStack을 새로 마운트한다 — 이전 탭의 mathfield DOM이 남지 않게. */}
      <CellStack key={activeTab.id} tab={activeTab} dispatch={dispatch} />
      {/* MathLive 자체 가상 키보드 대신 이걸 쓴다. `position: fixed` 라 DOM 위치는
          레이아웃에 안 걸리고, 640px 이하에서만 보인다(styles/keyPalette.css). 탭
          전환과 무관하게 하나만 — activeField가 어느 셀의 필드든 가리킬 수 있다. */}
      <KeyPalette />
    </div>
  );
}
