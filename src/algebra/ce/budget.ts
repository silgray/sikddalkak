/**
 * CE 호출에 **벽시계 상한**을 건다.
 *
 * 왜 필요한가: CE 0.90의 심볼릭 적분은 어떤 입력에서 **영원히 안 끝난다**. 실측 —
 * `\int_{-\pi}^{\pi}\frac{1}{2}e^{3x}\sin(2x)dx` 는 `.evaluate()` 안에서 안 돌아온다
 * (`e^{x}\sin(2x)` 는 111ms 만에 풀린다. 지수 계수가 달라지면 갈리는 CE 쪽 버그다).
 * 우리 코드는 전부 동기 호출이라 이게 곧 **앱 프리즈**다 — 브라우저 탭이 통째로 멈춘다.
 *
 * 어떻게 막나: CE가 제공하는 `withTimeLimit` 이 데드라인을 평가 루프 안에서 검사하고
 * `CancellationError` 를 던진다(실측으로 확인 — 위 적분이 정확히 상한 시점에 끊긴다).
 * CE 호출부는 이미 전부 `try/catch → 원래 노드 유지` 규약을 지키고 있으므로, 상한이
 * 걸리면 자연스럽게 "안 접힘"(미평가 적분 그대로)이 된다.
 *
 * **예산은 호출당이 아니라 연산당이다.** 호출당 상한이면 행렬 원소별 적분처럼 CE를
 * n번 부르는 경로에서 `n × 상한` 으로 불어나 상한의 뜻이 없어진다. 그래서 바깥
 * 진입점(`evaluate`, `transform`)이 `withCeBudget` 으로 데드라인을 **한 번** 깔고,
 * 안쪽 CE 호출들은 `guardCe` 로 그 남은 시간을 나눠 쓴다.
 */

/**
 * `ComputeEngine.withTimeLimit` 의 구조적 타입.
 *
 * 0.90의 `IComputeEngine` 인터페이스에는 이 메서드가 선언돼 있지 않다(`getDefaultCeEngine()`
 * 이 그 타입을 돌려준다). 실체에는 있으므로(실측) 구조적으로 받는다.
 */
export type TimeLimitedEngine = {
  withTimeLimit<T>(limit: { ms: number; label?: string }, fn: () => T): T;
};

/** 한 번의 `evaluate`/`transform` 전체가 CE 계산에 쓸 수 있는 총 시간(ms). */
export const CE_BUDGET_MS = 2000;

/** 현재 열려 있는 예산의 만료 시각. 열려 있지 않으면 `null`. */
let deadline: number | null = null;

/**
 * `fn` 이 도는 동안 CE 예산을 연다. **중첩되면 바깥 예산을 그대로 쓴다** — 안쪽에서
 * 다시 열어 시간을 늘려주면 상한의 뜻이 없어진다(`foldIntegral` 이 본문을 `evaluate`
 * 로 재귀하는 것처럼 진입점은 실제로 중첩된다).
 */
export function withCeBudget<T>(fn: () => T): T {
  if (deadline !== null) return fn();
  deadline = Date.now() + CE_BUDGET_MS;
  try {
    return fn();
  } finally {
    deadline = null;
  }
}

/**
 * CE 호출 하나를 남은 예산 안에서 돌린다. 예산을 넘기면 `CancellationError` 가 나오고,
 * 그건 호출부의 `catch` 가 "못 접었다"로 받는다.
 *
 * 예산이 안 열려 있으면(단위 테스트가 내부 함수를 직접 부르는 경우 등) 통째로 한 번
 * 쓰는 걸로 친다 — 상한 없이 도는 경로는 만들지 않는다.
 */
export function guardCe<T>(engine: TimeLimitedEngine, label: string, fn: () => T): T {
  const remaining = deadline === null ? CE_BUDGET_MS : deadline - Date.now();
  return engine.withTimeLimit({ ms: Math.max(1, remaining), label }, fn);
}
