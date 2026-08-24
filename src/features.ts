/**
 * solve(등식 풀기) 노출 여부.
 *
 * CE 0.90 이 초월식(`\cos(x)=x` 등)을 못 풀고(빈 배열), 뉴턴 시작점을 넘길 API 도
 * 없어서 잠시 꺼둔다 — 조사 결과는 CLAUDE.md 의 CE 실측 함정 절에 있다.
 * **플러밍(상태·영속·UI)은 엔진과 무관하므로 그대로 둔다** — 더 나은 엔진을 찾으면
 * 여기만 `true` 로 뒤집으면 된다.
 */
export const SOLVE_ENABLED: boolean = false;

/**
 * URL 질의 문자열에 이 이름이 있으면 켠다 (`?atombox` 처럼).
 *
 * 디버그 스위치를 상수로 두면 켤 때마다 코드를 고쳐야 하는데, 이 브랜치의 실기기
 * 확인은 폰에서 배포본을 여는 식이라 그게 안 통한다. 질의 문자열이면 주소만
 * 고치면 되고 배포본에서도 쓸 수 있다. 워커에는 `location` 이 있어도 이 파라미터가
 * 안 붙으므로 자연히 꺼진다(워커는 아무 것도 안 그린다).
 */
function debugFlag(name: string): boolean {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').has(name);
  } catch {
    return false;
  }
}

/**
 * 디버그 오버레이: **원자 상자**에 1px 테두리를 씌울지 (`?atombox`).
 *
 * 히트테스트가 어긋나는 자리를 눈으로 짚으려고 만들었다. 원자와 원자 **사이 빈
 * 자리**(연산자 둘레 여백)가 문제의 진원지인데, 그 틈이 5~12px이라 상자를 안
 * 그리면 어디가 틈인지 알 수가 없다. 잎(글리프)은 파랑, 자식을 품은 컨테이너는
 * 빨강이라 **파란 상자 사이의 맨 자리가 곧 위험 구간**이다.
 *
 * ⚠ `first` 센티넬은 폭·높이가 0인 빈 span이라 여기 안 보인다 — 그런데 히트테스트가
 * 재는 그 원자의 상자는 **부모 컨테이너 전체**다(`editor/internals.ts` 의
 * `resolveOffsetAt` 참고). 즉 이 그림에 안 보이는 것이 실제로는 화면을 통째로
 * 덮고 있다. 그 어긋남이 곧 버그였다.
 *
 * `outline` 이라 레이아웃을 안 건드린다(`border` 면 글자가 밀린다).
 */
export const ATOM_BOX_DEBUG: boolean = debugFlag('atombox');

/**
 * 선택 핸들이 **반대쪽 캐럿을 넘어갈 수 있는지**.
 *
 * 켜면 끝 핸들을 시작보다 왼쪽으로 끌었을 때 역할이 뒤바뀌고, 넘어간 쪽이 새
 * 시작이 된다(`SelectionHandles.tsx`). 끄면 예전처럼 반대쪽 캐럿 바로 앞에서
 * 멈춘다 — 조작감을 견줘보려고 스위치로 남겼다.
 */
export const HANDLE_CROSSING: boolean = false;
