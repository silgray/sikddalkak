/**
 * solve(등식 풀기) 노출 여부.
 *
 * CE 0.90 이 초월식(`\cos(x)=x` 등)을 못 풀고(빈 배열), 뉴턴 시작점을 넘길 API 도
 * 없어서 잠시 꺼둔다 — 조사 결과는 CLAUDE.md 의 CE 실측 함정 절에 있다.
 * **플러밍(상태·영속·UI)은 엔진과 무관하므로 그대로 둔다** — 더 나은 엔진을 찾으면
 * 여기만 `true` 로 뒤집으면 된다.
 */
export const SOLVE_ENABLED: boolean = false;
