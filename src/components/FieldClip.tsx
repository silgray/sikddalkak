import { useState, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
  /** 지금 이 필드에 보이는 latex — 길이로 넘침을 어림한다(아래 문서 참고). */
  watch: string;
};

/**
 * 넘칠 것 같다고 보는 기준 글자 수. 실제 렌더 폭이 아니라 대충의 신호라(아래 문서
 * 참고) 실측으로 다시 조정될 수 있다.
 */
const CLIP_THRESHOLD = 50;

/**
 * 긴 수식을 기본은 잘라 보여주고(좌우 페이드 + `..` 표식), 버튼으로 가로 스크롤을
 * 펼쳐 볼 수 있게 한다.
 *
 * **넘침 판정은 latex 길이로 어림한다 — 실제 렌더 폭 측정이 아니다.** 처음엔
 * `scrollWidth`/`clientWidth` 비교(`ResizeObserver`)로 짰지만, MathLive는 콘텐츠
 * 상자(part 이름: content) 폭을 최초 레이아웃 시점에만 계산해 두고 이후 키 입력마다
 * 다시 재지 않는다(브라우저 테스트로 확인 — 같은 필드에 아무리 긴 값을 넣어도
 * `scrollWidth`가 그대로였다) — 그래서 그 접근으로는 넘침을 잡지 못했다. 글자 수는
 * 부정확하지만(지수·분수처럼 압축되는 표기, 폰트 차이는 못 담는다) 최소한 동작은
 * 한다 — 1차 구현이고, 더 나은 신호(정확한 렌더 폭을 재는 MathLive API 등)를 찾으면
 * 여기만 바꾸면 된다.
 *
 * 펼침은 줄바꿈이 아니라 가로 스크롤이다 — MathLive는 수식 자동 줄바꿈을 지원하지
 * 않는다(실측).
 */
export function FieldClip({ children, watch }: Props) {
  const [expanded, setExpanded] = useState(false);
  const overflowing = watch.length > CLIP_THRESHOLD;

  const clipClassName = [
    'field-clip',
    overflowing && !expanded && 'field-clip-clipped',
    expanded && 'field-clip-expanded',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="field-clip-row">
      <div className={clipClassName}>{children}</div>
      {overflowing && (
        <button
          type="button"
          className="field-expand-btn"
          title={expanded ? 'Collapse' : 'Expand to see the whole expression'}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '⌃' : '⋯'}
        </button>
      )}
    </div>
  );
}
