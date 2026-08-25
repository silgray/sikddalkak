/**
 * **손가락 좌표 → 히트테스트 좌표.** 손짓마다 "손가락이 가리키는 것" 이 달라서
 * 보정도 달라야 하는데, 그 차이를 값 하나(`TouchAim`)로 굳혀 두는 자리다.
 *
 * 왜 필요한가: 히트테스트(`internals.ts` 의 `resolveOffsetAt`)는 넘긴 점이 곧
 * 사용자가 찍고 싶은 자리라고 믿는다. 그런데 그게 참인 손짓은 **손가락으로 내용을
 * 직접 짚는 경우뿐**이다. 손잡이를 쥐는 손짓은 다르다 — 손잡이(물방울)는 선택 줄
 * **아래**에 매달려 있으니(`styles.css`), 손가락은 정작 짚고 싶은 글자보다 한참
 * 밑에 있다. 그 좌표를 그대로 넘기면 판정이 줄 밖으로 나가거나 아래 줄로 샌다.
 *
 * **왜 고정 px 이 아닌가.** "20px 위로" 같은 상수는 글꼴 크기·분수 높이가 바뀌면
 * 곧바로 틀린다. 대신 손짓이 **시작될 때** 손가락과 기준선의 거리를 한 번 재서
 * 그 값을 손짓 내내 쓴다(`gripAim`). 그러면
 *   ① 쥔 순간의 판정이 정확히 기준선(선택 줄 한가운데)에 떨어지고,
 *   ② 손가락을 위아래로 옮기면 판정도 **같은 양만큼** 따라 움직인다
 *      (분수의 분자/분모처럼 세로로 갈라진 구조를 손잡이로도 넘나들 수 있다).
 * 손잡이를 위쪽에서 잡든 아래쪽 끝을 잡든 시작점이 늘 기준선이 되는 것도 덤이다.
 *
 * **확장하는 법**: 손짓을 하나 더 만들면 그 손짓이 쓸 `TouchAim` 을 여기 하나 더
 * 만든다. 히트테스트를 부르는 쪽은 `aimedPoint` 만 거치면 되고, 어느 손짓이
 * 어떤 보정을 쓰는지는 그 손짓의 코드가 자기 자리에서 고른다 — 보정 규칙이
 * 히트테스트 안으로 새어 들어가지 않게 하려는 것이다(`resolveOffsetAt` 은 지금도
 * 앞으로도 "이 점" 만 안다).
 */

/** 손가락 좌표에 적용할 보정. 지금은 세로 하나뿐이지만 필드로 늘리면 된다. */
export type TouchAim = {
  /** 손가락 y에서 **뺄** 값 (양수 = 위로 올려 판정). */
  readonly liftY: number;
};

/**
 * 보정 없음 — 손가락이 짚은 그 자리가 곧 판정 자리.
 *
 * 홀드 선택(`touchGesture.ts`)이 이걸 쓴다. 그건 손잡이를 매개로 하지 않고
 * **손가락으로 내용을 직접 가리키는** 손짓이라, 눈에 보이는 자리와 판정이
 * 어긋나면 그 자체가 버그다.
 */
export const DIRECT_AIM: TouchAim = { liftY: 0 };

/**
 * 무언가를 **쥐고** 끄는 손짓용. 쥔 순간의 손가락 y(`fingerY`)와 실제로 가리키는
 * 기준선(`referenceY`)의 차이를 그대로 굳힌다.
 *
 * 손잡이 드래그(`SelectionHandles.tsx`)가 쓴다 — `referenceY` 는 선택 줄
 * 한가운데(`Placement.midY`)다.
 */
export function gripAim(fingerY: number, referenceY: number): TouchAim {
  return { liftY: fingerY - referenceY };
}

/** 손가락 좌표에 보정을 먹인 판정 좌표. 가로는 손대지 않는다. */
export function aimedPoint(
  aim: TouchAim,
  clientX: number,
  clientY: number,
): { readonly x: number; readonly y: number } {
  return { x: clientX, y: clientY - aim.liftY };
}
