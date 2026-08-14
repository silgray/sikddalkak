import type { EvalResult, FormulaObject } from './types';

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

/**
 * 그룹의 result 필드에 보여줄 결과를 고른다 (`CellGroup` 이 쓴다, 표시 규칙은
 * `CLAUDE.md`/`docs` 의 셀 그룹 규칙 참고). 순수 함수라 실제 MathLive 없이
 * 단위 테스트로 덮는다 — 컴포넌트에는 조립만 남긴다.
 *
 * - Enter로 확정(`entered`)한 셀이 있으면 그 결과를 무조건 보여준다(`pending`도
 *   그대로 — 첫 계산이 아직 안 끝났을 뿐이니 `ResultRow` 가 그 경우엔 조용히 있는다).
 * - 없으면 그룹이 셀 하나뿐이고, 그 결과가 입력과 구조적으로 달라졌을 때만
 *   (`unchanged` 아닐 때만) 조용히 보여준다.
 * - 그 밖(둘 이상 셀인데 아무도 확정 안 함)엔 `{kind:'empty'}`.
 */
export function pickGroupDisplay(
  objects: readonly FormulaObject[],
  results: ReadonlyMap<string, EvalResult>,
): EvalResult {
  const enteredIndex = objects.findIndex((o) => o.entered);
  if (enteredIndex !== -1) return results.get(objects[enteredIndex].id) ?? { kind: 'empty' };
  if (objects.length !== 1) return { kind: 'empty' };
  const sole = results.get(objects[0].id);
  return sole !== undefined && sole.kind === 'ok' && !sole.unchanged ? sole : { kind: 'empty' };
}

/**
 * 결과 편집(`editResult`)을 어느 셀에 붙일지 — 확정한 셀이 있으면 그 뒤, 없으면
 * (상시 표시 중인 단일 셀 그룹) 그 유일한 셀 뒤.
 */
export function groupResultTargetId(objects: readonly FormulaObject[]): string {
  const enteredIndex = objects.findIndex((o) => o.entered);
  return objects[enteredIndex !== -1 ? enteredIndex : objects.length - 1].id;
}
