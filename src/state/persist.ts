import type { CellMode, FormulaObject } from '../types';
import type { WorkspaceState } from './workspace';
import { hydrateTab } from './workspace';

/**
 * 워크스페이스 영속화. localStorage I/O와 순수 검증/직렬화/마이그레이션을 분리한다 —
 * 검증(손상 데이터 방어)과 v1→v2 마이그레이션이 이 파일의 핵심이고, localStorage
 * 없이 테스트할 수 있어야 하기 때문이다.
 *
 * 스키마 버전 이력:
 * - v1: `{ version:1, objects }` — 단일 문서(탭 이전).
 * - v2: `{ version:2, tabs:[{id,name,objects}], activeTabId }` — 탭 여러 개.
 * 캔버스에서 오브젝트별 좌표가 생기면 v3로 올리고 마이그레이션을 잇는다.
 */

const KEY = 'sikddalkak.doc';
const SCHEMA_VERSION = 2;

type PersistedTab = { id: string; name: string; objects: FormulaObject[] };
type PersistedV2 = { version: 2; tabs: PersistedTab[]; activeTabId: string };

const MODES: readonly CellMode[] = ['scoped', 'symbolic'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** 낯선/누락 필드를 흡수해 정본 오브젝트로 정규화한다. 형식이 틀리면 null. */
function normalizeObject(o: unknown): FormulaObject | null {
  if (!isRecord(o)) return null;
  if (typeof o.id !== 'string' || typeof o.latex !== 'string') return null;
  if (!MODES.includes(o.mode as CellMode)) return null;
  return {
    id: o.id,
    latex: o.latex,
    mode: o.mode as CellMode,
    // v1에는 없던 필드. 없으면 false.
    resultDetached: o.resultDetached === true,
  };
}

function normalizeObjects(raw: unknown): FormulaObject[] | null {
  if (!Array.isArray(raw)) return null;
  const objects: FormulaObject[] = [];
  for (const item of raw) {
    const obj = normalizeObject(item);
    if (obj === null) return null;
    objects.push(obj);
  }
  return objects;
}

/** 탭에 최소 하나의 오브젝트를 보장한다(편집할 셀). */
function ensureNonEmpty(objects: FormulaObject[]): FormulaObject[] {
  return objects.length > 0
    ? objects
    : [{ id: crypto.randomUUID(), latex: '', mode: 'scoped', resultDetached: false }];
}

/**
 * 저장 문자열을 검증·마이그레이션해 워크스페이스로 되돌린다.
 * 손상됐거나 알 수 없는 버전이면 null — 호출부는 이때 빈 워크스페이스로 시작한다.
 */
export function parseWorkspace(raw: string | null): WorkspaceState | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  // --- v1 마이그레이션: 단일 문서를 탭 하나로 감싼다 ---
  if (parsed.version === 1) {
    const objects = normalizeObjects(parsed.objects);
    if (objects === null) return null;
    const tab = hydrateTab({ id: crypto.randomUUID(), name: 'Tab 1', objects: ensureNonEmpty(objects) });
    return { tabs: [tab], activeTabId: tab.id };
  }

  // --- v2 ---
  if (parsed.version === SCHEMA_VERSION && Array.isArray(parsed.tabs)) {
    const tabs = [];
    for (const t of parsed.tabs) {
      if (!isRecord(t) || typeof t.id !== 'string' || typeof t.name !== 'string') return null;
      const objects = normalizeObjects(t.objects);
      if (objects === null) return null;
      tabs.push(hydrateTab({ id: t.id, name: t.name, objects: ensureNonEmpty(objects) }));
    }
    if (tabs.length === 0) return null;
    // activeTabId가 실제 탭을 가리키지 않으면 첫 탭으로 보정.
    const activeTabId = tabs.some((t) => t.id === parsed.activeTabId)
      ? (parsed.activeTabId as string)
      : tabs[0].id;
    return { tabs, activeTabId };
  }

  return null;
}

export function serializeWorkspace(state: WorkspaceState): string {
  const doc: PersistedV2 = {
    version: SCHEMA_VERSION,
    tabs: state.tabs.map((t) => ({
      id: t.id,
      name: t.name,
      objects: t.objects.map((o) => ({
        id: o.id,
        latex: o.latex,
        mode: o.mode,
        resultDetached: o.resultDetached,
      })),
    })),
    activeTabId: state.activeTabId,
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

export function loadWorkspace(): WorkspaceState | null {
  const store = storage();
  if (store === null) return null;
  let raw: string | null;
  try {
    raw = store.getItem(KEY);
  } catch (err) {
    console.error('[persist] 워크스페이스 로드 실패, 빈 상태로 시작합니다.', err);
    return null;
  }
  const parsed = parseWorkspace(raw);
  // 데이터가 있었는데 거부됐다면(손상/버전 불일치) 데이터 손실이므로 알린다.
  if (raw !== null && parsed === null) {
    console.warn('[persist] 저장된 워크스페이스가 손상됐거나 호환되지 않아 무시합니다.');
  }
  return parsed;
}

export function saveWorkspace(state: WorkspaceState): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(KEY, serializeWorkspace(state));
  } catch (err) {
    // 저장 용량 초과 등. 저장 실패가 편집을 막아서는 안 되므로 삼킨다.
    console.error('[persist] 워크스페이스 저장 실패.', err);
  }
}
