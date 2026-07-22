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

describe('결과 분리 (detachResult)', () => {
  const seed = () => {
    let s = initialWorkspace();
    const id = active(s).objects[0].id;
    s = workspaceReducer(s, { type: 'commitInput', id, latex: '2x+3x' });
    return { s, id };
  };

  it('편집분이 원본 바로 뒤에 독립 오브젝트로 선다', () => {
    let { s, id } = seed();
    s = workspaceReducer(s, { type: 'detachResult', id, latex: '5x+1' });
    const objects = active(s).objects;
    expect(objects).toHaveLength(2);
    expect(objects[0].latex).toBe('2x+3x');
    expect(objects[0].resultDetached).toBe(true); // 원본은 결과 표시를 잃는다
    expect(objects[1].latex).toBe('5x+1');
    expect(objects[1].resultDetached).toBe(false);
    expect(objects[1].id).not.toBe(id);
    // 편집 흐름 유지를 위해 새 오브젝트에 포커스
    expect(active(s).focus?.id).toBe(objects[1].id);
  });

  it('원본 latex를 고치면 결과 표시가 되살아난다', () => {
    let { s, id } = seed();
    s = workspaceReducer(s, { type: 'detachResult', id, latex: '5x+1' });
    s = workspaceReducer(s, { type: 'commitInput', id, latex: '2x+4x' });
    expect(active(s).objects[0].resultDetached).toBe(false);
  });

  it('분리는 실행취소 한 단계다', () => {
    let { s, id } = seed();
    s = workspaceReducer(s, { type: 'detachResult', id, latex: '5x+1' });
    s = workspaceReducer(s, { type: 'undo' });
    const objects = active(s).objects;
    expect(objects).toHaveLength(1);
    expect(objects[0].resultDetached).toBe(false); // 결과 행 복귀
  });

  it('없는 id는 no-op', () => {
    const { s } = seed();
    expect(workspaceReducer(s, { type: 'detachResult', id: 'ghost', latex: 'x' })).toBe(s);
  });
});

describe('전역 실행취소/다시실행', () => {
  const seed = () => {
    const s = initialWorkspace();
    return { s, id: active(s).objects[0].id };
  };

  it('편집을 되돌리고 다시 실행한다', () => {
    let { s, id } = seed();
    s = workspaceReducer(s, { type: 'commitInput', id, latex: '2x+3x' });
    expect(active(s).objects[0].latex).toBe('2x+3x');
    s = workspaceReducer(s, { type: 'undo' });
    expect(active(s).objects[0].latex).toBe('');
    s = workspaceReducer(s, { type: 'redo' });
    expect(active(s).objects[0].latex).toBe('2x+3x');
  });

  it('빈 히스토리에서 undo/redo는 no-op', () => {
    const { s } = seed();
    expect(workspaceReducer(s, { type: 'undo' })).toBe(s);
    expect(workspaceReducer(s, { type: 'redo' })).toBe(s);
  });

  it('새 편집은 redo 스택을 비운다', () => {
    let { s, id } = seed();
    s = workspaceReducer(s, { type: 'commitInput', id, latex: 'a' });
    s = workspaceReducer(s, { type: 'undo' }); // future에 'a'
    s = workspaceReducer(s, { type: 'commitInput', id, latex: 'b' }); // 새 분기
    expect(workspaceReducer(s, { type: 'redo' })).toBe(s); // redo 없음
  });

  it('같은 id 연속 편집은 한 단계로 합쳐진다', () => {
    let { s, id } = seed();
    // 디바운스 커밋이 연속으로 들어오는 상황
    s = workspaceReducer(s, { type: 'commitInput', id, latex: '2' });
    s = workspaceReducer(s, { type: 'commitInput', id, latex: '2x' });
    s = workspaceReducer(s, { type: 'commitInput', id, latex: '2x+3x' });
    // 한 번의 undo로 편집 시작 전(빈 문자열)까지 돌아가야 한다.
    s = workspaceReducer(s, { type: 'undo' });
    expect(active(s).objects[0].latex).toBe('');
  });

  it('다른 셀로 이동하면 코얼레싱이 끊긴다', () => {
    let { s, id } = seed();
    s = workspaceReducer(s, { type: 'enter', id, latex: 'a=3' }); // 새 셀 생성 + 이동
    const id2 = active(s).objects[1].id;
    s = workspaceReducer(s, { type: 'commitInput', id: id2, latex: 'a x' });
    // 첫 셀(id)로 포커스 이동 -> 코얼레싱 끊김
    s = workspaceReducer(s, { type: 'focus', id });
    s = workspaceReducer(s, { type: 'commitInput', id, latex: 'a=5' });
    // undo 한 번: a=5 편집만 되돌아가고 a=3은 유지
    s = workspaceReducer(s, { type: 'undo' });
    expect(active(s).objects[0].latex).toBe('a=3');
  });

  it('undo가 syncNonce를 올린다 (강제 반영 신호)', () => {
    let { s, id } = seed();
    const before = active(s).syncNonce;
    s = workspaceReducer(s, { type: 'commitInput', id, latex: 'x' });
    s = workspaceReducer(s, { type: 'undo' });
    expect(active(s).syncNonce).toBe(before + 1);
  });

  it('히스토리는 탭마다 독립이다', () => {
    let s = initialWorkspace();
    const id1 = active(s).objects[0].id;
    s = workspaceReducer(s, { type: 'commitInput', id: id1, latex: 'tab1edit' });
    s = workspaceReducer(s, { type: 'addTab' }); // Tab 2로 전환
    // Tab 2에서 undo는 Tab 2 히스토리만 봄 → 비어서 no-op
    expect(workspaceReducer(s, { type: 'undo' })).toBe(s);
  });
});
