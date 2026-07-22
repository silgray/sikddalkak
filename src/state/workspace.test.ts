import { describe, expect, it } from 'vitest';
import {
  workspaceReducer,
  initialWorkspace,
  makeTab,
  type WorkspaceState,
} from './workspace';

/** 활성 탭의 objects를 편하게 꺼낸다. */
function active(state: WorkspaceState) {
  return state.tabs.find((t) => t.id === state.activeTabId)!;
}

describe('탭 조작', () => {
  it('탭을 추가하면 활성 탭이 새 탭으로 바뀐다', () => {
    const s0 = initialWorkspace();
    const s1 = workspaceReducer(s0, { type: 'addTab' });
    expect(s1.tabs).toHaveLength(2);
    expect(s1.activeTabId).toBe(s1.tabs[1].id);
    expect(s1.tabs[1].name).toBe('Tab 2');
  });

  it('새 탭 이름은 안 쓰는 가장 작은 번호', () => {
    let s = initialWorkspace(); // Tab 1
    s = workspaceReducer(s, { type: 'addTab' }); // Tab 2
    s = workspaceReducer(s, { type: 'renameTab', id: s.tabs[1].id, name: 'Tab 1' }); // 이름 충돌 시도
    // 이제 Tab 1이 둘, Tab 2 없음. 추가하면 Tab 2가 나와야.
    s = workspaceReducer(s, { type: 'addTab' });
    expect(s.tabs[2].name).toBe('Tab 2');
  });

  it('탭을 선택하면 활성만 바뀐다', () => {
    let s = workspaceReducer(initialWorkspace(), { type: 'addTab' });
    const firstId = s.tabs[0].id;
    s = workspaceReducer(s, { type: 'selectTab', id: firstId });
    expect(s.activeTabId).toBe(firstId);
  });

  it('마지막 탭은 닫히지 않는다', () => {
    const s0 = initialWorkspace();
    const s1 = workspaceReducer(s0, { type: 'closeTab', id: s0.tabs[0].id });
    expect(s1).toBe(s0); // 변화 없음
  });

  it('활성 탭을 닫으면 이전 탭으로 활성 이동', () => {
    let s = initialWorkspace();
    s = workspaceReducer(s, { type: 'addTab' }); // 활성 = Tab 2
    const tab2 = s.activeTabId;
    s = workspaceReducer(s, { type: 'closeTab', id: tab2 });
    expect(s.tabs).toHaveLength(1);
    expect(s.activeTabId).toBe(s.tabs[0].id);
  });

  it('이름 변경, 빈 이름은 무시', () => {
    let s = initialWorkspace();
    const id = s.tabs[0].id;
    s = workspaceReducer(s, { type: 'renameTab', id, name: '  Physics ' });
    expect(active(s).name).toBe('Physics');
    s = workspaceReducer(s, { type: 'renameTab', id, name: '   ' });
    expect(active(s).name).toBe('Physics'); // 그대로
  });
});

describe('오브젝트 액션은 활성 탭만 건드린다', () => {
  it('commitInput은 활성 탭의 오브젝트만 바꾼다', () => {
    let s = initialWorkspace();
    const otherTabObjects = s.tabs[0].objects;
    s = workspaceReducer(s, { type: 'addTab' }); // 활성 = Tab 2
    const targetId = active(s).objects[0].id;
    s = workspaceReducer(s, { type: 'commitInput', id: targetId, latex: '2x+3x' });
    expect(active(s).objects[0].latex).toBe('2x+3x');
    // Tab 1은 그대로
    expect(s.tabs[0].objects).toBe(otherTabObjects);
  });

  it('enter가 활성 탭에 새 오브젝트를 만든다', () => {
    let s = initialWorkspace();
    const id = active(s).objects[0].id;
    s = workspaceReducer(s, { type: 'enter', id, latex: '2x' });
    expect(active(s).objects).toHaveLength(2);
    expect(active(s).focus?.id).toBe(active(s).objects[1].id);
  });

  it('latex를 바꾸면 resultDetached가 리셋된다', () => {
    let s = initialWorkspace();
    const id = active(s).objects[0].id;
    // 강제로 detached 상태를 만들고
    s = {
      ...s,
      tabs: s.tabs.map((t) =>
        t.id === s.activeTabId
          ? { ...t, objects: t.objects.map((o) => ({ ...o, resultDetached: true })) }
          : t,
      ),
    };
    s = workspaceReducer(s, { type: 'commitInput', id, latex: '9y' });
    expect(active(s).objects[0].resultDetached).toBe(false);
  });

  it('remove는 항상 최소 한 개를 남긴다', () => {
    let s = initialWorkspace();
    const id = active(s).objects[0].id;
    s = workspaceReducer(s, { type: 'remove', id });
    expect(active(s).objects).toHaveLength(1);
  });
});

describe('makeTab', () => {
  it('빈 오브젝트 하나로 시작한다', () => {
    const t = makeTab('X');
    expect(t.name).toBe('X');
    expect(t.objects).toHaveLength(1);
    expect(t.objects[0].latex).toBe('');
  });
});
