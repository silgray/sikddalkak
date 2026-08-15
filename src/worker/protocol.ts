import type { FormulaObject, EvalResult } from '../types';
import type { SelectionInfo } from '../cellSelection';

/**
 * `algebra.worker.ts`(워커) ↔ `client.ts`(메인 스레드) 메시지 형식. 한 파일에 모아둔 건
 * 두 쪽이 같은 모양을 어긋남 없이 써야 해서다 — 타입만 있고 값은 없으니 워커 번들에도
 * 메인 번들에도 그대로 안전하게 끼어든다.
 *
 * `results` 를 `Map` 그대로 안 보내고 `[key, value][]` 로 펴는 이유: 구조화 복제가
 * `Map` 을 지원하긴 하지만, 요청/응답을 짝짓는 `id` 와 나란히 두는 평범한 배열이 더
 * 다루기 쉽고 테스트하기 쉽다.
 */

export type EvaluateRequest = {
  readonly id: number;
  readonly kind: 'evaluate';
  readonly objects: readonly FormulaObject[];
  /** `cellGraph.ts` 의 `EvaluateCellsOptions.forceTimeoutIds` 로 그대로 간다. */
  readonly forceTimeoutIds: readonly string[];
};

export type SelectionRequest = {
  readonly id: number;
  readonly kind: 'selection';
  readonly field: 'input' | 'result';
  readonly latex: string;
};

/**
 * 결과 행의 numeric 표시 모드 — 이미 계산된 결과 LaTeX을 수치로 편다
 * (`algebra/transform/approximate.ts`). `evaluate` 와 갈라둔 이유: 표시 모드를 켠
 * 그룹 하나에만 필요한 계산이라, 켤 때마다 문서 전체를 다시 돌릴 이유가 없다.
 */
export type ApproximateRequest = {
  readonly id: number;
  readonly kind: 'approximate';
  readonly latex: string;
};

export type WorkerRequest = EvaluateRequest | SelectionRequest | ApproximateRequest;

/** 계산 중인 셀을 실시간으로 알린다 — 타임아웃으로 워커를 죽여야 할 때 범인을 지목하는 유일한 수단. */
export type CellStartMessage = {
  readonly id: number;
  readonly kind: 'cellStart';
  readonly cellId: string;
};

export type EvaluateDoneMessage = {
  readonly id: number;
  readonly kind: 'done';
  readonly request: 'evaluate';
  readonly results: readonly (readonly [string, EvalResult])[];
};

export type SelectionDoneMessage = {
  readonly id: number;
  readonly kind: 'done';
  readonly request: 'selection';
  readonly selection: SelectionInfo;
};

export type ApproximateDoneMessage = {
  readonly id: number;
  readonly kind: 'done';
  readonly request: 'approximate';
  /** 수치로 편 LaTeX. 펼 수 없었으면 입력과 같다 (오류로 만들지 않는다). */
  readonly latex: string;
};

export type WorkerResponse =
  | CellStartMessage
  | EvaluateDoneMessage
  | SelectionDoneMessage
  | ApproximateDoneMessage;
