import type { MathfieldElement } from 'mathlive';

/**
 * 지금 편집 중인(또는 가장 최근에 편집했던) mathfield. `KeyPalette.tsx`가 어느
 * 필드로 `feedKey`를 흘릴지 알아야 하는데, MathLive의 `focusedMathfield()`는
 * export되지 않는다 — 그래서 `MathField.tsx`의 `focusin`에서 여기 갱신한다.
 *
 * focusout에서는 **지우지 않는다.** 팔레트 버튼은 `pointerdown`에서
 * `preventDefault`해 포커스를 안 뺏으므로(`SelectionToolbar`/`TransformButtons`와
 * 같은 관행) 클릭으로는 애초에 focusout이 안 난다 — 지운다면 오히려 "필드 밖 다른
 * 곳을 눌렀다가 팔레트로 돌아온" 경우에 대상을 잃는다. 가장 최근 필드를 계속
 * 들고 있는 쪽이 가상 키보드의 통상적인 동작과도 맞는다.
 */
let active: MathfieldElement | null = null;

export function setActiveMathField(mf: MathfieldElement): void {
  active = mf;
}

export function getActiveMathField(): MathfieldElement | null {
  return active;
}
