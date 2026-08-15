import type { Keybinding, MathfieldElement } from 'mathlive';

/**
 * MathLive 기본 키바인딩(`mf.keybindings`, ctrl/alt/shift 조합) 레지스트리 —
 * `MathField.tsx` 의 `configureInlineShortcuts`(텍스트 자동변환 숏컷)와 같은 규율이다:
 * `BLOCKED_KEYBINDINGS` 에 있는 `key` 를 걷어내고 `CUSTOM_KEYBINDINGS` 를 얹는다.
 *
 * `mf.keybindings` getter가 돌려주는 건 모듈 전역 `DEFAULT_KEYBINDINGS` 배열 **그
 * 자체**다(실측) — 제자리에서 고치면 이 앱의 모든 mathfield는 물론 라이브러리
 * 기본값까지 오염된다. 반드시 `.filter()` 로 새 배열을 만들어 대입한다.
 *
 * ⚠ 같은 `key`+`ifMode` 를 뒤에 덧붙이면 MathLive가 "Ambiguous key binding" 으로 보고
 * **뒤에 붙인 쪽을 버린다**(실측, console.error). 그래서 기본 바인딩을 다른 동작으로
 * 덮어쓰려면 그 `key` 를 `BLOCKED_KEYBINDINGS` 에도 반드시 넣어야 한다.
 */

/**
 * 끌 MathLive 기본 키바인딩의 `key` 문자열. `node_modules/mathlive/mathlive.mjs` 의
 * `DEFAULT_KEYBINDINGS` 에서 실측한 값 그대로다 — 문자열이 하나라도 다르면 안 걸린다.
 *
 * **여기가 사용자가 편집하는 자리다.** 항목을 추가하면 그 키가 즉시 무력화되고,
 * 지우면 MathLive 기본 동작이 돌아온다.
 */
export const BLOCKED_KEYBINDINGS: ReadonlySet<string> = new Set<string>([
  // 기본 배열에는 없다(`RESERVED_KEYBINDINGS` 참고) — 이 자리를 우리가 갖는다는 선언으로
  // 남겨둔다. \overline 이 "가끔 안 먹던" 진짜 원인은 이게 아니라 커스텀 쪽 `key` 표기였다
  // (아래 `CUSTOM_KEYBINDINGS` 의 ⚠ 참고).
  'alt+-',

  // Ctrl+2 → \sqrt (Wolfram Mathematica 계열 바인딩)
  'ctrl+[Digit2]',
  // Alt+D → \differentialD
  'alt+d',
  // Shift+Alt+D → \partial
  'shift+alt+d',
  // Alt+V / Alt+Shift+V → \sqrt / n제곱근
  'alt+v',
  'alt+shift+v',
  // Alt+P → \pi
  'alt+p',
  // Alt+O / Shift+Alt+O → \emptyset / \varnothing
  'alt+o',
  'shift+alt+o',

  // Alt+\ → \backslash. **키 문자열이 `alt+\` 가 아니다** — MathLive는 이 자리에서
  // 물리 코드 표기를 쓴다(`mathlive.mjs:12496` 실측: `key: "alt+[Backslash]"`).
  // `alt+\\` 로 적어두면 배열에 그런 항목이 없어 필터가 조용히 no-op 이 된다.
  'alt+[Backslash]',
  // Alt+| → `|`. 이쪽은 문자 표기가 맞다(`mathlive.mjs:12692`). 단 `ifLayout` 로
  // en-intl 계열에만 걸려 있어 US 레이아웃에선 원래 안 살아난다 — 다른 레이아웃
  // 사용자를 위해 막아 둔다.
  'alt+|',

  // 행렬 크기는 삽입한 뒤 바뀌지 않는다(정책) — MathLive 기본 행/열 추가·삭제 키를
  // 전부 막는다. 예전엔 `MathField.tsx` 의 `isMatrixResizeKey` 가 DOM 레벨에서 이
  // 조합들을 가로챘다 — 이제 여기 한 곳으로 모인다.
  'ctrl+[Return]', 'ctrl+[Enter]', 'cmd+[Return]', 'cmd+[Enter]', // addRowAfter
  'alt+[Enter]', 'alt+[Return]', // addRowAfter
  'shift+alt+[Enter]', 'shift+alt+[Return]', // addRowBefore
  'ctrl+;', 'cmd+;', // addRowAfter (레이아웃 한정)
  'shift+ctrl+;', 'shift+cmd+;', // addRowBefore (레이아웃 한정)
  'alt+[Tab]', // addColumnAfter
  'shift+alt+[Tab]', // addColumnBefore
  'shift+[Backspace]', // removeColumn
  'shift+[Delete]', // removeRow
  'shift+alt+[Backspace]', // removeRow

  // Ctrl/Cmd+D 는 이 앱의 의미 단위 선택 확장(`MathField.tsx`)이 따로 쓴다 — MathLive
  // 기본(`deleteForward`, macOS 전용)과 충돌하지 않게 여기서도 막아둔다.
  'ctrl+d',
]);

