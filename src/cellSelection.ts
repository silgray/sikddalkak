/**
 * 선택 영역 변환 — **모양뿐**. 실제 계산(`readSelection`)은 `worker/readSelection.ts` 에
 * 있다 — 거기는 algebra(와 그 CE)를 통째로 끌고 오므로, UI(`Cell.tsx`)가 이 파일이
 * 아니라 그쪽을 정적으로 import하면 CE가 메인 스레드 번들에도 따라 들어간다(실측:
 * 빌드했더니 메인 청크가 워커 청크만큼 커졌다 — 워커로 CE를 떼어낸 요점이 무색해진다).
 * 그래서 이 파일은 **algebra를 전혀 모른다** — 타입과 상수뿐이다.
 */

/** 선택 위에서 제공하는 변환. algebra의 `TransformOp` 과 같다 — 넷 다 버튼으로 낸다. */
export type SelectionOp = 'expand' | 'simplify' | 'factor' | 'substitute';

export const TRANSFORM_OPS: readonly SelectionOp[] = ['expand', 'simplify', 'factor', 'substitute'];

/** 현재 선택 상태: 어느 필드에서, 무엇이 선택됐고, 어떤 변환이 가능한지. */
export type SelectionInfo = {
  field: 'input' | 'result';
  latex: string;
  replacements: Partial<Record<SelectionOp, string>>;
  /** 선택이 단일 심볼이면 그 이름, 아니면 `null` — `solve for` 버튼 노출 판정에 쓴다. */
  solveSymbol: string | null;
  /**
   * algebra가 이 선택을 아예 못 읽었을 때의 이유 (모양 불일치·모호한 순서·미지원).
   * 버튼 대신 이걸 보여준다 — 무엇을 아직 못 하는지가 보여야 다음에 뭘 깎을지 안다.
   */
  error: string | null;
};
