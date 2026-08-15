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
                <dd>Confirm the result — stays shown until you edit the group. Focus doesn’t move</dd>
              </div>
              <div>
                <dt>
                  <kbd>Ctrl</kbd>+<kbd>Enter</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd>
                </dt>
                <dd>New empty cell below / above, outside the current group, and focus it</dd>
              </div>
              <div>
                <dt>
                  <kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd>
                </dt>
                <dd>Move this cell’s whole group up / down</dd>
              </div>
              <div>
                <dt>
                  <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd>
                </dt>
                <dd>Duplicate this cell into its own group, placed below / above (cursor stays put)</dd>
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
                  <kbd>Backspace</kbd>
                </dt>
                <dd>In an empty cell, deletes it and moves to the end of the cell above</dd>
              </div>
              <div>
                <dt>
                  <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>/<kbd>S</kbd>/<kbd>F</kbd>
                </dt>
                <dd>Apply expand / simplify / factor to the selection</dd>
              </div>
              <div>
                <dt>
                  <kbd>Alt</kbd>+<kbd>-</kbd>
                </dt>
                <dd>Overline — wraps the selection, or the item before the caret</dd>
              </div>
              <div>
                <dt>
                  <kbd>)</kbd>
                </dt>
                <dd>With no open paren, wraps everything to the left at the same level</dd>
              </div>
              <div>
                <dt>Drag ⠿</dt>
                <dd>Reorder whole groups (results follow their definitions, not their position)</dd>
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
              matrices instead. Selecting a whole matrix also shows a floating toolbar for
              changing its delimiters.
            </p>
          </section>
          <section>
            <h2>Matrix notation</h2>
            <dl>
              <div>
                <dt>
                  A<sup>T</sup>
                </dt>
                <dd>Transpose</dd>
              </div>
              <div>
                <dt>
                  A<sup>*</sup>
                </dt>
                <dd>Complex conjugate, entry by entry (positions unchanged)</dd>
              </div>
              <div>
                <dt>
                  A<sup>†</sup>
                </dt>
                <dd>Conjugate transpose — conjugate and transpose together</dd>
              </div>
            </dl>
            <p>
              The last two compute only when the cell is evaluated, and only once the matrix
              is a concrete one — on a plain symbol they stay as written.
            </p>
          </section>
          <section>
            <h2>Cells &amp; groups</h2>
            <dl>
              <div>
                <dt>a = 3</dt>
                <dd>
                  Defines a variable other cells can use (order doesn’t matter). Only valid as the
                  top cell of a group
                </dd>
              </div>
              <div>
                <dt>Result row</dt>
                <dd>
                  Editable — the first change turns it into a new cell in the same group, right
                  below. Each group has one result row, at the bottom
                </dd>
              </div>
              <div>
                <dt>● / ○ toggle</dt>
                <dd>Excludes the cell from calculation (dims it) without deleting it</dd>
              </div>
              <div>
                <dt>× (top of group)</dt>
                <dd>Deletes the whole group</dd>
              </div>
              <div>
                <dt>× (sub-cell, dimmer)</dt>
                <dd>Deletes just that one cell</dd>
              </div>
            </dl>
          </section>
        </div>
      )}
    </div>
  );
}
