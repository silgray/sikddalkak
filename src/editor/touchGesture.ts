import type { MathfieldElement } from 'mathlive';
import { contentOf } from './internals';
import { expandSelectionSemantic } from './selection';
import { isMobileViewport } from '../mobile';

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
 * | 세로 드래그 | 아무 것도 안 함 = 페이지 스크롤(브라우저 몫) |
 *
 * **pointerdown은 삼키지 않는다.** MathLive가 포커스·캐럿 배치·placeholder 특례를
 * 그대로 처리하게 두고, 우리는 그 뒤의 pointermove만 가로챈다 — 그 로직을 우리가
 * 재현하면 두 벌이 되어 어긋난다.
 *
 * ⚠ **MathLive와 겹치는 구간이 없다는 근거**(실측, `onPointerDown` 안의
 * `onPointerMove`): MathLive는 터치에서 `500ms && 20px` 안쪽 움직임을 통째로
 * 무시한다. 우리 임계는 `450ms / 8px` 로 **둘 다 그 안쪽**이라, 모드가 정해지기
 * 전에는 MathLive가 아무 것도 하지 않고, 정해진 뒤에는 우리가 pointermove를 전부
 * 삼켜 MathLive의 `onPointerMove` 가 한 번도 실행되지 않는다.
 *
 * 데스크톱은 손대지 않는다 (브랜치 대원칙) — 터치 포인터가 아니거나 뷰포트가
 * 모바일 폭이 아니면 pointerdown에서 즉시 빠져나온다.
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

type Mode = 'idle' | 'undecided' | 'pan' | 'hold';

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
    if (!ev.isPrimary || ev.pointerType !== 'touch' || !isMobileViewport()) return;
    pointerId = ev.pointerId;
    startX = ev.clientX;
    startY = ev.clientY;
    lastX = startX;
    mode = 'undecided';
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
      // 세로가 우세하면 페이지 스크롤 의도다 — 손을 떼고 브라우저에 넘긴다
      // (모바일 CSS가 `touch-action: pan-y` 로 세로만 열어둔 것과 짝이다).
      if (Math.abs(dy) > Math.abs(dx)) {
        reset();
        return;
      }
      if (holdTimer !== null) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      mode = 'pan';
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

  /** 홀드 선택을 손가락 위치까지 넓힌다. anchorRun은 언제나 안에 남는다. */
  const extendToPoint = (x: number, y: number): void => {
    try {
      const focus = mf.getOffsetFromPoint(x, y, { bias: x < startX ? -1 : 1 });
      if (focus < 0) return;
      const [a, b] = anchorRun ?? [focus, focus];
      const lo = Math.min(a, focus);
      const hi = Math.max(b, focus);
      mf.selection = {
        ranges: [[lo, hi]],
        direction: focus < a ? 'backward' : 'forward',
      };
    } catch {
      /* 내부 상태가 예상과 다르면 선택을 건드리지 않는다 */
    }
  };

  const onPointerEnd = (): void => {
    // pointerup 자체는 통과시킨다 — MathLive가 자기 추적을 정리해야 한다.
    reset();
  };

  /**
   * 홀드 시 뜨는 컨텍스트 메뉴를 막는다. MathLive는 길게 누름을 감지하면 호스트에
   * cancelable `contextmenu` 를 쏘고 그게 막히지 않았을 때만 메뉴를 연다
   * (`acceptContextMenu`, 실측). 네이티브 선택 콜아웃도 같은 이벤트로 온다.
   * ⚠ 이 이벤트는 `bubbles: false` 로 만들어지므로 **`mf` 자신에게** 들어야 한다.
   * 데스크톱 우클릭 메뉴는 그대로 둔다(브랜치 대원칙).
   */
  const onContextMenu = (ev: Event): void => {
    if (isMobileViewport()) ev.preventDefault();
  };

  host.addEventListener('pointerdown', onPointerDown, { capture: true });
  host.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });
  host.addEventListener('pointerup', onPointerEnd, { capture: true });
  host.addEventListener('pointercancel', onPointerEnd, { capture: true });
  mf.addEventListener('contextmenu', onContextMenu);

  return () => {
    reset();
    host.removeEventListener('pointerdown', onPointerDown, { capture: true });
    host.removeEventListener('pointermove', onPointerMove, { capture: true });
    host.removeEventListener('pointerup', onPointerEnd, { capture: true });
    host.removeEventListener('pointercancel', onPointerEnd, { capture: true });
    mf.removeEventListener('contextmenu', onContextMenu);
  };
}
