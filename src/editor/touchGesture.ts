import type { MathfieldElement } from 'mathlive';
import { contentOf, resolveOffsetAt } from './internals';
import { expandSelectionSemantic } from './selection';
import { setRawSelection } from './rawSelection';
import { DIRECT_AIM, aimedPoint } from './touchAim';
import { isMobileViewport } from '../mobile';
import { getFocusedMathField } from './activeField';

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
 * | 짧은 탭 | 캐럿 이동 (MathLive 기본 그대로) |
 * | 짧은 터치 후 가로 드래그 | 셀 수식 가로 스크롤 |
 * | 홀드 | 손가락 밑 '항' 자동 선택 (컨텍스트 메뉴 대신) |
 * | 홀드 후 드래그 | 그 선택을 손가락 쪽으로 확장 |
 * | 세로 드래그 | 페이지 스크롤 (`stopPropagation` 만 — `preventDefault` 는 안 한다) |
 *
 * **pointerdown은 삼키지 않는다.** MathLive가 포커스·캐럿 배치·placeholder 특례를
 * 그대로 처리하게 두고, 우리는 그 뒤의 pointermove만 가로챈다 — 그 로직을 우리가
 * 재현하면 두 벌이 되어 어긋난다.
 *
 * **그런데 스크롤(가로 드래그·세로 드래그)로 판명되면 그 처리를 되돌린다.**
 * MathLive의 pointerdown은 "손짓이 나중에 뭐가 될지" 모르는 채로 포커스·캐럿을
 * 옮기므로, 탭이 아니라 스크롤이었다고 밝혀지면 그 부작용을 지워야 한다 —
 * 다른(포커스 없던) 셀 위에서 스크롤을 시작해도 그 셀로 포커스가 넘어가면
 * 안 되고, 이미 포커스된 셀을 스크롤해도 캐럿이 스크롤 종료 지점으로 튀면 안
 * 된다. **홀드만은 예외다** — 홀드로 다른 셀을 잡으면 포커스가 그쪽으로
 * 넘어가는 게 의도된 동작이다(항을 골라 선택하는 것 자체가 그 셀을 편집
 * 대상으로 고른 것이므로). `savedFocus`/`restoreFocus` 가 이 되돌림을 맡는다.
 *
 * ⚠ **MathLive와 겹치는 구간이 없다는 근거**(실측, `onPointerDown` 안의
 * `onPointerMove`): MathLive는 터치에서 `500ms && 20px` 안쪽 움직임을 통째로
 * 무시한다. 우리 임계는 `450ms / 8px` 로 **둘 다 그 안쪽**이라, 모드가 정해지기
 * 전에는 MathLive가 아무 것도 하지 않고, 정해진 뒤에는 우리가 pointermove를 전부
 * 삼켜 MathLive의 `onPointerMove` 가 한 번도 실행되지 않는다.
 *
 * 데스크톱은 손대지 않는다 (CLAUDE.md §모바일 대원칙) — 터치 포인터가 아니거나
 * 뷰포트가 모바일 폭이 아니면 pointerdown에서 즉시 빠져나온다.
 */

/** 이 거리를 넘게 움직이면 탭이 아니라 드래그. MathLive의 터치 히스테리시스(20px)보다 작아야 한다. */
const MOVE_THRESHOLD_PX = 8;

/** 이만큼 누르고 있으면 홀드. MathLive의 히스테리시스 시간(500ms)보다 짧아야 한다. */
const HOLD_DELAY_MS = 450;

/**
 * 홀드가 선택하는 크기. `expandSelectionSemantic` 의 사다리에서 접힌 캐럿 기준
 * 1칸은 원자 하나, 2칸이 곱셈 항이다(`selection.ts` 참고). 조작감의 핵심 손잡이라
 * 브라우저 테스트가 이 값을 핀으로 박아둔다 — 바꾸려면 거기 기대값도 같이 본다.
 */
const HOLD_EXPAND_STEPS = 2;

type Mode = 'idle' | 'undecided' | 'pan' | 'hold' | 'vscroll';

/**
 * pointerdown 시점에 포커스였던 필드의 캐럿/선택 스냅샷. `mf` 자신일 수도,
 * 다른(포커스가 없던) 필드일 수도, 아무 데도 없었을 수도 있다(`null`) —
 * `onPointerDown`/`restoreFocus` 참고.
 */
