import { describe, expect, it } from 'vitest';
import { workspaceReducer, initialWorkspace, type WorkspaceState, type Action } from './workspace';

/**
 * 리듀서 fuzz — 무작위(시드 고정, 결정적) 편집·undo·redo 시퀀스에 대해
 * 구조적 불변식을 검사한다. 개별 시나리오 테스트가 못 덮는 조합 공간을
 * 넓게 훑는 안전망.
 *
 * 불변식:
 *  1. 어떤 시퀀스에서도 예외가 없다
 *  2. 상시 빈 셀: 마지막 오브젝트는 항상 빈 latex
 *  3. undo 직후 redo는 정확히 직전 상태로 되돌린다 (그룹 대칭)
 *  4. undo를 계속 누르면 유한 단계 안에 히스토리가 바닥난다
 */

const active = (s: WorkspaceState) => s.tabs.find((t) => t.id === s.activeTabId)!;

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const CHARS = 'xyzabc123+-'.split('');

/** 셀 latex에 대한 그럴듯한 편집을 만든다 (삽입/삭제/캐럿 점프/구조 삽입). */
function mutate(
  rnd: () => number,
  latex: string,
  cursor: number,
): { latex: string; cursor: number } {
  const roll = rnd();
  const clamp = (v: number) => Math.max(0, Math.min(v, latex.length));
  if (roll < 0.6 || latex.length === 0) {
    // 캐럿 위치에 글자 하나 삽입
    const at = clamp(cursor);
    const ch = CHARS[Math.floor(rnd() * CHARS.length)];
    return { latex: latex.slice(0, at) + ch + latex.slice(at), cursor: at + 1 };
  }
  if (roll < 0.75) {
    // 캐럿 앞 글자 삭제
    const at = clamp(cursor);
    if (at === 0) return { latex, cursor };
    return { latex: latex.slice(0, at - 1) + latex.slice(at), cursor: at - 1 };
  }
  if (roll < 0.9) {
    // 캐럿 점프 후 삽입 (run 분리 경로)
    const at = Math.floor(rnd() * (latex.length + 1));
    const ch = CHARS[Math.floor(rnd() * CHARS.length)];
    return { latex: latex.slice(0, at) + ch + latex.slice(at), cursor: at + 1 };
  }
  // 구조 삽입 흉내 (다중 문자 diff)
  return { latex: `${latex}\\left(\\right)`, cursor: latex.length + 2 };
}

function step(rnd: () => number, s: WorkspaceState): WorkspaceState {
  const tab = active(s);
  const roll = rnd();
  const cells = tab.objects;
  const target = cells[Math.floor(rnd() * cells.length)];
  let action: Action;
  if (roll < 0.55) {
    const cur = tab.lastCursor?.id === target.id ? tab.lastCursor.offset : target.latex.length;
    const next = mutate(rnd, target.latex, cur);
    action = { type: 'editInput', id: target.id, latex: next.latex, cursor: next.cursor };
  } else if (roll < 0.65) {
    action = { type: 'enter', id: target.id, latex: target.latex };
  } else if (roll < 0.72 && cells.length > 1) {
    action = { type: 'remove', id: target.id };
  } else if (roll < 0.78) {
    action = {
      type: 'commitInput',
      id: target.id,
      latex: `${target.latex}q`,
      cursor: 1,
      selectionBefore: [0, Math.max(1, target.latex.length)],
    };
  } else if (roll < 0.9) {
    action = { type: 'undo' };
  } else {
    action = { type: 'redo' };
  }
  return workspaceReducer(s, action);
}

describe('workspaceReducer fuzz (시드 고정)', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed=${seed}: 300 스텝 불변식 유지`, () => {
      const rnd = makeRng(seed);
      let s = initialWorkspace();
      for (let k = 0; k < 300; k += 1) {
        const before = s;
        s = step(rnd, s); // 불변식 1: 예외 없음 (던지면 테스트 실패)

        // 불변식 2: 상시 빈 셀
        const objects = active(s).objects;
        expect(objects[objects.length - 1].latex.trim()).toBe('');

        // 불변식 3: 콘텐츠가 바뀐 편집 직후, undo→redo 왕복은 상태를 보존한다
        const changed = active(s).objects !== active(before).objects;
        const hasPast = active(s).history.past.length > 0;
        if (changed && hasPast) {
          const undone = workspaceReducer(s, { type: 'undo' });
          const redone = workspaceReducer(undone, { type: 'redo' });
          expect(JSON.stringify(active(redone).objects)).toBe(
            JSON.stringify(active(s).objects),
          );
          // 그룹 대칭: redo 후 다시 undo하면 같은 지점으로
          const reUndone = workspaceReducer(redone, { type: 'undo' });
          expect(JSON.stringify(active(reUndone).objects)).toBe(
            JSON.stringify(active(undone).objects),
          );
        }
      }

      // 불변식 4: undo가 유한 단계 안에 바닥난다
      let guard = 0;
      while (active(s).history.past.length > 0) {
        s = workspaceReducer(s, { type: 'undo' });
        guard += 1;
        expect(guard).toBeLessThan(2000);
      }
    });
  }
});
