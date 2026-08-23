import { useEffect, useRef, useState } from 'react';
import type { MathfieldElement } from 'mathlive';
import { clearAtomBoundsCache, contentOf } from '../editor/internals';
import { rawSelection, setRawSelection } from '../editor/rawSelection';
import { isMobileViewport, onMobileViewportChange } from '../mobile';

/**
 * 모바일 선택 범위의 **양끝 드래그 핸들**.
 *
 * 홀드로 잡은 선택(`editor/touchGesture.ts`)을 손가락으로 다듬는 자리다. 시작/끝을
 * 따로 끌 수 있고, 놓는 지점은 **원자 경계로 스냅**된다 — 이 앱의 선택은 언제나
 * "한 레벨 연속 형제 열" 이어야 하므로(`editor/selection.ts`) 픽셀 그대로 놔둘 수가
 * 없다. 스냅은 우리가 따로 계산하지 않는다: 선택을 그냥 세팅하면
 * `MathField` 의 `selection-change` 게이트(`normalizeSelection`)가 교정한다 —
 * 선택 불변식의 단일 게이트를 두 벌로 만들지 않으려는 것이다.
 *
 * **드래그는 원시 캐럿(`editor/rawSelection.ts`)을 옮긴다** — 화면에 보이는(스냅된)
 * 선택 범위를 직접 옮기지 않는다. 홀드 드래그가 구조 경계를 넘어 상위로 스냅된
 * 뒤라도, 핸들을 반대로 되돌리면 원시 좌표부터 다시 계산되어 자연히 좁아진다.
 * 스냅된 결과를 출발점으로 삼았다면(예전 구현) 한번 넓어진 선택은 되돌릴 수 없었다.
 *
 * 좌표는 전부 **실측**이다. `mf.getElementInfo(offset).bounds` 가 그 오프셋 자리
 * 원자의 뷰포트 좌표 DOMRect를 준다(실측: `1+xy` 의 오프셋 4 = `y`). 거꾸로
 * 드래그 중에는 `mf.getOffsetFromPoint(x, y)` 로 화면 좌표를 오프셋으로 되돌린다.
 *
 * ⚠ **세로 좌표는 손가락이 아니라 선택 줄의 한가운데를 쓴다.** 핸들을 잡은 손가락은
 * 수식 아래(또는 위)에 있어서, 그 y를 그대로 넘기면 히트테스트가 줄 밖으로 나간다.
 *
 * ⚠ **MathLive는 원자 상자를 뷰포트 좌표로 캐싱한다**(`atomBoundsCache`, 실측) —
 * 그 캐시를 비우는 곳은 원래 렌더 전후와 자기 `onPointerDown` 뿐이다. 우리 패닝은
 * `content.scrollLeft` 만 옮기고 렌더도 pointerdown도 없으므로, 그 스크롤을
 * `clearAtomBoundsCache`(`editor/internals.ts`) 없이 두면 핸들이 옛 좌표에 멈춘다 —
 * 아래 `scroll` 리스너가 그때만 명시적으로 비운다(매 프레임 비우면 히트테스트가
 * 원자마다 다시 `getBoundingClientRect` 를 재야 해서 느려진다).
 *
 * 데스크톱에는 안 뜬다 — DOM은 늘 그리고 숨김은 CSS(`@media (max-width: 640px)`)가
 * 맡는다(브랜치 대원칙 3). 다만 **측정은** 모바일에서만 돈다: 선택이 바뀔 때마다
 * 도는 자리라 데스크톱에서 헛일할 이유가 없다. 그 판정도 `mobile.ts` 하나를 쓴다.
 */

type Edge = {
  /** 컨테이너 기준 x (px). 보이는 범위 밖이면 그 경계로 **클램프된** 값이다. */
  readonly x: number;
  /** 진짜 위치가 보이는 범위 밖이라 경계에 고정됐는가 — 방향 표식(`.sel-handle-pinned`)에 쓴다. */
  readonly pinned: boolean;
};

type Placement = {
  /** 컨테이너 기준 선택 줄의 위/아래 (px). */
  readonly top: number;
  readonly bottom: number;
  readonly start: Edge;
  readonly end: Edge;
  /** 선택 줄 한가운데의 **뷰포트** y. 드래그 히트테스트가 쓴다. */
  readonly midY: number;
};

