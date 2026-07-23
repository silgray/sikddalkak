import { useState } from 'react';

/**
 * 상단 도움말: 단축키와 기능(선택 변환, 모드) 설명. `?` 버튼으로 접고 편다.
 * UI는 영어 (MathLive 폰트가 한글 글리프를 렌더하지 못하는 제약과 톤 일치).
 */
export function HelpPanel() {
  const [open, setOpen] = useState(false);

  return (
    <div className="help">
      <button
        type="button"
        className="help-toggle"
        aria-expanded={open}
        title={open ? 'Hide help' : 'Shortcuts & features'}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open && (
        <div className="help-panel">
          <section>
            <h2>Shortcuts</h2>
            <dl>
              <div>
                <dt>
                  <kbd>Enter</kbd>
                </dt>
                <dd>Evaluate the cell</dd>
              </div>
              <div>
                <dt>
                  <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd>
                </dt>
                <dd>Undo / redo — whole keywords (cos, sin, …) and numbers undo in one step</dd>
              </div>
              <div>
                <dt>
                  <kbd>Shift</kbd>+<kbd>←</kbd>/<kbd>→</kbd>
                </dt>
                <dd>Extend selection one item at a time — fractions and matrices select whole</dd>
              </div>
              <div>
                <dt>
                  <kbd>Ctrl</kbd>+<kbd>D</kbd>
                </dt>
                <dd>
                  Grow selection by structure: innermost group → enclosing element → whole
                  expression
                </dd>
              </div>
              <div>
                <dt>
                  <kbd>↑</kbd>/<kbd>↓</kbd>
                </dt>
                <dd>At the edge of a cell, move to the previous / next cell</dd>
              </div>
              <div>
                <dt>
                  <kbd>)</kbd>
                </dt>
                <dd>With no open paren, wraps everything to the left at the same level</dd>
              </div>
              <div>
                <dt>Drag ⠿</dt>
                <dd>Reorder cells (results follow their definitions, not their position)</dd>
              </div>
            </dl>
          </section>
          <section>
            <h2>Selection transforms</h2>
            <p>Select part of an expression (drag, Shift+arrows, or Ctrl+D) and buttons appear:</p>
            <dl>
              <div>
                <dt>expand</dt>
                <dd>Multiply out products and powers; computes selected matrix products</dd>
              </div>
              <div>
                <dt>simplify</dt>
                <dd>Algebraic cleanup — cancellation, trig identities</dd>
              </div>
              <div>
                <dt>factor</dt>
                <dd>
                  Pull out common factors (including non-polynomial ones like cos&nbsp;x) and
                  factor polynomials
                </dd>
              </div>
            </dl>
            <p>
              Selections that cut across matrix cells can’t be transformed — select whole
              matrices instead.
            </p>
          </section>
          <section>
            <h2>Cells</h2>
            <dl>
              <div>
                <dt>a = 3</dt>
                <dd>Defines a variable other cells can use (order doesn’t matter)</dd>
              </div>
              <div>
                <dt>scoped / symbolic</dt>
                <dd>
                  scoped substitutes variables defined elsewhere; symbolic leaves them as unknowns
                </dd>
              </div>
              <div>
                <dt>Result rows</dt>
                <dd>Editable — the first change detaches them into an independent expression</dd>
              </div>
            </dl>
          </section>
        </div>
      )}
    </div>
  );
}
