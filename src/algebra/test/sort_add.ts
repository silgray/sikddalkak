import { compareScalars, compareTerms } from '../transform/prettifyOrder';

/**
 * `prettify` 정렬 기준 실험대. **본 기준은 `transform/prettifyOrder.ts` 로 옮겨갔다** —
 * 여기서는 그걸 가져다 쓰고, 새 변형을 시험해볼 때만 이 파일에 추가한다(기준을 두 벌
 * 유지하지 않는 게 요점).
 */
export const sort_keys = [
  { termKey: compareTerms, mulKey: compareScalars },
];