/** 핸들이 컨테이너 경계에 갇혀 자동 스크롤할 때의 걸음 — MathLive 자신의
 * 드래그 선택 오토스크롤과 같은 값이다(`mathlive.mjs` 의 `scrollInterval`, 실측). */
const AUTO_SCROLL_STEP_PX = 16;
const AUTO_SCROLL_INTERVAL_MS = 32;

function measure(mf: MathfieldElement, container: HTMLElement): Placement | null {
  if (mf.selectionIsCollapsed) return null;
  const range = mf.selection.ranges[0];
  if (range === undefined) return null;
  const [a, b] = range;
  // 선택된 원자는 a+1 … b 다 (오프셋은 원자 **사이**의 경계다).
  const first = mf.getElementInfo(a + 1)?.bounds;
  const last = mf.getElementInfo(b)?.bounds;
  if (first === undefined || last === undefined) return null;

  const box = container.getBoundingClientRect();
  const contentBox = contentOf(mf)?.getBoundingClientRect() ?? box;
  const top = Math.min(first.top, last.top);
  const bottom = Math.max(first.bottom, last.bottom);

  // 컨테이너 밖으로 나간 쪽은 숨기지 않고 그 경계에 세운다 — 핀으로 읽히게 하고
  // (`.sel-handle-pinned`), 언제든 잡아서 다시 안으로 끌어올 수 있게 둔다.
  const clampEdge = (trueX: number): Edge => {
    const x = Math.min(Math.max(trueX, contentBox.left), contentBox.right);
    return { x: x - box.left, pinned: x !== trueX };
  };

  return {
    top: top - box.top,
    bottom: bottom - box.top,
    start: clampEdge(first.left),
    end: clampEdge(last.right),
    midY: (top + bottom) / 2,
  };
}

type Props = {
  /** 이 필드의 선택에 붙는다. 마운트 전(null)이면 아무 것도 안 한다. */
  mf: MathfieldElement | null;
  /** 핸들을 절대배치할 기준 상자 (`position: relative` 여야 한다). */
  container: HTMLElement | null;
};

/** 진행 중인 핸들 드래그. */
type Drag = {
  /** 잡은 **물리 핸들**의 정체. 교차해도 안 바뀐다 (포인터 캡처가 이 노드에 걸려 있다). */
  readonly which: 'start' | 'end';
  readonly midY: number;
  /** 반대쪽(안 움직이는) 원시 캐럿 — `editor/rawSelection.ts` 참고. */
  readonly fixed: number;
  /**
   * 움직이는 캐럿이 지금 **왼쪽 끝**인가. 반대쪽 캐럿을 넘어가면 뒤집힌다 —
   * 그때부터 잡고 있는 핸들이 곧 시작 핸들이다. 렌더가 이걸 읽어 쥔 노드를
   * 손가락 쪽에 붙여 둔다(안 그러면 교차하는 순간 반대편으로 순간이동한다).
   */
  movingIsMin: boolean;
  /** 경계에 붙어 자동 스크롤 중인 방향. 0이면 안 하는 중. */
  autoScrollDir: -1 | 0 | 1;
  autoScrollTimer: ReturnType<typeof setInterval> | null;
  /** 오토스크롤 틱마다 다시 쓸 마지막 손가락 x. */
  lastClientX: number;
};

