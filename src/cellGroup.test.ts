import { describe, expect, it } from 'vitest';
import { groupAt, groupResultTargetId, groupsOf, pickGroupDisplay } from './cellGroup';
import { makeObject } from './state/workspace';
import type { EvalResult, FormulaObject } from './types';

function cell(latex: string, extra: Partial<FormulaObject> = {}): FormulaObject {
  return { ...makeObject(), latex, ...extra };
}

/** 같은 그룹으로 묶는다 — 뒤 셀들의 groupId를 첫 셀에 맞춘다. */
function group(...cells: FormulaObject[]): FormulaObject[] {
  return cells.map((c) => ({ ...c, groupId: cells[0].groupId }));
}

const ok = (latex: string, unchanged: boolean): EvalResult => ({
  kind: 'ok',
  latex,
  definitionName: null,
  unchanged,
});

describe('groupsOf / groupAt', () => {
  it('groupId가 다르면 각자 그룹', () => {
    const objects = [cell('1'), cell('2'), cell('3')];
    const groups = groupsOf(objects);
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => [g.start, g.end])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it('인접한 같은 groupId는 한 그룹', () => {
    const objects = [...group(cell('1'), cell('2')), cell('3')];
    const groups = groupsOf(objects);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ start: 0, end: 2 });
    expect(groups[1]).toMatchObject({ start: 2, end: 3 });
  });

  it('groupAt이 어느 인덱스에서든 같은 그룹 경계를 준다', () => {
    const objects = [cell('0'), ...group(cell('1'), cell('2'), cell('3')), cell('4')];
    expect(groupAt(objects, 1)).toMatchObject({ start: 1, end: 4 });
    expect(groupAt(objects, 2)).toMatchObject({ start: 1, end: 4 });
    expect(groupAt(objects, 3)).toMatchObject({ start: 1, end: 4 });
    expect(groupAt(objects, 0)).toMatchObject({ start: 0, end: 1 });
    expect(groupAt(objects, 4)).toMatchObject({ start: 4, end: 5 });
  });
});

describe('pickGroupDisplay', () => {
  it('확정(entered)한 셀이 있으면 오류든 뭐든 무조건 보여준다', () => {
    const c = cell('x+', { entered: true });
    const results = new Map<string, EvalResult>([[c.id, { kind: 'error', message: 'boom' }]]);
    expect(pickGroupDisplay([c], results)).toEqual({ kind: 'error', message: 'boom' });
  });

  it('그룹이 셀 하나뿐이고 unchanged면 숨긴다', () => {
    const c = cell('3');
    const results = new Map<string, EvalResult>([[c.id, ok('3', true)]]);
    expect(pickGroupDisplay([c], results)).toEqual({ kind: 'empty' });
  });

  it('그룹이 셀 하나뿐이고 unchanged 아니면 조용히 보여준다', () => {
    const c = cell('a+1');
    const results = new Map<string, EvalResult>([[c.id, ok('4', false)]]);
    expect(pickGroupDisplay([c], results)).toEqual(ok('4', false));
  });

  it('셀이 둘 이상인데 아무도 확정 안 했으면 아무것도 안 보여준다', () => {
    const objects = group(cell('2x+3x'), cell('5x+1'));
    const results = new Map<string, EvalResult>([
      [objects[0].id, ok('5x', true)],
      [objects[1].id, ok('5x+1', false)],
    ]);
    expect(pickGroupDisplay(objects, results)).toEqual({ kind: 'empty' });
  });

  it('그룹 2번째 셀을 확정하면 그 결과가 그룹 결과를 덮어쓴다', () => {
    const objects = group(cell('2x+3x', { entered: false }), cell('5x+1', { entered: true }));
    const results = new Map<string, EvalResult>([
      [objects[0].id, ok('5x', true)],
      [objects[1].id, ok('5x+1', false)],
    ]);
    expect(pickGroupDisplay(objects, results)).toEqual(ok('5x+1', false));
  });

  it('확정한 셀의 결과가 아직 안 들어왔으면(map에 없음) 빈 취급 — 호출부가 조용히 있는다', () => {
    const c = cell('3', { entered: true });
    const results = new Map<string, EvalResult>();
    expect(pickGroupDisplay([c], results)).toEqual({ kind: 'empty' });
  });

  describe('확정 안 한 오류', () => {
    const err = (message: string, transient?: boolean): EvalResult => ({
      kind: 'error',
      message,
      ...(transient === undefined ? {} : { transient }),
    });

    it('확정적인 오류는 Enter 없이도 보여준다', () => {
      // 모양 불일치처럼 더 친다고 저절로 풀리지 않는 문제를, 눌러봐야만 알 수 있으면 안 된다.
      const c = cell('A+v');
      const results = new Map<string, EvalResult>([[c.id, err('Cannot add 3x3 and 3x1')]]);
      expect(pickGroupDisplay([c], results)).toEqual(err('Cannot add 3x3 and 3x1'));
    });

    it('파싱 실패(transient)는 확정 전까지 숨긴다', () => {
      // 타이핑 도중 거의 매 키마다 참이라 띄우면 소음이 된다.
      const c = cell('x+');
      const results = new Map<string, EvalResult>([[c.id, err('unexpected end', true)]]);
      expect(pickGroupDisplay([c], results)).toEqual({ kind: 'empty' });
    });

    it('안 채운 자리(transient)도 마찬가지로 숨긴다', () => {
      const c = cell(String.raw`x^{\placeholder{}}`);
      const results = new Map<string, EvalResult>([[c.id, err('incomplete expression', true)]]);
      expect(pickGroupDisplay([c], results)).toEqual({ kind: 'empty' });
    });

    it('셀이 여럿이어도 마지막 셀의 확정적인 오류는 보여준다', () => {
      const objects = group(cell('2x+3x'), cell('A+v'));
      const results = new Map<string, EvalResult>([
        [objects[0].id, ok('5x', true)],
        [objects[1].id, err('Cannot add 3x3 and 3x1')],
      ]);
      expect(pickGroupDisplay(objects, results)).toEqual(err('Cannot add 3x3 and 3x1'));
    });

    it('확정한 셀이 있으면 그쪽이 이긴다 (transient 여부와 무관)', () => {
      const objects = group(cell('3', { entered: true }), cell('x+'));
      const results = new Map<string, EvalResult>([
        [objects[0].id, ok('3', false)],
        [objects[1].id, err('unexpected end', true)],
      ]);
      expect(pickGroupDisplay(objects, results)).toEqual(ok('3', false));
    });
  });
});

describe('groupResultTargetId', () => {
  it('확정한 셀이 있으면 그 셀', () => {
    const objects = group(cell('a'), cell('b', { entered: true }), cell('c'));
    expect(groupResultTargetId(objects)).toBe(objects[1].id);
  });

  it('없으면 그룹의 마지막 셀(=상시 표시 중인 단일 셀)', () => {
    const c = cell('3');
    expect(groupResultTargetId([c])).toBe(c.id);
  });
});
