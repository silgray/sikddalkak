import type { MathfieldElement } from 'mathlive';
import { keyboardSinkOf } from './internals';

/**
 * 키 하나를 흘려보낼 때 실을 최소 정보. `KeyboardEvent`의 부분집합이지만 우리가
 * 실제로 쓰는 필드만 남겼다 — `code`는 키바인딩 매칭(`keyboardEventToString`,
 * MathLive 실측)에, `key`는 문자 삽입 폴백에 쓴다.
 */
export type KeyStroke = {
  /** `KeyboardEvent.key` — 'a', '(', 'Backspace', 'ArrowLeft' 등. */
  key: string;
  /** `KeyboardEvent.code` — 'KeyA', 'Minus' 등. 없으면 키바인딩은 안 걸린다(아래 참고). */
  code?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
};

/** ctrl/meta 없고 한 글자면 "문자 삽입 후보" — MathLive의 `mightProducePrintableCharacter`
 * 와 같은 취지(실측: ctrlKey/metaKey 없고 PRINTABLE_KEYCODE 소속). 우리는 `code` 표를
 * 그대로 흉내내지 않고 `key.length === 1` 로 간이 판정한다 — 팔레트가 흘리는 키는
 * 전부 우리가 정의한 값이라 통제 가능하다. */
function isPrintable(stroke: KeyStroke): boolean {
  return !stroke.ctrlKey && !stroke.metaKey && stroke.key.length === 1;
}

/**
 * 키 입력 하나를 물리 키보드와 **같은 경로**로 흘려보낸다 — 자체 팔레트(`KeyPalette.tsx`)
 * 전용 funnel.
 *
 * MathLive는 `.ML__keyboard-sink`(셰도우 DOM 안 contenteditable)에서 keydown을 듣고
 * `onKeystroke`로 넘긴다 — 인라인 숏컷·키바인딩이 전부 거기 산다(실측,
 * `keyboardSinkOf` 문서 참고). 호스트가 아니라 **싱크**로 쏴야 하는 이유가 그것이다.
 * `composed: true`라 셰도우 경계를 넘어 `MathField.tsx`의 호스트 capture 리스너
 * (`keyOps.ts` 디스패치, 앱 단축키)도 실제 입력과 같은 순서로 먼저 지나간다.
 *
 * ⚠ **문자 삽입은 keydown만으로 안 된다.** 실제 키 입력에서 문자가 들어가는 경로는
 * "onKeystroke가 처리 안 하고 반환(true) → 브라우저가 contenteditable에 네이티브로
 * 삽입 → 그 네이티브 `input` 이벤트를 MathLive가 듣고 `insertMathModeChar`로 모델에
 * 반영"이다(mathlive.mjs 실측, `delegateKeyboardEvents`의 별도 `input` 리스너 —
 * `onKeystroke`와 별개 함수 호출). 그런데 **합성 `KeyboardEvent`는 브라우저의 기본
 * 텍스트 삽입 동작을 유발하지 않는다** — 그래서 keydown이 `defaultPrevented`가 안 됐고
 * 출력 가능한 키라면, `execCommand('insertText', …)`로 그 "네이티브 삽입" 단계를
 * 대신한다. 이게 정확히 실제 브라우저의 두 번째 단계와 같은 이유는, execCommand도
 * 진짜 `input` 이벤트를 쏘고 그걸 MathLive의 **일반** `input` 리스너가 받아
 * `insertMathModeChar`로 넘기기 때문이다(옵션 없이, `onKeystroke`를 다시 안 부른다).
 *
 * ⚠ **`mf.executeCommand(['typedText', …, {simulateKeystroke:false}])`를 대신 쓰면
 * 안 된다(실측, `editor.browser.test.tsx`의 핀).** 그 경로도 결국
 * `insertMathModeChar`를 부르지만, **미완성 숏컷 접두어(`sqrt`의 `s`·`q`·`r`)까지
 * 그 자리에서 리터럴로 박아버린다** — 나중에 4번째 글자로 숏컷이 완성돼도 이미 박힌
 * 글자들과 안 엮인다. `execCommand`는 진짜 브라우저 삽입 경로를 타므로 `onKeystroke`가
 * 매 글자마다 미리 찍어둔 `model.getState()` 스냅샷과 시점이 맞아떨어져, 숏컷이
 * 완성되는 순간 `model.setState()` 되감기가 미완성 접두어를 정확히 지워낸다.
 */
export function feedKey(mf: MathfieldElement, stroke: KeyStroke): void {
  const sink = keyboardSinkOf(mf);
  if (sink === null) return;

  const ev = new KeyboardEvent('keydown', {
    key: stroke.key,
    code: stroke.code ?? '',
    shiftKey: stroke.shiftKey ?? false,
    ctrlKey: stroke.ctrlKey ?? false,
    altKey: stroke.altKey ?? false,
    metaKey: stroke.metaKey ?? false,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  sink.dispatchEvent(ev);

  if (ev.defaultPrevented) return;
  if (!isPrintable(stroke)) return;
  sink.focus({ preventScroll: true });
  document.execCommand('insertText', false, stroke.key);
}
