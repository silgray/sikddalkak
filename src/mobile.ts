/**
 * 모바일 판정의 **단일 기준점**.
 *
 * 판정은 **화면 폭이 아니라 주 입력 장치**를 본다. 모바일 UI가 필요한 이유가
 * 화면이 좁아서가 아니라 **물리 키보드가 없고 손가락으로 만지기 때문**이라서다 —
 * 키 팔레트(`styles/keyPalette.css` 가 "데스크톱에서는 물리 키보드가 있으니
 * 숨긴다"고 적은 그것), 선택 핸들, 홀드 선택, 콜아웃 억제가 전부 손가락에 달린
 * 기능이다. 폭은 그 사실의 대리 지표였을 뿐이라 태블릿(손가락인데 넓다)과 좁힌
 * 데스크톱 창(마우스인데 좁다) 양쪽에서 틀렸다.
 *
 * ⚠ **`any-pointer` 를 쓰면 안 된다.** `pointer` 는 **주** 포인터를, `any-pointer` 는
 * "하나라도 있는가" 를 묻는다. 터치스크린 노트북에서 `any-pointer: coarse` 는 참이라
 * (실측: 이 개발 PC가 `maxTouchPoints: 10`) 물리 키보드가 달린 노트북이 모바일 UI로
 * 넘어간다. `pointer: coarse` 는 같은 기기에서 거짓이다 — 주 포인터가 트랙패드라서다.
 *
 * `(hover: none)` 을 덧붙이지 않는 것도 실측 때문이다 — 폰·태블릿·에뮬레이션·데스크톱
 * 어디서도 `pointer: coarse` 와 값이 갈리지 않았다. 판별력은 안 늘고, 아래 CSS 13곳과
 * 문자열로 맞춰야 할 조건만 길어진다.
 *
 * 바꾸려면 `MOBILE_QUERY` 를 고치고 `src/styles/mediaQuery.test.ts` 가 짚어 주는 CSS
 * 파일들을 따라 고친다(그 파일이 `src/styles/*.css` 의 모든 `@media` 를 이 상수와
 * 대조한다). 셰도우 CSS(`components/MathField.tsx`)는 이 상수를 보간하므로 자동이다.
 */

/** `src/styles/*.css` 의 모바일 미디어쿼리와 **같아야 하는** 조건(테스트로 묶여 있다). */
export const MOBILE_QUERY = '(pointer: coarse)';

/**
 * 지금 이 기기가 모바일인가(=주 입력이 손가락인가). 포인터가 바뀔 수 있으므로
 * (태블릿에 마우스를 꽂는 식) **호출 시점마다** 묻는다 — 모듈 로드 시점에 캐시하지
 * 않는다.
 */
export function isMobileDevice(): boolean {
  return window.matchMedia(MOBILE_QUERY).matches;
}

/**
 * 모바일 여부가 **바뀔 때** 알려준다. 반환값은 구독 해제.
 *
 * ⚠ 폭 기준일 때와 달리 **거의 발화하지 않는다** — 창 크기 변경·회전으로는 주 포인터가
 * 안 바뀐다(마우스를 꽂고 빼는 정도라야 바뀐다). 회전·리사이즈에 따라 다시 재야 하는
 * 쪽(`components/SelectionHandles.tsx`)은 이걸 믿지 말고 `ResizeObserver` 를 쓴다.
 */
export function onMobileChange(listener: () => void): () => void {
  const list = window.matchMedia(MOBILE_QUERY);
  list.addEventListener('change', listener);
  return () => list.removeEventListener('change', listener);
}