export function SelectionHandles({ mf, container }: Props) {
  const [placement, setPlacement] = useState<Placement | null>(null);
  const dragRef = useRef<Drag | null>(null);

  useEffect(() => {
    if (mf === null || container === null) return;

    let frame = 0;
    let disposed = false;
    const remeasure = (): void => {
      if (disposed) return;
      setPlacement(isMobileViewport() ? measure(mf, container) : null);
    };
    // MathLive는 rAF에서 렌더한다 — 선택이 바뀐 직후 바로 재면 옛 위치를 본다.
    const schedule = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(remeasure);
    };

    mf.addEventListener('selection-change', schedule);
    mf.addEventListener('input', schedule);
    mf.addEventListener('focusout', schedule);
    const content = contentOf(mf);
    // 가로 스크롤(캐럿 추적·터치 패닝 둘 다)마다 핸들이 따라가야 한다. 스크롤은
    // 즉시 반영해야 안 튀므로 rAF를 안 거친다. **패닝은 MathLive의 렌더를 안
    // 거치므로 캐시가 안 비워진다** — 여기서만 명시적으로 비운다(위 ⚠ 참고).
    const onScroll = (): void => {
      clearAtomBoundsCache(mf);
      remeasure();
    };
    content?.addEventListener('scroll', onScroll, { passive: true });
    const observer = content === null ? null : new ResizeObserver(schedule);
    observer?.observe(content as Element);
    const unsubscribe = onMobileViewportChange(schedule);
    schedule();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      mf.removeEventListener('selection-change', schedule);
      mf.removeEventListener('input', schedule);
      mf.removeEventListener('focusout', schedule);
      content?.removeEventListener('scroll', onScroll);
      observer?.disconnect();
      unsubscribe();
    };
  }, [mf, container]);

  if (placement === null || mf === null) return null;

  /** 손가락 x(경계로 클램프한 값)에서 오프셋을 다시 재고 원시 캐럿을 갱신한다. */
  const applyDragAt = (drag: Drag, clientX: number): void => {
    const contentBox = contentOf(mf)?.getBoundingClientRect();
    const x =
      contentBox === undefined
        ? clientX
        : Math.min(Math.max(clientX, contentBox.left), contentBox.right);
    // bias는 손가락 밑 원자를 **선택에 넣는** 쪽으로 준다: 왼쪽 끝이면 그 원자의
    // 왼쪽 경계(-1), 오른쪽 끝이면 오른쪽 경계(+1). 0으로 두면 원자 한가운데를
    // 기준 삼아, 원자 위에 손가락을 얹었는데 그게 빠지는 일이 생긴다(실측).
    //
    // ⚠ 잡은 핸들의 정체(`which`)나 직전 상태(`movingIsMin`)로는 정할 수 없다 —
    // **넘어가는 그 이동**에서는 둘 다 이미 낡았다(손가락은 반대편인데 bias는
    // 넘어가기 전 방향). 그래서 bias 0으로 한 번 가늠해 어느 쪽이 될지 정한 뒤,
    // 그 방향으로 다시 잰다. 두 번째 호출은 `atomBoundsCache` 가 더워져 있어 싸다.
    const probe = mf.getOffsetFromPoint(x, drag.midY, { bias: 0 });
    if (probe < 0) return;
    const offset = mf.getOffsetFromPoint(x, drag.midY, { bias: probe < drag.fixed ? -1 : 1 });
    if (offset < 0) return;
    // **교차를 막지 않는다** — 움직이는 캐럿이 고정 캐럿을 지나가면 그대로 두고,
    // 넘어간 쪽이 새 시작이 된다 (`setRawSelection` 은 순서를 안 가린다).
    // 다만 두 캐럿이 **같은 자리에 겹치면** 선택할 게 없어 사라지므로, 그때만
    // 가던 방향으로 한 칸 더 보낸다. 그쪽에 자리가 없으면(문서 양 끝) 반대로
    // 한 칸 — 그래서 맨 앞/뒤에서는 원자 하나가 남고 더는 안 줄어든다.
    let moving = offset;
    if (moving === drag.fixed) {
      const ahead = drag.movingIsMin ? drag.fixed + 1 : drag.fixed - 1;
      const behind = drag.movingIsMin ? drag.fixed - 1 : drag.fixed + 1;
      moving = ahead >= 0 && ahead <= mf.lastOffset ? ahead : behind;
    }
    drag.movingIsMin = moving < drag.fixed;
    setRawSelection(mf, moving, drag.fixed);
  };

  /** 손가락이 컨테이너 밖이면 그 방향으로 자동 스크롤을 걸거나 뗀다. */
  const updateAutoScroll = (drag: Drag, clientX: number): void => {
    const contentBox = contentOf(mf)?.getBoundingClientRect();
    let dir: -1 | 0 | 1 = 0;
    if (contentBox !== undefined) {
      if (clientX < contentBox.left) dir = -1;
      else if (clientX > contentBox.right) dir = 1;
    }
    if (dir === drag.autoScrollDir) return;
    if (drag.autoScrollTimer !== null) {
      clearInterval(drag.autoScrollTimer);
      drag.autoScrollTimer = null;
    }
    drag.autoScrollDir = dir;
    if (dir === 0) return;
    drag.autoScrollTimer = setInterval(() => {
      const content = contentOf(mf);
      if (content === null) return;
      content.scrollLeft += dir * AUTO_SCROLL_STEP_PX;
      // 우리가 직접 옮긴 스크롤이라 렌더를 안 거친다 — 다음 히트테스트 전에 비운다.
      clearAtomBoundsCache(mf);
      applyDragAt(drag, drag.lastClientX);
    }, AUTO_SCROLL_INTERVAL_MS);
  };

  const startDrag =
    (which: 'start' | 'end') =>
    (ev: React.PointerEvent<HTMLDivElement>): void => {
      // 필드에서 포커스를 뺏지 않는다 (툴바 버튼들과 같은 규율).
      ev.preventDefault();
      // 터치 제스처 층이 이걸 패닝/홀드로 오해하지 않게 한다 (거긴 capture라
      // 이 stopPropagation 으로는 못 막는다 — `touchGesture.ts` 가 `.sel-handle`
      // 을 직접 걸러낸다). 여기 stopPropagation은 셀 드래그 재정렬용이다.
      ev.stopPropagation();
      try {
        ev.currentTarget.setPointerCapture(ev.pointerId);
      } catch {
        // 캡처 실패해도 드래그 자체는 계속한다 (move/up이 핸들에 오는 한 동작,
        // `CellStack.tsx` 의 그룹 드래그와 같은 규율).
      }
      const raw = rawSelection(mf);
      if (raw === null) return;
      const [ra, rb] = raw;
      dragRef.current = {
        which,
        midY: placement.midY,
        fixed: which === 'start' ? Math.max(ra, rb) : Math.min(ra, rb),
        // 잡은 순간에는 잡은 쪽이 곧 그쪽 끝이다. 교차하면 `applyDragAt` 이 뒤집는다.
        movingIsMin: which === 'start',
        autoScrollDir: 0,
        autoScrollTimer: null,
        lastClientX: ev.clientX,
      };
    };

  const onDragMove = (ev: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    ev.preventDefault();
    drag.lastClientX = ev.clientX;
    applyDragAt(drag, ev.clientX);
    updateAutoScroll(drag, ev.clientX);
  };

  const endDrag = (ev: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    if (drag.autoScrollTimer !== null) clearInterval(drag.autoScrollTimer);
    dragRef.current = null;
    try {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    } catch {
      // 캡처가 애초에 안 됐으면 그냥 넘어간다.
    }
  };

  /**
   * `id` = 물리 핸들의 **정체**. React 키이자 포인터 캡처가 걸리는 노드라 드래그
   * 내내 안 바뀐다. `side` = 지금 화면에서 **어느 끝**에 서 있는가 — 손잡이가
   * 위냐 아래냐, 핀 화살촉이 어느 쪽을 가리키냐가 여기 걸린다.
   * 교차하기 전에는 둘이 같고, 교차하면 갈린다.
   */
  const handle = (id: 'start' | 'end', side: 'start' | 'end', edge: Edge) => (
    <div
      key={id}
      className={`sel-handle sel-handle-${side}${edge.pinned ? ' sel-handle-pinned' : ''}`}
      data-testid={`sel-handle-${side}`}
      style={{
        left: `${edge.x}px`,
        top: `${placement.top}px`,
        height: `${placement.bottom - placement.top}px`,
      }}
      onPointerDown={startDrag(id)}
      onPointerMove={onDragMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );

  // 드래그 중에는 **쥔 노드를 손가락 쪽**(움직이는 캐럿 쪽)에 붙여 둔다. 안 그러면
  // 교차하는 순간 쥔 핸들이 반대편으로 순간이동한다 — 포인터 캡처 덕에 드래그가
  // 끊기지는 않지만, 손가락 밑에 없는 핸들을 끌고 있는 꼴이 된다.
  const drag = dragRef.current;
  const flip = (w: 'start' | 'end'): 'start' | 'end' => (w === 'start' ? 'end' : 'start');
  const minId =
    drag === null ? 'start' : drag.movingIsMin ? drag.which : flip(drag.which);

  return (
    <>
      {handle(minId, 'start', placement.start)}
      {handle(flip(minId), 'end', placement.end)}
    </>
  );
}
