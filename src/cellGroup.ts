import type { FormulaObject } from './types';

/** 인접 구간 하나. `end`는 exclusive. */
export type Group = { groupId: string; start: number; end: number };

/**
 * 문서를 인접한 `groupId` 구간으로 쪼갠다. 그룹은 result 필드 편집으로만 생기므로
 * (`state/workspace.ts` 의 `editResult`), 여기서는 그냥 순서대로 훑어 경계만 찾는다.
 */
export function groupsOf(objects: readonly FormulaObject[]): Group[] {
  const groups: Group[] = [];
  let i = 0;
  while (i < objects.length) {
    const groupId = objects[i].groupId;
    const start = i;
    let end = i + 1;
    while (end < objects.length && objects[end].groupId === groupId) end += 1;
    groups.push({ groupId, start, end });
    i = end;
  }
  return groups;
}

/** `index` 위치의 셀이 속한 그룹. `objects[index]`가 없으면 던진다(호출자 책임). */
export function groupAt(objects: readonly FormulaObject[], index: number): Group {
  const groupId = objects[index].groupId;
  let start = index;
  while (start > 0 && objects[start - 1].groupId === groupId) start -= 1;
  let end = index + 1;
  while (end < objects.length && objects[end].groupId === groupId) end += 1;
  return { groupId, start, end };
}
