import type { MathfieldElement } from 'mathlive';
import { contentOf, flushShortcutBuffer, resolveOffsetAt } from './internals';
import { expandSelectionSemantic } from './selection';
import { setRawSelection } from './rawSelection';
import { DIRECT_AIM, aimedPoint } from './touchAim';
import { isMobileDevice } from '../mobile';

/**
 * 모바일 터치 제스처 층 — **가로 스크롤과 범위 선택을 갈라준다.**
 *
 * MathLive는 pointerdown을 잡는 순간부터 드래그를 범위 선택으로만 쓴다
 * (`mathlive.mjs` 의 `onPointerDown`). 그런데 `.ML__content` 는 `overflow: hidden`
 * 이라 브라우저 네이티브 패닝도 없어서, 셀보다 긴 수식은 **손으로 옮길 방법이
 * 아예 없었다** — 끌면 선택만 됐다. 여기서 그 손짓을 넷으로 가른다:
 *
 * | 손짓 | 결과 |
 * | --- | --- |
 * | 짧은 탭 | 캐럿 이동 (우리가 직접, `placeCaretAt`) |
 * | 짧은 터치 후 가로 드래그 | 셀 수식 가로 스크롤 |
 * | 홀드 | 손가락 밑 '항' 자동 선택 (컨텍스트 메뉴 대신) |
 * | 홀드 후 드래그 | 그 선택을 손가락 쪽으로 확장 |
 * | 세로 드래그 | 페이지 스크롤 (`stopPropagation` 만 — `preventDefault` 는 안 한다) |
 *
 * **pointerdown을 삼킨다** — `preventDefault` + `stopPropagation` 둘 다.
 * 손짓이 뭐가 될지 모르는 채로 MathLive가 먼저 포커스·캐럿을 옮기고, 스크롤로
 * 판명되면 되돌리는 방식(사후 복구)을 예전엔 썼다. 그런데 MathLive의
 * `MathfieldElement.onPointerDown`(`mathlive.mjs`)은 `window`에 pointerup을
 * 걸어두고 **`defaultPrevented`를 안 보는 채로** 뗀 좌표로 캐럿을 다시
 * 계산한다 — 좌표가 수식 밖이면 `lastOffset`(셀 끝)으로 튄다(실측: "가로
 * 드래그 끝나면 캐럿이 끝으로 튀는" 버그의 진범이었다). `preventDefault`로는
 * 이걸 못 막고 **capture 단계 `stopPropagation`만이 유일한 차단 수단**이라,
 * 사후 복구보다 원천 차단이 더 간단하고 더 정확하다. 포커스도 마찬가지다
 * — MathLive는 `onPointerDown` 안에서 **명시적으로** `onFocus()`를 부르므로
 * (브라우저 기본 포커스에 안 기댄다) `stopPropagation`이 그 경로를 끊는다.
 * 다만 셰도우 루트가 `delegatesFocus: true`라 네이티브 기본 동작으로도
 * 포커스가 들어오므로, 그건 `preventDefault`가 막는다 — **둘 다 필요하다.**
 *
 * pointerdown을 막았으니 **탭·홀드는 우리가 직접 캐럿을 놓는다**
 * (`placeCaretAt`) — `resolveOffsetAt(mf, x, y, 0)`, `SelectionHandles.tsx`의
 * 핸들 위치 계산과 같은 bias(중앙선 기준, "네이티브 탭과 같은 자리"). 홀드는
 * 특히 이게 필수다 — `expandSelectionSemantic`이 `model.position`만 보는데,
 * 그건 이제 우리가 놓기 전엔 "직전 캐럿"일 뿐 손가락 밑이 아니다.
 *
 * ⚠ **더블탭(그룹 선택)·트리플탭(전체 선택)은 지금 없다.** MathLive의 전역
 * 탭 카운터(`gTapCount`, 5px/500ms)가 pointerdown과 함께 죽는다 — 판정 지점이
 * `onPointerEnd` 한 곳에 모여 있으니 필요해지면 거기 얹으면 된다.
 *
 * ⚠ **placeholder 특례도 없다.** MathLive는 pointerdown에서 placeholder를
 * 탭하면 안으로 들어가거나 전체 선택하는 3중 분기를 갖는데, 우리 `placeCaretAt`
 * 은 그냥 오프셋에 캐럿을 놓을 뿐이다. `\frac`·행렬·`\sqrt` 가 전부
 * placeholder로 시작하므로 영향이 있으면 바로 드러난다 — 실기기·브라우저
 * 테스트로 확인해야 하는 자리다(`feedKeyParity.browser.test.tsx` 가 키보드
 * 경로 쪽 기준값을 갖고 있다).
 *
 * 데스크톱은 손대지 않는다 (CLAUDE.md §모바일 대원칙) — 터치 포인터가 아니거나
 * 뷰포트가 모바일 폭이 아니면 pointerdown에서 즉시 빠져나온다.
 */

