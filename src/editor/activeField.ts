import type { MathfieldElement } from 'mathlive';

/**
 * 어느 필드를 편집하고 있는가 — 이 앱에서 **포커스의 단일 게이트**다.
 * 쓰는 곳은 `MathField.tsx` 의 focusin/focusout/언마운트 셋뿐이고, 나머지는 읽기만 한다
 * (`repairLatex` 가 구조를, `normalizeSelection` 이 선택을 맡는 것과 같은 자리).
 *
 * 두 가지를 함께 두되 **이름으로 뜻을 가른다** (CLAUDE.md §이름 규칙 — 한 단어는
 * 한 가지만 가리킨다):
 *
 * - **`focused` — 지금.** 이 순간 DOM 포커스를 쥔 필드. 없으면 `null`.
 *   키 팔레트를 띄울지 말지가 이 값에 걸린다(`KeyPalette.tsx`).
 * - **`active` — 마지막.** `focused` 의 마지막 non-null 값. 포커스가 빠져도
 *   **안 지운다.** 팔레트가 대상을 잃지 않게 하려는 것이다: 버튼은 `pointerdown`
 *   에서 `preventDefault` 해 포커스를 안 뺏으므로 클릭으로는 애초에 focusout이
 *   안 나지만, "필드 밖을 눌렀다가 팔레트로 돌아온" 경우까지 버티려면 끈끈해야 한다.
 *
 * 예전엔 `active` 를 `focusin` 에서 **따로** 갱신했다 — 같은 사실을 두 곳이 각각
 * 추적하는 꼴이라 `focused` 가 생기는 순간 어긋날 자리가 하나 는다. 지금은 파생이다.
 *
 * ⚠ **여기 안 사는 "포커스" 가 둘 더 있다.** 합칠 것이 아니라 뜻이 다른 것들이다:
 * `tab.focus`(`state/workspace.ts`)는 "여기로 **보내라**" 는 명령이고(토큰 일회성),
 * `touchGesture.ts` 의 캐럿 이동단은 DOM Selection 의 anchor/focus 어휘다.
 */

let focused: MathfieldElement | null = null;
let active: MathfieldElement | null = null;

/**
 * focusin 세대. 아래 지연 판정이 "그 사이 새 필드가 잡았나" 를 이 값으로 가린다 —
 * 필드 참조만 봐서는 A→B→A 로 되돌아온 경우를 구별할 수 없다.
 */
let generation = 0;

const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/**
 * 이 필드가 **아직도** DOM 상 포커스인가.
 *
 * 창 포커스 전환(alt-tab, 앱 전환)에서는 focusout 이 나지만 `document.activeElement`
 * 는 그대로 남는다 — 그래서 돌아왔을 때 하던 자리가 살아 있다. 그 경우엔 포커스를
 * 놓지 않는다: `focusout` 핸들러가 `relatedTarget === null` 일 때 선택을 안 푸는 것과
 * 같은 판단이다(`MathField.tsx`).
 *
 * `math-field` 는 셰도우 루트 안 키보드 싱크가 실제 포커스를 쥐지만,
 * `document.activeElement` 는 셰도우 경계에서 **호스트로 되짚어** 주므로 그대로 비교하면 된다.
 */
function stillFocused(mf: MathfieldElement): boolean {
  return mf.isConnected && document.activeElement === mf;
}

/** 이 필드가 포커스를 잡았다. `MathField.tsx` 의 `focusin` 이 부르는 유일한 창구. */
export function notifyFieldFocus(mf: MathfieldElement): void {
  generation += 1;
  if (focused === mf) return;
  focused = mf;
  active = mf;
  emit();
}

/**
 * 이 필드에서 포커스가 빠졌다. **바로 확정하지 않는다.**
 *
 * 셀에서 셀로 옮기면 focusout(A) → focusin(B) 가 잇따라 나므로, 즉시 `null` 로 놓으면
 * 그 틈에 팔레트가 접혔다 펴진다 — `.app` 의 바닥 여백이 `--palette-h` 로 묶여 있어
 * (`styles/base.css`) 내용까지 통째로 튄다. 한 태스크 뒤에 다시 보고, 그 사이 아무도
 * 안 잡았을 때만 놓는다.
 */
export function notifyFieldBlur(mf: MathfieldElement): void {
  if (focused !== mf) return;
  const g = generation;
  setTimeout(() => {
    if (generation !== g) return; // 그 사이 다른 필드가 잡았다
    if (focused !== mf) return;
    if (stillFocused(mf)) return; // 창 포커스 전환 — 놓지 않는다
    focused = null;
    emit();
  }, 0);
}

/**
 * 필드가 DOM에서 떨어진다(언마운트).
 *
 * 포커스된 채 `remove()` 되면 브라우저는 focusout 을 **안 쏜다** — 포커스가 조용히
 * body로 넘어갈 뿐이다. 그래서 여기서 직접 알려야 이미 사라진 필드가 "포커스 중" 으로
 * 남지 않는다. `active` 는 반대로 **즉시** 지운다: 끈끈한 게 존재 이유지만 떨어져 나간
 * 필드까지 붙들 이유는 없고, 그대로 두면 팔레트가 detached 엘리먼트로 키를 흘린다.
 *
 * 확정 자체는 `notifyFieldBlur` 와 같은 지연 판정이다 — 셀을 지우면 곧바로 이웃 셀이
 * 포커스를 받으므로 즉시 놓으면 역시 깜빡인다.
 */
export function notifyFieldRemoved(mf: MathfieldElement): void {
  if (active === mf) active = null;
  notifyFieldBlur(mf);
}

/** 마지막으로 편집하던 필드(끈끈함). 팔레트가 키를 흘려보낼 대상. */
export function getActiveMathField(): MathfieldElement | null {
  return active;
}

/** 지금 포커스를 쥔 필드. 없으면 `null`. */
export function getFocusedMathField(): MathfieldElement | null {
  return focused;
}

/**
 * 포커스된 필드가 하나라도 있나. `useSyncExternalStore` 의 스냅샷으로 쓰라고
 * 불리언이다 — 필드 참조를 그대로 주면 리렌더 판정이 매번 흔들린다.
 */
export function isFieldFocused(): boolean {
  return focused !== null;
}

/**
 * 포커스 변화 구독. 이 모듈은 React를 모르므로(에디터 층 규율) 훅은 쓰는 쪽에서
 * 만든다 — `KeyPalette.tsx` 가 `useSyncExternalStore` 로 받는다.
 */
export function subscribeFieldFocus(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
