import { describe, expect, it } from 'vitest';
import { parseDocument, serializeDocument } from './persist';
import type { FormulaObject } from '../types';

const sample: FormulaObject[] = [
  { id: 'a1', latex: '2x+3x', mode: 'scoped' },
  { id: 'b2', latex: 'a=3', mode: 'symbolic' },
];

describe('직렬화 왕복', () => {
  it('저장했다 불러오면 그대로다', () => {
    expect(parseDocument(serializeDocument(sample))).toEqual(sample);
  });

  it('빈 문서도 왕복한다', () => {
    expect(parseDocument(serializeDocument([]))).toEqual([]);
  });

  it('버전을 포함해 저장한다', () => {
    expect(JSON.parse(serializeDocument(sample))).toMatchObject({ version: 1 });
  });

  it('정본 외 필드는 저장하지 않는다', () => {
    const dirty = [{ ...sample[0], transient: 'x', committed: true }];
    const parsed = JSON.parse(serializeDocument(dirty));
    expect(Object.keys(parsed.objects[0]).sort()).toEqual(['id', 'latex', 'mode']);
  });
});

describe('손상 데이터 방어', () => {
  it('없는 데이터는 null', () => {
    expect(parseDocument(null)).toBeNull();
  });

  it('깨진 JSON은 null', () => {
    expect(parseDocument('{not json')).toBeNull();
  });

  it('스키마 버전이 다르면 null (마이그레이션 없이 무시)', () => {
    expect(parseDocument(JSON.stringify({ version: 2, objects: sample }))).toBeNull();
    expect(parseDocument(JSON.stringify({ objects: sample }))).toBeNull();
  });

  it('objects가 배열이 아니면 null', () => {
    expect(parseDocument(JSON.stringify({ version: 1, objects: 'nope' }))).toBeNull();
  });

  it('오브젝트 하나라도 형식이 틀리면 전체 null', () => {
    const bad = [sample[0], { id: 'x', latex: 5, mode: 'scoped' }];
    expect(parseDocument(JSON.stringify({ version: 1, objects: bad }))).toBeNull();
  });

  it('알 수 없는 mode는 거부한다', () => {
    const bad = [{ id: 'x', latex: 'y', mode: 'wild' }];
    expect(parseDocument(JSON.stringify({ version: 1, objects: bad }))).toBeNull();
  });

  it('낯선 필드가 섞여 있어도 정본만 남긴다', () => {
    const raw = JSON.stringify({
      version: 1,
      objects: [{ id: 'a1', latex: '2x', mode: 'scoped', color: 'red', x: 10 }],
    });
    expect(parseDocument(raw)).toEqual([{ id: 'a1', latex: '2x', mode: 'scoped' }]);
  });
});