/** 이 거리를 넘게 움직이면 탭이 아니라 드래그. */
const MOVE_THRESHOLD_PX = 8;

/**
 * 이만큼 누르고 있으면 홀드. `export` 하는 이유 — `KeyPalette.tsx`의 행렬 크기
 * 격자(길게 눌러 5×5 미리보기)도 같은 "홀드" 조작감을 쓴다. 그쪽은 MathLive
 * 필드가 아니라 평범한 `<button>`이라 이 파일의 제스처 파이프라인을 안 타고
 * 자기 pointerdown/move/up으로 직접 재는데, 값만은 하나로 맞춘다.
 */
export const HOLD_DELAY_MS = 450;

/**
 * 홀드가 선택하는 크기. `expandSelectionSemantic` 의 사다리에서 접힌 캐럿 기준
 * 1칸은 원자 하나, 2칸이 곱셈 항이다(`selection.ts` 참고). 조작감의 핵심 손잡이라
 * 브라우저 테스트가 이 값을 핀으로 박아둔다 — 바꾸려면 거기 기대값도 같이 본다.
 */
const HOLD_EXPAND_STEPS = 2;

type Mode = 'idle' | 'undecided' | 'pan' | 'hold' | 'vscroll';

/**
 * 홀드 시 뜨는 메뉴를 **셀 전체에서** 막는다.
 *
 * MathLive는 길게 누름을 감지하면 호스트에 cancelable `contextmenu` 를 쏘고 그게
 * 막히지 않았을 때만 자체 메뉴를 연다(`acceptContextMenu`, 실측). 하지만 셀의
 * **빈 자리**(수식 밖 여백)를 꾹 누르면 그건 MathLive가 아니라 브라우저의 네이티브
 * 콜아웃이라 필드에 건 리스너로는 안 잡힌다(사용자 보고). 그래서 document capture로
 * 한 번에 막는다 — capture라 `bubbles:false` 인 MathLive 쪽 이벤트도 같이 잡힌다.
 *
 * 예외는 진짜 텍스트 입력뿐이다(탭 이름 바꾸기의 `<input>`) — 거기선 네이티브
 * 선택·붙여넣기 메뉴가 있어야 한다.
 *
 * 필드가 여럿이라 참조를 세어 마지막 하나가 떠날 때만 뗀다.
 */
let menuBlockRefs = 0;

const onDocumentContextMenu = (ev: Event): void => {
  if (!isMobileDevice()) return; // 데스크톱 우클릭 메뉴는 그대로 둔다
  const target = ev.target;
  if (target instanceof Element && target.closest('input, textarea') !== null) return;
  ev.preventDefault();
};

function retainMenuBlock(): () => void {
  if (menuBlockRefs === 0) {
    document.addEventListener('contextmenu', onDocumentContextMenu, { capture: true });
  }
  menuBlockRefs += 1;
  return () => {
    menuBlockRefs -= 1;
    if (menuBlockRefs === 0) {
      document.removeEventListener('contextmenu', onDocumentContextMenu, { capture: true });
    }
  };
}

/**
 * `mf` 를 감싸는 호스트 요소에 제스처 층을 붙인다. 반환값은 떼는 함수.
 *
 * capture 단계로 듣는 게 요점이다 — 셰도우 DOM 안쪽(MathLive) 리스너보다 항상
 * 먼저 보고, `stopPropagation()` 하면 MathLive는 그 이벤트를 아예 못 본다.
 */
