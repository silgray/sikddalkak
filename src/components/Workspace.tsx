import { useEffect, useReducer, useState } from 'react';
import { workspaceReducer, initialWorkspace, type WorkspaceState } from '../state/workspace';
import { loadWorkspace, saveWorkspace } from '../state/persist';
import { TabBar } from './TabBar';
import { CellStack } from './CellStack';
import { HelpPanel } from './HelpPanel';
import { KeyPalette } from './KeyPalette';

/**
 * 서랍 토글 아이콘 — 사이드바 글리프(시안). 왼쪽 칸을 선으로 가른 사각형.
 * `filled` 면 그 칸을 채운다 — "지금 서랍이 열려 있다"는 뜻(헤더 토글 버튼이
 * 상태에 따라 갈아 신는다). 서랍 안쪽 닫기 버튼은 열려 있을 때만 보이므로
 * 늘 채운 쪽이다.
 */
function DrawerIcon({ filled }: { filled: boolean }) {
  return (
    <span className={filled ? 'drawer-icon drawer-icon-filled' : 'drawer-icon'}>
      <span className="drawer-icon-bar" />
    </span>
  );
}

/** 저장된 워크스페이스가 있으면 거기서, 없으면 빈 워크스페이스로 시작한다. */
function init(): WorkspaceState {
  return loadWorkspace() ?? initialWorkspace();
}

const SAVE_DEBOUNCE_MS = 500;

export function Workspace() {
  const [state, dispatch] = useReducer(workspaceReducer, null, init);
  /**
   * 서랍(탭 목록) 열림 상태 — 모바일 전용 UI지만 상태 자체는 기기를 안 가린다
   * (대원칙 2 — `isMobileDevice()` 로 존재 여부를 가르지 않는다). 데스크톱에서는
   * 토글 버튼 자체가 CSS로 안 보이니 열릴 방법이 없을 뿐이다.
   *
   * `TabBar` 는 **항상 하나만, 항상 마운트된 채**로 둔다 — 데스크톱은 이 서랍
   * 컨테이너가 `display:contents` 로 통째로 사라져 지금과 똑같이 인라인으로
   * 보이고(`drawer.css`), 모바일은 같은 `TabBar` 를 슬라이드 패널 안으로 옮겨
   * 그린다. 열림 자체는 그리기(항상 마운트)만 하고 보이기/안 보이기는 CSS가
   * 정한다(대원칙 3) — 그래서 `drawerOpen && …` 로 조건부 마운트하지 않는다.
   */
  const [drawerOpen, setDrawerOpen] = useState(false);

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
          flex-basis:100%, styles.css). 모바일(손가락 기기)에서는 토글 버튼 +
          가운데 제목 + 도움말이 한 줄이고, 탭 바는 서랍 안으로 옮겨간다
          (`drawer.css`, 시안). */}
      <div className="topbar">
        <div className="topbar-row">
          <button
            type="button"
            className="drawer-toggle"
            title="Tabs"
            aria-label="Tabs"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((v) => !v)}
          >
            <DrawerIcon filled={drawerOpen} />
          </button>
          <span className="app-title">sikddalkak</span>
          <HelpPanel />
        </div>
        <p className="app-intro">
          Type an expression and press <kbd>Enter</kbd> to evaluate.
          <br />
          Write <code>a = 3</code> to define a variable other cells can use.
        </p>
        {/* 서랍 컨테이너. 데스크톱은 `display:contents` 로 사라져 `TabBar` 가
            바로 위 형제들과 나란히 인라인으로 보인다(지금과 동일) — 모바일만
            이 안을 슬라이드 패널로 바꾼다. */}
        <div className={drawerOpen ? 'drawer drawer-open' : 'drawer'}>
          <div className="drawer-scrim" onClick={() => setDrawerOpen(false)} />
          <div className="drawer-panel" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-panel-head">
              <button
                type="button"
                className="drawer-close"
                title="Close"
                aria-label="Close"
                onClick={() => setDrawerOpen(false)}
              >
                <DrawerIcon filled />
              </button>
            </div>
            <TabBar
              tabs={state.tabs}
              activeTabId={state.activeTabId}
              onSelect={(id) => {
                dispatch({ type: 'selectTab', id });
                // 시안: 탭을 고르면 서랍이 같이 닫힌다.
                setDrawerOpen(false);
              }}
              onAdd={() => dispatch({ type: 'addTab' })}
              onClose={(id) => dispatch({ type: 'closeTab', id })}
              onRename={(id, name) => dispatch({ type: 'renameTab', id, name })}
            />
          </div>
        </div>
      </div>
      {/* 탭이 바뀌면 CellStack을 새로 마운트한다 — 이전 탭의 mathfield DOM이 남지 않게. */}
      <CellStack key={activeTab.id} tab={activeTab} dispatch={dispatch} />
      {/* MathLive 자체 가상 키보드 대신 이걸 쓴다. `position: fixed` 라 DOM 위치는
          레이아웃에 안 걸리고, 손가락 기기에서만 보인다(styles/keyPalette.css). 탭
          전환과 무관하게 하나만 — activeField가 어느 셀의 필드든 가리킬 수 있다. */}
      <KeyPalette />
    </div>
  );
}