/**
 * 추가할 커스텀 키바인딩. `{key, command, ifMode?, ifPlatform?, ifLayout?}` 형식
 * (`node_modules/mathlive/types/options.d.ts` 의 `Keybinding` 참고).
 *
 * 여기 있는 `key` 는 `BLOCKED_KEYBINDINGS` 에도 있어야 한다(위 경고) — 그래서
 * "차단했는데 아직 살아 있다" 를 보는 브라우저 테스트는 이 목록을 예외로 뺀다.
 */
/**
 * 기본 배열에는 없지만 일부러 막아두는 `key`. 아래 `CUSTOM_KEYBINDINGS` 가 **물리 코드
 * 표기로 다시 쓴** 조합의 문자 표기다 — "차단했는데 기본에 실재하지 않는다" 를 보는
 * 브라우저 테스트에서 뺀다.
 */
export const RESERVED_KEYBINDINGS: ReadonlySet<string> = new Set(['alt+-']);

/**
 * ⚠ **`key` 는 물리 코드 표기(`alt+[Minus]`)로 쓴다. 문자 표기(`alt+-`)로 쓰면 안 된다.**
 *
 * MathLive는 커스텀 바인딩을 **현재 키보드 레이아웃 기준으로 정규화**한다:
 * `getCodeForKey('-', layout)` 로 "그 레이아웃에서 `-` 를 내는 물리 키" 를 찾아 그걸로
 * 바꿔친다. 그런데 레이아웃 판정은 **진짜 키 입력(`evt.isTrusted`)에서만** 일어나고
 * (`onKeystroke` 의 `validateKeyboardLayout`), 그때 정규화 캐시(`_keybindings`)를 비운다.
 *
 * 그래서 문자 표기는 이렇게 무너진다: 처음엔 기본 레이아웃(US)으로 정규화돼
 * `alt+[Minus]` 가 되어 **잘 먹다가**, 사용자가 실제로 타이핑하면 레이아웃이 판정되고
 * 다시 정규화되면서 그 레이아웃에서 `-` 를 내는 **다른 물리 키**로 바뀐다 — 정작 사용자가
 * 누르는 Alt+- 의 `code` 는 여전히 `Minus` 라 더는 안 맞는다. "처음 한 번은 되는데 그
 * 뒤로 안 되는" 증상이 이것이다(합성 이벤트는 `isTrusted` 가 false 라 레이아웃 판정을
 * 안 거쳐서 테스트로는 절대 안 잡힌다).
 *
 * 대괄호 표기는 `normalizeKeybinding` 이 `getCodeForKey` **앞에서** 그대로 돌려주므로
 * (mathlive.mjs:25436 실측) 레이아웃과 무관하게 고정된다. `alt+[Backslash]` 를 차단할 때
 * 배운 것과 같은 교훈이다.
 */
export const CUSTOM_KEYBINDINGS: readonly Keybinding[] = [
  /**
   * Alt+- → `\overline{...}` (켤레 표기). **선택이 있으면 그걸 감싸고, 없으면 빈 칸을
   * 넣는다** — 조건 분기를 우리가 짤 필요가 없다: `#@` 는 MathLive의 "현재 선택" 자리
   * 표시자이고, 선택이 없으면 알아서 빈 자리로 떨어진다. MathLive 자신의 기본 바인딩도
   * 같은 관용구를 쓴다(`/` → `["insert", "\\frac{#@}{#?}"]`, `mathlive.mjs` 실측).
   *
   * `keyOps.ts` 레지스트리가 아니라 여기 있는 이유: `dispatchKeyOp` 는 수정자 없는 키
   * 전용이다(`MathField.tsx` 의 `if (ev.ctrlKey || ev.metaKey || ev.altKey) return;`).
   */
  { key: 'alt+[Minus]', ifMode: 'math', command: ['insert', '\\overline{#@}'] },
  /**
   * Alt+D → `\nabla`. MathLive 기본은 `\differentialD` 인데 이 앱에선 안 쓴다 —
   * 위 `BLOCKED_KEYBINDINGS` 가 기본을 걷어내고 여기서 다시 쓴다.
   */
  { key: 'alt+[KeyD]', ifMode: 'math', command: ['insert', '\\nabla'] },
];

/** `configureInlineShortcuts` 와 짝 — mathfield가 mount된 뒤에만 부를 수 있다. */
export function configureKeybindings(mf: MathfieldElement): void {
  mf.keybindings = [
    ...mf.keybindings.filter((kb) => !BLOCKED_KEYBINDINGS.has(kb.key)),
    ...CUSTOM_KEYBINDINGS,
  ];
}
