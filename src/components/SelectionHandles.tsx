import { useEffect, useRef, useState } from 'react';
import type { MathfieldElement } from 'mathlive';
import { contentOf } from '../editor/internals';
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
 * 데스크톱에는 안 뜬다 — DOM은 늘 그리고 숨김은 CSS(`@media (max-width: 640px)`)가
 * 맡는다(브랜치 대원칙 3). 다만 **측정은** 모바일에서만 돈다: 선택이 바뀔 때마다
 * 도는 자리라 데스크톱에서 헛일할 이유가 없다. 그 판정도 `mobile.ts` 하나를 쓴다.
 */

type Edge = {
  /** 컨테이너 기준 x (px). */
  readonly x: number;
  /** 지금 보이는 범위 안인가 — 스크롤 밖으로 나간 핸들은 숨긴다. */
  readonly visible: boolean;
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

/** 스크롤 경계 반올림 오차 여유(px). */
const EDGE_SLACK = 2;

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
  const inView = (x: number): boolean =>
    x >= contentBox.left - EDGE_SLACK && x <= contentBox.right + EDGE_SLACK;

  return {
    top: top - box.top,
    bottom: bottom - box.top,
    start: { x: first.left - box.left, visible: inView(first.left) },
    end: { x: last.right - box.left, visible: inView(last.right) },
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
  readonly which: 'start' | 'end';
  readonly midY: number;
  /** 반대쪽(안 움직이는) 원시 캐럿 — `editor/rawSelection.ts` 참고. */
  readonly fixed: number;
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
    // 즉시 반영해야 안 튀므로 rAF를 안 거친다.
    content?.addEventListener('scroll', remeasure, { passive: true });
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
      content?.removeEventListener('scroll', remeasure);
      observer?.disconnect();
      unsubscribe();
    };
  }, [mf, container]);

  if (placement === null || mf === null) return null;

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
      };
    };

  const onDragMove = (ev: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    ev.preventDefault();
    // 손가락 y가 아니라 **선택 줄의 한가운데**로 히트테스트한다 (위 ⚠ 참고).
    // bias는 손가락 밑 원자를 **선택에 넣는** 쪽으로 준다: 시작 핸들이면 그 원자의
    // 왼쪽 경계(-1), 끝 핸들이면 오른쪽 경계(+1). 0으로 두면 원자 한가운데를 기준
    // 삼아, 원자 위에 손가락을 얹었는데 그게 빠지는 일이 생긴다(실측).
    const offset = mf.getOffsetFromPoint(ev.clientX, drag.midY, {
      bias: drag.which === 'start' ? -1 : 1,
    });
    if (offset < 0) return;
    // 양끝이 서로를 넘지 못하게 한다 — 최소 원자 하나는 남는다. `siblingRunRange`
    // 는 붕괴한(a===b) 범위를 형제 열로 못 넓혀 아무 것도 안 할 수 있어(null),
    // 여기서 미리 막아야 손가락이 반대쪽 핸들을 지나가도 선택이 사라지지 않는다.
    if (drag.which === 'start') setRawSelection(mf, Math.min(offset, drag.fixed - 1), drag.fixed);
    else setRawSelection(mf, drag.fixed, Math.max(offset, drag.fixed + 1));
  };

  const endDrag = (ev: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current === null) return;
    dragRef.current = null;
    try {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    } catch {
      // 캡처가 애초에 안 됐으면 그냥 넘어간다.
    }
  };

  const handle = (which: 'start' | 'end', edge: Edge) => (
    <div
      key={which}
      className={`sel-handle sel-handle-${which}`}
      data-testid={`sel-handle-${which}`}
      hidden={!edge.visible}
      style={{
        left: `${edge.x}px`,
        top: `${placement.top}px`,
        height: `${placement.bottom - placement.top}px`,
      }}
      onPointerDown={startDrag(which)}
      onPointerMove={onDragMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );

  return (
    <>
      {handle('start', placement.start)}
      {handle('end', placement.end)}
    </>
  );
}
