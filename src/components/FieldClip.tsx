import { useEffect, useRef, useState, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
  /** 지금 이 필드에 보이는 latex — 값이 바뀌면 다시 잰다(길이로 어림하지는 않는다). */
  watch: string;
};

/** 어느 쪽이 잘려 있나. 둘 다 false면 식이 통째로 보인다. */
type Clipped = { readonly left: boolean; readonly right: boolean };

const NOTHING_CLIPPED: Clipped = { left: false, right: false };

/** 스크롤 양 끝을 반올림 오차로 놓치지 않게 두는 여유(px). */
const EDGE_SLACK = 2;

/** `.ML__content` 가 아직 안 생겼을 때 다시 볼 프레임 수. */
const ATTACH_RETRIES = 10;

/**
 * 긴 수식을 셀 안에 가둬 보여주고, **지금 가려져 있는 쪽에만** 말줄임표를 띄운다.
 *
 * 넘침은 **실제로 잰다** — MathLive의 콘텐츠 상자(`.ML__content`, 셰도우 DOM 안)가
 * `overflow: hidden` 인 스크롤 컨테이너이고(실측: `mathlive.mjs` 의 `.ML__content`
 * 규칙), MathLive 자신이 편집·캐럿 이동마다 `field.scroll({left})` 로 캐럿을 따라
 * 가로 스크롤한다(`Mathfield.scrollIntoView`). 그래서 우리가 할 일은 그 요소의
 * `scrollLeft`/`scrollWidth`/`clientWidth` 를 읽는 것뿐이다 — 표시 범위 이동은 공짜다.
 *
 * ⚠ **`::part(content)` 에 `overflow` 를 덮어쓰면 안 된다.** 예전 구현이
 * `overflow: visible` 을 걸어 그 스크롤 컨테이너를 없애버렸고, 그래서 `scrollWidth` 가
 * 늘 `clientWidth` 와 같아 넘침을 못 쟀다("MathLive가 폭을 다시 안 잰다" 는 그때의
 * 결론은 이 override 아래에서의 관찰이었다). 그 대신 latex **글자 수 > 50** 으로
 * 어림했는데, `\begin{pmatrix}…` 처럼 구조 문자가 많은 짧은 식이 전부 넘침으로
 * 잡혔다(사용자 보고). 지금은 override도 임계값도 없다.
 *
 * 펼침 버튼은 없앴다 — 캐럿을 옮기면 보이는 창이 따라 움직이는 게 원래 의도다.
 */
export function FieldClip({ children, watch }: Props) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState<Clipped>(NOTHING_CLIPPED);
  /** 값이 바뀌었을 때 부를 재측정. 구독 이펙트가 채운다. */
  const remeasureRef = useRef<() => void>(() => {});

  useEffect(() => {
    const row = rowRef.current;
    if (row === null) return;

    let frame = 0;
    let detach: (() => void) | null = null;
    let retries = ATTACH_RETRIES;

    const attach = (): boolean => {
      const mf = row.querySelector('math-field');
      const content = mf?.shadowRoot?.querySelector('.ML__content') ?? null;
      if (mf === null || content === null) return false;

      const measure = () => {
        const hidden = content.scrollWidth - content.clientWidth;
        const left = content.scrollLeft > EDGE_SLACK;
        const right = hidden - content.scrollLeft > EDGE_SLACK;
        // 같은 상태면 참조를 유지해 리렌더를 막는다 — 캐럿 이동마다 도는 자리다.
        setClipped((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
      };
      // MathLive는 rAF에서 렌더한다 — 값이 바뀐 직후 바로 재면 옛 폭을 본다.
      const schedule = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(measure);
      };
      remeasureRef.current = schedule;

      // scroll 은 MathLive가 캐럿을 따라 옮길 때 발화한다 — 즉시 반영해야 표식이 안 튄다.
      content.addEventListener('scroll', measure, { passive: true });
      // input 은 내용 폭이, selection-change 는 스크롤 위치가 바뀔 수 있는 지점.
      mf.addEventListener('input', schedule);
      mf.addEventListener('selection-change', schedule);
      // 셀 폭이 바뀌면(창 크기, 버튼 등장) 같은 식도 잘림 여부가 달라진다.
      const observer = new ResizeObserver(schedule);
      observer.observe(content);
      schedule();

      detach = () => {
        content.removeEventListener('scroll', measure);
        mf.removeEventListener('input', schedule);
        mf.removeEventListener('selection-change', schedule);
        observer.disconnect();
      };
      return true;
    };

    // `MathField` 는 자식이라 그 layout 이펙트가 먼저 돌지만(= mathfield는 이미 있다),
    // 셰도우 DOM 구성은 MathLive 쪽 사정이라 한 프레임 늦을 수 있다.
    let retryFrame = 0;
    const tryAttach = () => {
      if (attach()) return;
      retries -= 1;
      if (retries > 0) retryFrame = requestAnimationFrame(tryAttach);
    };
    tryAttach();

    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(retryFrame);
      remeasureRef.current = () => {};
      detach?.();
    };
  }, []);

  useEffect(() => {
    remeasureRef.current();
  }, [watch]);

  const clipClassName = [
    'field-clip',
    clipped.left && 'field-clip-more-left',
    clipped.right && 'field-clip-more-right',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="field-clip-row" ref={rowRef}>
      <div className={clipClassName}>{children}</div>
    </div>
  );
}
