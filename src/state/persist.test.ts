import { describe, expect, it } from 'vitest';
import { parseWorkspace, serializeWorkspace } from './persist';
import { hydrateTab, type WorkspaceState } from './workspace';
import type { FormulaObject } from '../types';

const obj = (id: string, latex: string, extra: Partial<FormulaObject> = {}): FormulaObject => ({
  id,
  latex,
  mode: 'scoped',
  resultDetached: false,
  ...extra,
});

const workspace: WorkspaceState = {
  tabs: [
    hydrateTab({ id: 't1', name: 'Tab 1', objects: [obj('a1', '2x+3x')] }),
    hydrateTab({ id: 't2', name: 'Calc', objects: [obj('b1', 'a=3', { mode: 'symbolic' })] }),
  ],
  activeTabId: 't2',
};

describe('직렬화 왕복', () => {
  it('저장했다 불러오면 그대로다 (focus는 비영속이라 null)', () => {
    expect(parseWorkspace(serializeWorkspace(workspace))).toEqual(workspace);
  });

  it('버전 2로 저장한다', () => {
    expect(JSON.parse(serializeWorkspace(workspace))).toMatchObject({ version: 2 });
  });

  it('resultDetached도 왕복한다', () => {
    const ws: WorkspaceState = {
      tabs: [hydrateTab({ id: 't1', name: 'T', objects: [obj('a', '2x', { resultDetached: true })] })],
      activeTabId: 't1',
    };
    expect(parseWorkspace(serializeWorkspace(ws))?.tabs[0].objects[0].resultDetached).toBe(true);
  });
});

describe('v1 → v2 마이그레이션', () => {
  it('단일 문서를 Tab 1로 감싼다', () => {
    const v1 = JSON.stringify({
      version: 1,
      objects: [{ id: 'x', latex: '2x+3x', mode: 'scoped' }],
    });
    const ws = parseWorkspace(v1);
    expect(ws?.tabs).toHaveLength(1);
    expect(ws?.tabs[0].name).toBe('Tab 1');
    expect(ws?.tabs[0].objects[0]).toEqual(obj('x', '2x+3x'));
    expect(ws?.activeTabId).toBe(ws?.tabs[0].id);
  });

  it('v1 오브젝트에 없던 resultDetached는 false로 채운다', () => {
    const v1 = JSON.stringify({ version: 1, objects: [{ id: 'x', latex: '2x', mode: 'scoped' }] });
    expect(parseWorkspace(v1)?.tabs[0].objects[0].resultDetached).toBe(false);
  });
});

describe('손상 데이터 방어', () => {
  it('없는 데이터는 null', () => {
    expect(parseWorkspace(null)).toBeNull();
  });

  it('깨진 JSON은 null', () => {
    expect(parseWorkspace('{not json')).toBeNull();
  });

  it('알 수 없는 버전은 null', () => {
    expect(parseWorkspace(JSON.stringify({ version: 99, tabs: [] }))).toBeNull();
  });

  it('탭이 없으면 null', () => {
    expect(parseWorkspace(JSON.stringify({ version: 2, tabs: [], activeTabId: 'x' }))).toBeNull();
  });

  it('오브젝트 형식이 틀리면 null', () => {
    const bad = JSON.stringify({
      version: 2,
      tabs: [{ id: 't', name: 'T', objects: [{ id: 'a', latex: 5, mode: 'scoped' }] }],
      activeTabId: 't',
    });
    expect(parseWorkspace(bad)).toBeNull();
  });

  it('알 수 없는 mode는 거부한다', () => {
    const bad = JSON.stringify({
      version: 2,
      tabs: [{ id: 't', name: 'T', objects: [{ id: 'a', latex: 'x', mode: 'wild' }] }],
      activeTabId: 't',
    });
    expect(parseWorkspace(bad)).toBeNull();
  });

  it('activeTabId가 실제 탭을 안 가리키면 첫 탭으로 보정', () => {
    const raw = JSON.stringify({
      version: 2,
      tabs: [{ id: 't1', name: 'T', objects: [{ id: 'a', latex: 'x', mode: 'scoped' }] }],
      activeTabId: 'gone',
    });
    expect(parseWorkspace(raw)?.activeTabId).toBe('t1');
  });

  it('빈 objects 탭은 셀 하나를 채운다', () => {
    const raw = JSON.stringify({
      version: 2,
      tabs: [{ id: 't1', name: 'T', objects: [] }],
      activeTabId: 't1',
    });
    const ws = parseWorkspace(raw);
    expect(ws?.tabs[0].objects).toHaveLength(1);
    expect(ws?.tabs[0].objects[0].latex).toBe('');
  });

  it('낯선 필드가 섞여 있어도 정본만 남긴다', () => {
    const raw = JSON.stringify({
      version: 2,
      tabs: [{ id: 't', name: 'T', objects: [{ id: 'a', latex: '2x', mode: 'scoped', x: 10, color: 'red' }] }],
      activeTabId: 't',
    });
    expect(parseWorkspace(raw)?.tabs[0].objects[0]).toEqual(obj('a', '2x'));
  });
});
