import type { SelectionInfo } from '../cellSelection';
import type { Env } from '../algebra';
import type { FormulaObject, EvalResult } from '../types';
import type {
  ApproximateRequest,
  EvaluateRequest,
  SelectionRequest,
  WorkerResponse,
} from './protocol';

/**
 * `algebra.worker.ts` 클라이언트 — 메인 스레드가 쓰는 유일한 창구.
 *
 * **요청당 타임아웃(`WORKER_TIMEOUT_MS`)이 진짜 상한이다.** algebra의 CE 시간 예산은
 * 협조적이라(`ce/budget.ts`) CE가 스스로 데드라인을 확인 안 하는 입력에는 무력하다 —
 * 그런 요청은 여기서 시간이 지나면 워커를 통째로 `terminate()` 하고 새로 띄운다.
 * 그게 유일하게 진짜로 계산을 멈추는 방법이다.
 *
 * **`evaluate` 타임아웃 뒤 재시도가 같은 셀에서 다시 안 멈추는 이유**: 죽은 워커가
 * 마지막으로 `cellStart` 보고한 셀을 "범인"으로 기록해두고(`timedOutLatex`), 재시도
 * 요청에 그 id를 `forceTimeoutIds` 로 실어 보낸다 — `cellGraph.ts` 의 `evaluateCells`
 * 가 그 셀은 아예 계산하지 않고 곧장 타임아웃 오류로 채운다. 그 셀의 latex가 그대로인
 * 한 계속 막힌 채로 있고, 사용자가 고치면(=latex가 바뀌면) `pruneTimedOut` 이 다시
 * 기회를 준다.
 */

const WORKER_TIMEOUT_MS = 5000;

type PendingEvaluate = {
  kind: 'evaluate';
  resolve: (r: { results: Map<string, EvalResult> }) => void;
  lastCellStarted: string | null;
  objects: readonly FormulaObject[];
  timer: ReturnType<typeof setTimeout>;
};
type PendingSelection = {
  kind: 'selection';
  resolve: (r: SelectionInfo) => void;
  field: 'input' | 'result';
  latex: string;
  timer: ReturnType<typeof setTimeout>;
};
type PendingApproximate = {
  kind: 'approximate';
  resolve: (latex: string) => void;
  latex: string;
  timer: ReturnType<typeof setTimeout>;
};
type Pending = PendingEvaluate | PendingSelection | PendingApproximate;

let worker: Worker | null = null;
let nextRequestId = 0;
const pending = new Map<number, Pending>();

/** id → 타임아웃 났던 셀의 latex. 무한 재시도 방지 장치 (위 문서 참고). */
const timedOutLatex = new Map<string, string>();

function handleMessage(ev: MessageEvent<WorkerResponse>): void {
  const msg = ev.data;
  const entry = pending.get(msg.id);
  if (entry === undefined) return;
  if (msg.kind === 'cellStart') {
    if (entry.kind === 'evaluate') entry.lastCellStarted = msg.cellId;
    return;
  }
  clearTimeout(entry.timer);
  pending.delete(msg.id);
  if (msg.request === 'evaluate' && entry.kind === 'evaluate') {
    entry.resolve({ results: new Map(msg.results) });
  } else if (msg.request === 'selection' && entry.kind === 'selection') {
    entry.resolve(msg.selection);
  } else if (msg.request === 'approximate' && entry.kind === 'approximate') {
    entry.resolve(msg.latex);
  }
}

