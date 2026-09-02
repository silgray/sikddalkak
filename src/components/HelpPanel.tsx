import { useEffect, useRef, useState } from 'react';

/**
 * 상단 도움말: 눈으로 봐서는 뜻을 알 수 없는 UI 컨트롤과 기본 단축키만. `?` 버튼으로
 * 접고 편다. UI는 영어 (MathLive 폰트가 한글 글리프를 렌더하지 못하는 제약과 톤 일치).
 *
 * **여기는 짧게 유지한다.** 지원 표기법·인라인 숏컷·단축키 전체는 README 하나에 모여
 * 있고(맨 아래 링크), 같은 사실을 두 곳에 적으면 한쪽만 고쳤을 때 어긋난다. 단축키
 * 목록은 README 의 `### Edit` 표와 **같은 여섯 개**다 — 늘릴 거면 양쪽을 같이 고칠 것.
 *
 * 스크롤 영역(`.help-panel-body`)과 README 링크(`.help-more`)를 별개 div로 가른다 —
 * 패널을 얼마나 내리든 링크가 늘 바닥에 붙어 있게 하려면 스크롤 컨테이너 밖에 있어야
 * 한다(`styles.css`의 `.help-panel`이 flex column, `.help-panel-body`만 `overflow-y`).
 */
export function HelpPanel() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 패널 바깥을 누르면 접는다. 버튼 자신도 `.help` 안이라 토글 클릭과 안 겹친다.
  useEffect(() => {
    if (!open) return;
    const onOutsidePointerDown = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onOutsidePointerDown, { capture: true });
    return () => document.removeEventListener('pointerdown', onOutsidePointerDown, { capture: true });
  }, [open]);

  return (
    <div className="help" ref={rootRef}>
      <button
        type="button"
        className="help-toggle"
        aria-expanded={open}
        title={open ? 'Hide help' : 'Shortcuts & interface'}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open && (
        <div className="help-panel">
          <div className="help-panel-body">
            <section>
              <h2>Shortcuts</h2>
              <dl>
                <div>
                  <dt>
                    <kbd>Enter</kbd>
                  </dt>
                  <dd>Evaluate the current expression</dd>
                </div>
                {/* 아래/위를 한 줄에 묶으면 `dt` 가 고정폭 11rem(`styles.css`)을 넘겨
                    이 행만 `dd` 가 오른쪽으로 밀린다 — 실측 210px. 두 줄로 가른다. */}
                <div>
                  <dt>
                    <kbd>Ctrl</kbd>+<kbd>Enter</kbd>
                  </dt>
                  <dd>Insert a new empty cell below</dd>
                </div>
                <div>
                  <dt>
                    <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd>
                  </dt>
                  <dd>Insert a new empty cell above</dd>
                </div>
                <div>
                  <dt>
                    <kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd>
                  </dt>
                  <dd>Move the cell up / down</dd>
                </div>
                <div>
                  <dt>
                    <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd>
                  </dt>
                  <dd>Duplicate the cell below / above</dd>
                </div>
                <div>
                  <dt>
                    <kbd>Ctrl</kbd>+<kbd>D</kbd>
                  </dt>
                  <dd>Grow the selection</dd>
                </div>
                <div>
                  <dt>
                    <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>/<kbd>S</kbd>/<kbd>F</kbd>
                  </dt>
                  <dd>Apply expand / simplify / factor to the selection</dd>
                </div>
              </dl>
            </section>
            <section>
              <h2>Interface</h2>
              <dl>
                <div>
                  <dt>⠿</dt>
                  <dd>Drag to reorder cells</dd>
                </div>
                <div>
                  <dt>● / ○</dt>
                  <dd>Exclude the cell from calculation without deleting it</dd>
                </div>
                <div>
                  <dt>×</dt>
                  <dd>Delete the cell</dd>
                </div>
                <div>
                  <dt>formula / decimal</dt>
                  <dd>
                    Show the exact value or an approximation
                  </dd>
                </div>
              </dl>
            </section>
          </div>
          <p className="help-more">
            <a href="https://github.com/silgray/sikddalkak#readme" target="_blank" rel="noreferrer">
              Full notation and shortcut reference →
            </a>
          </p>
        </div>
      )}
    </div>
  );
}
