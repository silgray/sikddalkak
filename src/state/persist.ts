import type { CellMode, FormulaObject } from '../types';

/**
 * 문서 영속화. localStorage I/O와 순수 검증/직렬화를 분리한다 —
 * 검증 로직(손상 데이터 방어)이 이 파일의 핵심이고, localStorage 없이
 * 테스트할 수 있어야 하기 때문이다.
 *
 * 저장 형식에는 스키마 버전을 처음부터 넣는다. 캔버스를 붙이면 오브젝트별
 * 좌표(placement)가 생기는데, 그때 version을 올리고 마이그레이션을 붙인다.
 * 지금은 배열 순서가 유일한 배치 정보라 objects만 저장한다.
 */

const KEY = 'sikddalkak.doc';
const SCHEMA_VERSION = 1;

type PersistedDoc = { version: number; objects: FormulaObject[] };

const MODES: readonly CellMode[] = ['scoped', 'symbolic'];

function isValidObject(o: unknown): o is FormulaObject {
  if (typeof o !== 'object' || o === null) return false;
  const r = o as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.latex === 'string' &&
    MODES.includes(r.mode as CellMode)
  );
}

/**
 * 저장된 문자열을 검증해 오브젝트 배열로 되돌린다.
 * 손상됐거나(JSON 깨짐, 타입 불일치) 스키마 버전이 다르면 null을 준다 —
 * 호출부는 이때 빈 문서로 시작한다. 낯선 필드가 섞여 있어도 정본만 남긴다.
 */
export function parseDocument(raw: string | null): FormulaObject[] | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const doc = parsed as Record<string, unknown>;
  if (doc.version !== SCHEMA_VERSION || !Array.isArray(doc.objects)) return null;

  const objects: FormulaObject[] = [];
  for (const item of doc.objects) {
    if (!isValidObject(item)) return null;
    objects.push({ id: item.id, latex: item.latex, mode: item.mode });
  }
  return objects;
}

export function serializeDocument(objects: readonly FormulaObject[]): string {
  const doc: PersistedDoc = {
    version: SCHEMA_VERSION,
    objects: objects.map((o) => ({ id: o.id, latex: o.latex, mode: o.mode })),
  };
  return JSON.stringify(doc);
}

/** 일부 환경(SSR, 프라이빗 모드)에서는 접근 자체가 예외를 던진다. */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadDocument(): FormulaObject[] | null {
  const store = storage();
  if (store === null) return null;
  let raw: string | null;
  try {
    raw = store.getItem(KEY);
  } catch (err) {
    console.error('[persist] 문서 로드 실패, 빈 문서로 시작합니다.', err);
    return null;
  }
  const parsed = parseDocument(raw);
  // 데이터가 있었는데 거부됐다면(손상/버전 불일치) 데이터 손실이므로 알린다.
  // 애초에 저장된 게 없는 첫 방문은 정상이라 조용히 넘어간다.
  if (raw !== null && parsed === null) {
    console.warn('[persist] 저장된 문서가 손상됐거나 호환되지 않아 무시합니다.');
  }
  return parsed;
}

export function saveDocument(objects: readonly FormulaObject[]): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(KEY, serializeDocument(objects));
  } catch (err) {
    // 저장 용량 초과 등. 저장 실패가 편집을 막아서는 안 되므로 삼킨다.
    console.error('[persist] 문서 저장 실패.', err);
  }
}