type FocusSnapshot = {
  field: MathfieldElement;
  position: number;
  /** `null` 이면 접힌 캐럿(collapsed) — `position` 만 쓴다. */
  selection: readonly (readonly [number, number])[] | null;
};

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
  if (!isMobileViewport()) return; // 데스크톱 우클릭 메뉴는 그대로 둔다
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
  /**
   * 손짓이 시작될 때 포커스였던 필드의 캐럿/선택. **스크롤로는 포커스도 캐럿도
   * 안 바뀌어야 한다** — 그런데 MathLive는 pointerdown 하나로 포커스를 옮기고
   * 캐럿을 놓아버린다(우리는 그 처리를 일부러 통과시킨다). capture 단계라 우리가
   * 먼저 보므로 여기서 찍어뒀다가, 손짓이 스크롤(pan/vscroll)로 판명되면
   * 되돌린다. 탭이나 홀드로 판명되면 되돌리지 않는다 — 그건 사용자가 정말로
   * 캐럿을 옮겼거나(탭) 다른 셀을 골라 선택한 것이다(홀드, 의도된 포커스 이동).
   */
  let savedFocus: FocusSnapshot | null = null;

  const reset = (): void => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    mode = 'idle';
    pointerId = null;
    anchorRun = null;
    savedFocus = null;
  };

  /**
   * 스크롤로 판명된 손짓이 훔쳐간(또는 옮겨놓은) 포커스·캐럿을 되돌린다.
   *
   * **멱등이다** — pan/vscroll이 확정되는 즉시(다른 셀이 드래그 내내 반짝
   * 포커스된 채로 보이는 걸 막으려고) 한 번, 손을 뗀 뒤에도(한 틱 미뤄서 —
   * MathLive 자신의 네이티브 pointerup 처리가 이 리스너보다 나중에 돌아 캐럿을
   * 다시 옮겨놓을 수 있어서) 한 번 더 부를 수 있다. 그래서 `savedFocus` 를
   * 여기서 지우지 않는다 — `reset()` 만 지운다.
   */
  const restoreFocus = (snap: FocusSnapshot | null): void => {
    if (snap === null) {
      // 원래 아무 데도 포커스가 없었다 — 이 손짓이 훔쳐간 포커스를 마저 놓는다.
      if (document.activeElement === mf) mf.blur();
      return;
    }
    try {
      if (snap.field !== mf) snap.field.focus();
      if (snap.selection !== null) {
        snap.field.selection = { ranges: snap.selection as [number, number][], direction: 'forward' };
      } else {
        snap.field.position = snap.position;
      }
    } catch {
      /* 그 사이 값이 바뀌어 오프셋이 안 맞거나 내부 상태가 예상과 다르면 그냥 둔다 */
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
    restoreFocus(savedFocus);
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
    if (!ev.isPrimary || ev.pointerType !== 'touch' || !isMobileViewport()) return;
    pointerId = ev.pointerId;
    startX = ev.clientX;
    startY = ev.clientY;
    lastX = startX;
    mode = 'undecided';
    // MathLive가 포커스·캐럿을 옮기기 전에 찍어둔다 — capture 단계라 브라우저의
    // 네이티브 pointerdown 기본 동작(포커스 이동)보다 우리가 먼저 실행된다.
    // `prevFocused` 는 `mf` 자신일 수도(이미 포커스된 셀을 만짐), 다른 필드일
    // 수도(포커스 없던 셀을 만짐), 아무 것도 없을 수도 있다.
    const prevFocused = getFocusedMathField();
    savedFocus =
      prevFocused === null
        ? null
        : {
            field: prevFocused,
            position: prevFocused.position,
            selection: prevFocused.selectionIsCollapsed
              ? null
              : prevFocused.selection.ranges.map(([a, b]) => [a, b]),
          };
    holdTimer = setTimeout(beginHold, HOLD_DELAY_MS);
    // 여기서는 아무 것도 막지 않는다 — MathLive의 탭 처리가 그대로 돌아야 한다.
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
      // 로 세로만 열어둔 것과 짝이다). 손을 떼지 않는다 — 계속 추적하며
      // MathLive만 못 보게 막는다. 안 그러면 그 순간부터 pointermove를 안 삼켜,
      // MathLive의 히스테리시스(20px)를 넘기는 순간 저쪽이 선택을 만든다(실측).
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
      restoreFocus(savedFocus);
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

  const onPointerEnd = (): void => {
    const endedMode = mode;
    const snapshot = savedFocus; // reset()이 지우기 전에 로컬로 붙든다
    // pointerup 자체는 통과시킨다 — MathLive가 자기 추적을 정리해야 한다.
    reset();
    if (endedMode === 'pan' || endedMode === 'vscroll') {
      // 방금 통과시킨 pointerup을 MathLive가 자기 방식대로 처리해(네이티브 탭
      // 종료 로직) 캐럿을 다시 옮겨놓을 수 있다 — capture 리스너인 우리가 그
      // target-phase 처리보다 먼저 도니, 같은 틱에서 되돌려봐야 곧 덮어써진다.
      // 한 틱 미룬다(`activeField.ts`의 `notifyFieldBlur`와 같은 패턴).
      setTimeout(() => restoreFocus(snapshot), 0);
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