export function attachTouchGesture(mf: MathfieldElement, host: HTMLElement): () => void {
  let mode: Mode = 'idle';
  /** 추적 중인 포인터. 멀티터치의 두 번째 손가락은 무시한다. */
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  /** 직전 프레임의 x — 패닝은 절대 위치가 아니라 증분으로 옮긴다. */
  let lastX = 0;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** 홀드가 잡은 선택 범위. 드래그 중에도 **항상 포함**시켜 항 단위 알갱이를 지킨다. */
  let anchorRun: readonly [number, number] | null = null;

  const reset = (): void => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    mode = 'idle';
    pointerId = null;
    anchorRun = null;
  };

  /**
   * 탭·홀드가 손가락 자리에 캐럿을 놓는다 — pointerdown을 삼켰으니 MathLive가
   * 하던 일(포커스 이동 + 캐럿 배치)을 우리가 대신한다.
   *
   * `bias: 0` — 원자의 어느 쪽 절반을 짚었는지(중앙선 기준)로 경계를 가른다.
   * "탭했을 때 캐럿이 서는 자리"와 정확히 같아지는 규칙이다 — `SelectionHandles.tsx`
   * 가 핸들 위치를 잴 때 같은 이유로 같은 bias를 쓴다.
   */
  const placeCaretAt = (x: number, y: number): void => {
    try {
      const offset = resolveOffsetAt(mf, x, y, 0);
      mf.focus(); // focus()는 선택을 안 건드린다 — 캐럿은 아래서 명시적으로 놓는다.
      if (offset !== null) mf.position = offset;
      // MathLive가 pointerdown마다 하던 일 — 안 하면 탭 직전 타이핑이 버퍼에
      // 남아 다음 입력과 이어붙어 엉뚱한 숏컷이 튄다(`s` → 탭 → `in` = `\sin`).
      flushShortcutBuffer(mf);
    } catch {
      /* 내부 상태가 예상과 다르면 캐럿을 건드리지 않는다 */
    }
  };

  /**
   * 세로 스크롤로 확정 — 손을 뗄 때까지 이 모드에 머문다(중간에 가로로 꺾여도
   * 안 바뀐다). 이후 pointermove는 **`stopPropagation` 만** 한다:
   * `preventDefault` 를 걸면 브라우저의 세로 패닝(`touch-action: pan-y`)까지
   * 죽는다 — 우리가 막아야 하는 건 MathLive의 `onPointerMove`(그게 선택을
   * 만든다) 뿐이고, `stopPropagation` 으로 그 이벤트가 셰도우 DOM에 닿는 것
   * 자체를 막으면 충분하다.
   */
  const beginVScroll = (): void => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    mode = 'vscroll';
  };

  /** 홀드 성립 — 손가락 밑 항을 선택한다. */
  const beginHold = (): void => {
    holdTimer = null;
    if (mode !== 'undecided') return;
    mode = 'hold';
    // `expandSelectionSemantic`은 `model.position`만 본다(손가락 좌표를 모른다)
    // — pointerdown을 삼켰으니 그 자리를 우리가 먼저 놓아야 "손가락 밑 항"이
    // 나온다. 안 그러면 직전 캐럿(다른 셀이면 포커스조차 없던 자리) 기준으로
    // 확장된다.
    placeCaretAt(startX, startY);
    try {
      for (let step = 0; step < HOLD_EXPAND_STEPS; step += 1) expandSelectionSemantic(mf);
      const range = mf.selection.ranges[0];
      // 선택이 안 잡혔으면(빈 셀 등) anchorRun 없이 캐럿 기준으로만 끈다.
      anchorRun = mf.selectionIsCollapsed || range === undefined ? null : [range[0], range[1]];
    } catch {
      anchorRun = null;
    }
  };

  const onPointerDown = (ev: PointerEvent): void => {
    reset();
    // 선택 핸들 위에서 시작한 손짓은 그쪽 것이다 (`SelectionHandles.tsx`).
    // 우리가 capture로 먼저 보기 때문에 그쪽 stopPropagation으로는 못 막는다.
    const target = ev.target;
    if (target instanceof Element && target.closest('.sel-handle') !== null) return;
    // `pointerType` 은 **이 손짓**이 손가락인지, `isMobileDevice()` 는 **이 기기**가
    // 손가락 기기인지를 묻는다 — 둘은 다른 질문이라 둘 다 필요하다(터치스크린
    // 노트북에서 손가락으로 짚어도 물리 키보드가 있으니 데스크톱 동작이어야 한다).
    if (!ev.isPrimary || ev.pointerType !== 'touch' || !isMobileDevice()) return;
    pointerId = ev.pointerId;
    startX = ev.clientX;
    startY = ev.clientY;
    lastX = startX;
    mode = 'undecided';
    holdTimer = setTimeout(beginHold, HOLD_DELAY_MS);
    // 삼킨다 — MathLive가 포커스를 잡거나(명시적 `onFocus()` 호출, `stopPropagation`
    // 이 막는다) 브라우저가 기본 포커스를 주는 것(`delegatesFocus`, `preventDefault`
    // 가 막는다) 둘 다 막는다. 판정 전엔 아무 일도 안 일어나야 한다 — 판정되면
    // `placeCaretAt`(탭·홀드) 또는 스크롤(pan·vscroll)이 각자 알아서 한다.
    ev.preventDefault();
    ev.stopPropagation();
  };

  const onPointerMove = (ev: PointerEvent): void => {
    if (pointerId === null || ev.pointerId !== pointerId) return;
    const x = ev.clientX;
    const y = ev.clientY;

    if (mode === 'undecided') {
      const dx = x - startX;
      const dy = y - startY;
      if (Math.abs(dx) < MOVE_THRESHOLD_PX && Math.abs(dy) < MOVE_THRESHOLD_PX) return;
      // 세로가 우세하면 페이지 스크롤 의도다 (모바일 CSS가 `touch-action: pan-y`
      // 로 세로만 열어둔 것과 짝이다). MathLive는 pointerdown 자체를 못 받았으니
      // (삼켰다) 여기서 더 막을 것도 없다 — 브라우저의 네이티브 세로 패닝만
      // 계속 흐르면 된다.
      if (Math.abs(dy) > Math.abs(dx)) {
        beginVScroll();
        ev.stopPropagation();
        return;
      }
      if (holdTimer !== null) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      mode = 'pan';
    }

    if (mode === 'vscroll') {
      // preventDefault는 하지 않는다 — 브라우저가 세로로 계속 스크롤해야 한다.
      ev.stopPropagation();
      return;
    }

    if (mode === 'pan') {
      ev.preventDefault();
      ev.stopPropagation();
      const content = contentOf(mf);
      // 손가락을 따라간다: 왼쪽으로 끌면 뒤쪽(오른쪽) 내용이 보여야 한다.
      // 범위 클램프는 브라우저가 한다.
      if (content !== null) content.scrollLeft -= x - lastX;
      lastX = x;
      return;
    }

    if (mode === 'hold') {
      ev.preventDefault();
      ev.stopPropagation();
      extendToPoint(x, y);
    }
  };

  /**
   * 홀드 선택을 손가락 위치까지 넓힌다. anchorRun은 언제나 안에 남는다.
   * `setRawSelection` 을 거쳐 (lo, hi) 를 **원시 캐럿**으로 남긴다 — 손을 뗀
   * 뒤에도 `SelectionHandles` 가 이어받아, 구조 경계를 넘어 스냅된 선택이라도
   * 손가락을 되돌리면 다시 좁혀진다(`rawSelection.ts` 참고).
   *
   * ⚠ **여기는 `DIRECT_AIM` 이다** — 손가락 좌표를 손대지 않고 그대로 판정한다.
   * 손잡이 드래그(`SelectionHandles.tsx`)는 반대로 위로 올려 잡는데(`gripAim`),
   * 그건 손잡이가 선택 줄 아래에 매달려 있어 손가락과 가리키는 자리가 어긋나기
   * 때문이다. 홀드는 **손가락이 내용을 직접 짚는** 손짓이라 어긋날 것이 없고,
   * 보정을 넣으면 짚은 자리와 선택이 벌어져 그 자체가 버그가 된다.
   * 보정 규칙은 `editor/touchAim.ts` 한 곳에 모여 있다.
   */
  const extendToPoint = (clientX: number, clientY: number): void => {
    try {
      const { x, y } = aimedPoint(DIRECT_AIM, clientX, clientY);
      // 원자 사이 빈 자리에서 나오는 못 믿을 표본은 버린다 (`resolveOffsetAt` 참고) —
      // 그대로 쓰면 선택이 식의 엉뚱한 데로 튄다.
      const caret = resolveOffsetAt(mf, x, y, x < startX ? -1 : 1);
      if (caret === null) return;
      const [a, b] = anchorRun ?? [caret, caret];
      const lo = Math.min(a, caret);
      const hi = Math.max(b, caret);
      setRawSelection(mf, lo, hi);
    } catch {
      /* 내부 상태가 예상과 다르면 선택을 건드리지 않는다 */
    }
  };

  /**
   * 손짓이 **우리 것으로 확정된 뒤에는** 브라우저가 그 손가락을 스크롤로 가져가지
   * 못하게 한다.
   *
   * 모바일에서는 셀 위의 세로 손짓을 페이지 스크롤로 브라우저에 넘겨 뒀다
   * (`touch-action: pan-y` — 호스트는 `styles/selectionHandles.css`, 셰도우 안쪽
   * `.ML__container` 는 `MathField.tsx` 의 `SHADOW_CSS`). 그런데 홀드 선택이
   * 성립한 뒤의 세로 드래그(분수의 분자/분모 넘나들기)까지 브라우저가 가져가면
   * 선택을 세로로 다듬을 수가 없다. `touch-action` 은 손짓 도중에 바꿔봐야 안
   * 먹으므로(브라우저가 touchstart 때 정한다) **아직 시작되지 않은 패닝**을
   * `touchmove` 의 `preventDefault` 로 취소한다 — 홀드는 450ms 를 안 움직이고
   * 기다린 뒤라 그 시점엔 패닝이 아직 시작되지 않았다.
   *
   * `pointermove` 로는 못 한다(포인터 이벤트의 `preventDefault` 는 스크롤을 안
   * 막는다). 그래서 이 리스너 하나만 터치 이벤트다.
   */
  const onTouchMove = (ev: TouchEvent): void => {
    if (mode !== 'hold' && mode !== 'pan') return;
    if (ev.cancelable) ev.preventDefault();
  };

  const onPointerEnd = (ev: PointerEvent): void => {
    const endedMode = mode;
    reset();
    // 탭 = `undecided` 인 채로 끝난 손짓(450ms 안에, 8px 안에서 손을 뗐다).
    // pointercancel(시스템이 손짓을 가져간 경우)은 탭이 아니다 — 캐럿을 안 놓는다.
    if (endedMode === 'undecided' && ev.type === 'pointerup') {
      // 뗀 좌표가 아니라 **누른** 좌표다 — 8px 안쪽이라 차이는 없지만 `beginHold`
      // 와 기준을 맞춘다.
      placeCaretAt(startX, startY);
    }
  };

  const releaseMenuBlock = retainMenuBlock();
  host.addEventListener('pointerdown', onPointerDown, { capture: true });
  host.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });
  host.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
  host.addEventListener('pointerup', onPointerEnd, { capture: true });
  host.addEventListener('pointercancel', onPointerEnd, { capture: true });

  return () => {
    reset();
    releaseMenuBlock();
    host.removeEventListener('pointerdown', onPointerDown, { capture: true });
    host.removeEventListener('pointermove', onPointerMove, { capture: true });
    host.removeEventListener('touchmove', onTouchMove, { capture: true });
    host.removeEventListener('pointerup', onPointerEnd, { capture: true });
    host.removeEventListener('pointercancel', onPointerEnd, { capture: true });
  };
}