function spawnWorker(): Worker {
  const w = new Worker(new URL('./algebra.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = handleMessage;
  return w;
}

function ensureWorker(): Worker {
  worker ??= spawnWorker();
  return worker;
}

/** 강제 종료 후 새로 띄운다. 대기 중이던 다른 요청은 응답을 영영 못 받는다 — 호출자가 각자 타임아웃으로 정리한다. */
function respawn(): void {
  worker?.terminate();
  worker = spawnWorker();
}

/** 지난 타임아웃이 여전히 유효한지 — 그 셀의 latex가 바뀌었으면 다시 기회를 준다. */
function pruneTimedOut(objects: readonly FormulaObject[]): void {
  for (const [id, latex] of timedOutLatex) {
    const obj = objects.find((o) => o.id === id);
    if (obj === undefined || obj.latex !== latex) timedOutLatex.delete(id);
  }
}

export async function evaluateCellsAsync(
  objects: readonly FormulaObject[],
): Promise<{ results: Map<string, EvalResult> }> {
  if (typeof Worker === 'undefined') return evaluateCellsFallback(objects);

  pruneTimedOut(objects);
  const forceTimeoutIds = [...timedOutLatex.keys()];

  const w = ensureWorker();
  const id = nextRequestId++;
  return new Promise((resolve) => {
    const entry: PendingEvaluate = {
      kind: 'evaluate',
      resolve,
      lastCellStarted: null,
      objects,
      timer: setTimeout(() => {
        pending.delete(id);
        const culprit = entry.lastCellStarted;
        if (culprit !== null) {
          const obj = objects.find((o) => o.id === culprit);
          if (obj !== undefined) timedOutLatex.set(culprit, obj.latex);
        }
        respawn();
        // 범인 셀은 이제 forceTimeoutIds가 막으므로 재시도가 같은 자리에서 다시 안 멈춘다.
        evaluateCellsAsync(objects).then(resolve);
      }, WORKER_TIMEOUT_MS),
    };
    pending.set(id, entry);
    const req: EvaluateRequest = { id, kind: 'evaluate', objects, forceTimeoutIds };
    w.postMessage(req);
  });
}

export async function readSelectionAsync(
  field: 'input' | 'result',
  latex: string,
): Promise<SelectionInfo> {
  if (typeof Worker === 'undefined') return readSelectionFallback(field, latex);

  const w = ensureWorker();
  const id = nextRequestId++;
  return new Promise((resolve) => {
    const entry: PendingSelection = {
      kind: 'selection',
      resolve,
      field,
      latex,
      timer: setTimeout(() => {
        pending.delete(id);
        respawn();
        resolve({ field, latex, replacements: {}, solveSymbol: null, error: 'Computation timed out' });
      }, WORKER_TIMEOUT_MS),
    };
    pending.set(id, entry);
    const req: SelectionRequest = { id, kind: 'selection', field, latex };
    w.postMessage(req);
  });
}

/**
 * 결과 행의 numeric 표시 모드 — 이미 계산된 결과 LaTeX을 수치로 편다.
 *
 * 타임아웃이나 실패면 **입력을 그대로 돌려준다**. 표시 모드는 편의 기능이라 결과 행을
 * 오류로 만들지 않는다 — 토글을 켰는데 아무 변화가 없으면 "못 폈다"는 뜻이다.
 */
export async function approximateAsync(latex: string): Promise<string> {
  if (typeof Worker === 'undefined') return approximateFallback(latex);

  const w = ensureWorker();
  const id = nextRequestId++;
  return new Promise((resolve) => {
    const entry: PendingApproximate = {
      kind: 'approximate',
      resolve,
      latex,
      timer: setTimeout(() => {
        pending.delete(id);
        respawn();
        resolve(latex);
      }, WORKER_TIMEOUT_MS),
    };
    pending.set(id, entry);
    const req: ApproximateRequest = { id, kind: 'approximate', latex };
    w.postMessage(req);
  });
}

// ---------------------------------------------------------------------------
// Worker 없는 환경(단위 테스트 등) 폴백 — 같은 모듈 함수를 인라인 호출한다.
//
// **동적 import다** — 정적으로 끌어오면 `cellGraph`/`cellSelection`(그리고 그 밑의 CE
// 전체)이 메인 스레드 번들에도 딸려 들어가, 워커로 CE를 떼어낸 요점이 반쯤 무색해진다
// (실측: 정적 import였을 때 메인 청크가 워커 청크만큼 커졌다). `Worker`가 있는 보통의
// 브라우저에서는 이 분기 자체가 안 타므로 이 청크는 아예 안 받아온다.
// ---------------------------------------------------------------------------

let fallbackEnv: Env = { shapes: {} };

async function evaluateCellsFallback(
  objects: readonly FormulaObject[],
): Promise<{ results: Map<string, EvalResult> }> {
  const { evaluateCells } = await import('../cellGraph');
  const { results, env } = evaluateCells(objects);
  fallbackEnv = env;
  return { results };
}

async function readSelectionFallback(field: 'input' | 'result', latex: string): Promise<SelectionInfo> {
  const { readSelection } = await import('./readSelection');
  return readSelection(field, latex, fallbackEnv);
}

async function approximateFallback(latex: string): Promise<string> {
  const { approximateResult } = await import('./approximateResult');
  return approximateResult(latex, fallbackEnv);
}
