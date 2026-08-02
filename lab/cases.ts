import type { TransformOp } from '../src/algebra';

/**
 * 케이스 목록 — **사람 판정을 기록으로 남기는 곳.**
 *
 * 정리된 식의 "꼴"이 적절한지는 자동 판정이 어렵다 (값이 맞는지는 퍼즈가 보지만, 보기
 * 좋은지는 못 본다). 그래서 사람이 보고 OK/NG를 찍고, 그 판정을 저장해 다음 변경 때
 * 같은 케이스를 다시 확인한다.
 */

export type Definition = { readonly id: string; readonly name: string; readonly latex: string };

export type Verdict = 'ok' | 'ng' | 'hold';

export type LabCase = {
  readonly id: string;
  readonly title: string;
  readonly definitions: readonly Definition[];
  readonly expression: string;
  readonly op: TransformOp;
  /** 사람이 적어두는 기대 결과 (LaTeX). 비워둬도 된다. */
  readonly expected: string;
  /** 저장 시점의 실제 결과 — 나중에 달라지면 눈에 띈다. */
  readonly actual: string;
  readonly verdict: Verdict | null;
  readonly note: string;
};

const STORAGE_KEY = 'sikddalkak.algebra-lab.v1';

export type LabState = {
  readonly definitions: readonly Definition[];
  readonly expression: string;
  readonly op: TransformOp;
  readonly cases: readonly LabCase[];
};

export const newId = (): string => Math.random().toString(36).slice(2, 10);

/** 설계 문서의 예시들 — 처음 열었을 때 바로 만져볼 게 있어야 한다. */
export const INITIAL_STATE: LabState = {
  definitions: [
    { id: newId(), name: 'v', latex: String.raw`\begin{pmatrix}1\\2\\3\end{pmatrix}` },
    { id: newId(), name: 'w', latex: String.raw`\begin{pmatrix}0\\1\\-1\end{pmatrix}` },
    {
      id: newId(),
      name: 'A',
      latex: String.raw`\begin{pmatrix}1&2&0\\0&1&3\\4&0&1\end{pmatrix}`,
    },
    {
      id: newId(),
      name: 'B',
      latex: String.raw`\begin{pmatrix}2&0&1\\1&1&0\\0&3&2\end{pmatrix}`,
    },
    { id: newId(), name: 'a', latex: '3' },
  ],
  expression: String.raw`v^T\left(A+B\right)v`,
  op: 'expand',
  cases: [],
};

export function loadState(): LabState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return INITIAL_STATE;
    const parsed = JSON.parse(raw) as Partial<LabState>;
    return {
      definitions: parsed.definitions ?? INITIAL_STATE.definitions,
      expression: parsed.expression ?? INITIAL_STATE.expression,
      op: parsed.op ?? INITIAL_STATE.op,
      cases: parsed.cases ?? [],
    };
  } catch {
    // 저장된 게 깨졌다고 랩을 못 열면 곤란하다 — 초기 상태로 시작한다.
    return INITIAL_STATE;
  }
}

export function saveState(state: LabState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 용량 초과 등. 저장만 못 할 뿐 랩은 계속 쓸 수 있어야 한다.
  }
}
