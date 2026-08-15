import { evaluateCells } from '../cellGraph';
import { readSelection } from './readSelection';
import { approximateResult } from './approximateResult';
import type { Env } from '../algebra';
import type { WorkerRequest, WorkerResponse } from './protocol';

/**
 * CE 계산 전용 워커 — algebra의 CE 시간 예산(`ce/budget.ts`)은 **협조적**이라, CE 내부가
 * 스스로 데드라인을 확인하지 않는 경로(0.90의 일부 적분 등)에서는 무력하다. 그런 입력
 * 하나가 메인 스레드를 통째로 얼려버리는 걸 막으려고 CE 계산을 전부 이 쓰레드에 가둔다.
 * `worker/client.ts` 가 요청/응답을 짝짓고, 응답이 안 오면 이 워커를 통째로 죽인다
 * (`terminate()` — 유일하게 진짜로 먹히는 강제 중단 수단).
 *
 * **`Env`(셀 사이 심볼·행렬 정의)는 이 워커가 소유한다** — `selection` 요청은 가장 최근
 * `evaluate` 요청이 만든 env를 그대로 쓴다. 선택 변환과 결과 계산이 다른 env를 보면
 * "결과는 A를 행렬로 알고 계산했는데 변환 버튼은 A를 모른다" 같은 어긋남이 생긴다
 * (`cellGraph.ts` 의 `evaluateCells` 문서와 같은 이유). `cellGraph.ts` 의 지문 캐시도
 * 이 모듈 스코프에 자연히 딸려온다 — 워커가 죽으면(타임아웃) 캐시도 같이 사라진다.
 *
 * ⚠ `self` 를 `WebWorker` lib 타입 없이 쓴다 — 이 프로젝트는 React(DOM lib) 코드와
 * 한 tsconfig를 공유하는데, `DOM`과 `WebWorker` lib를 같이 켜면 전역 선언이 충돌한다
 * (`self`/`postMessage` 이중 정의). 그래서 딱 필요한 모양만 좁혀 캐스팅한다.
 */

type WorkerContext = {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (msg: WorkerResponse) => void;
};

const ctx = self as unknown as WorkerContext;

let lastEnv: Env = { shapes: {} };

ctx.onmessage = (ev) => {
  const req = ev.data;
  if (req.kind === 'evaluate') {
    const forceTimeoutIds = new Set(req.forceTimeoutIds);
    const { results, env } = evaluateCells(req.objects, {
      onCellStart: (cellId) => ctx.postMessage({ id: req.id, kind: 'cellStart', cellId }),
      forceTimeoutIds,
    });
    lastEnv = env;
    ctx.postMessage({ id: req.id, kind: 'done', request: 'evaluate', results: [...results.entries()] });
    return;
  }
  if (req.kind === 'approximate') {
    ctx.postMessage({
      id: req.id,
      kind: 'done',
      request: 'approximate',
      latex: approximateResult(req.latex, lastEnv),
    });
    return;
  }
  const selection = readSelection(req.field, req.latex, lastEnv);
  ctx.postMessage({ id: req.id, kind: 'done', request: 'selection', selection });
};
