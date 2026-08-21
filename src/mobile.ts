/**
 * 모바일 판정의 **단일 기준점**.
 *
 * 이 브랜치의 대원칙(CLAUDE.md §대원칙)은 "모바일에만 적용" 이고, 그걸 지키는
 * 방법 중 둘째가 "JS 분기가 꼭 필요하면 CSS와 **같은 640px 기준**을 쓴다" 이다.
 * 기준이 두 벌이 되면 CSS는 모바일 레이아웃인데 JS는 데스크톱 동작인 구간이
 * 생기므로, 그 기준을 여기 하나로 모은다 — 바꿔야 하면 `styles.css` 맨 아래
 * `@media (max-width: 640px)` 와 여기, 두 곳을 같이 고친다.
 */

/** `styles.css` 의 모바일 미디어쿼리와 **같은** 임계값. */
const MOBILE_QUERY = '(max-width: 640px)';

/**
 * 지금 뷰포트가 모바일 폭인가. 창 크기가 바뀌면 값도 바뀌므로 **호출 시점마다**
 * 묻는다(모듈 로드 시점에 캐시하지 않는다 — 회전·창 크기 변경에 안 따라온다).
 */
export function isMobileViewport(): boolean {
  return window.matchMedia(MOBILE_QUERY).matches;
}
