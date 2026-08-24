import { useState } from 'react';
import { getActiveMathField } from '../editor/activeField';
import { feedKey, type KeyStroke } from '../editor/feedKey';

/**
 * 자체 키 팔레트. MathLive 자체 가상 키보드 대신 이걸 쓴다 — 버튼이 `mf.insert()`가
 * 아니라 `feedKey`로 **물리 키 입력과 같은 경로**를
 * 탄다(`feedKey.ts` 문서 참고).
 *
 * ⚠ **여기에 LaTeX을 적지 않는다.** `√`·`π`·`cos` 같은 키는 `chars('sqrt')` 처럼
 * **트리거 글자를 하나씩 흘려보내고**, 변환은 MathLive 인라인 숏컷 엔진이 한다.
 * 그래서 `MathField.tsx`의 숏컷 설정(`CUSTOM_INLINE_SHORTCUTS` 등)에서 결과 LaTeX을
 * 바꾸면 팔레트에 자동으로 반영된다. 유일한 예외가 `insert` 필드다(아래).
 *
 * 다만 **트리거 문자열과 라벨은 여전히 이 파일에 박혀 있다** — 숏컷을 끄거나
 * 이름을 바꾸면 팔레트가 조용히 리터럴을 입력하게 된다. 그걸 막는 게
 * `keyPalette.browser.test.tsx`의 "인라인 숏컷 의존" 스위트다: `viaShortcut`으로
 * 판정되는 키를 전부 실제로 눌러보고 리터럴이 남으면 실패한다.
 */

export type PaletteKey = {
  /** 버튼에 보이는 글자. */
  label: string;
  /** 순서대로 흘려보낼 키 입력들 — 기본 경로. */
  strokes?: KeyStroke[];
  /**
   * ⚠ **탈출구.** 키 입력으로는 낼 수 없는 것 전용(행렬). MathLive 자신도 ☰ 메뉴의
   * insert-matrix에서 `mf.insert()`를 쓴다(실측) — 행렬을 만드는 키스트로크 경로가
   * 라이브러리에 아예 없다. 이 경로만은 `keyOps`·인라인 숏컷을 안 탄다.
   * **새 키를 추가할 때 여기 손대지 말 것** — 먼저 `strokes`로 되는지 보라.
   */
  insert?: string;
  title?: string;
  /** 빈 칸(자리 맞춤). 버튼을 안 그린다. */
  blank?: boolean;
  /** 가로 폭 배수 (flex 기준). 기본 1. */
  span?: number;
};

/** 한 레이어의 배치. 1번 탭만 좌/우 두 블록으로 갈린다. */
export type PaletteLayer = {
  id: string;
  label: string;
} & ({ kind: 'rows'; rows: PaletteKey[][] } | { kind: 'split'; left: PaletteKey[][]; right: PaletteKey[][] });

/** 글자 하나의 물리 `code` — 있으면 키바인딩 매칭이 물리 입력과 같아진다. */
function codeOf(ch: string): string | undefined {
  if (/^[a-zA-Z]$/.test(ch)) return `Key${ch.toUpperCase()}`;
  if (/^[0-9]$/.test(ch)) return `Digit${ch}`;
  // 기호는 레이아웃마다 물리 키가 달라 함부로 못 정한다 — 비워 두면 MathLive가
  // `key` 로만 판단한다(`feedKey.ts` 참고).
  return undefined;
}

/** 평범한 문자열을 한 글자씩 `KeyStroke`로 편다 — 인라인 숏컷 버퍼가 노리는 그대로. */
function chars(text: string): KeyStroke[] {
  return [...text].map((key) => ({ key, code: codeOf(key) }));
}

/** 특수 키 하나. `code`는 `/`→분수처럼 코드 기반 키바인딩에 필요하다(feedKey.ts 참고). */
function key(k: string, code?: string, mods: Partial<KeyStroke> = {}): KeyStroke[] {
  return [{ key: k, code, ...mods }];
}

const BLANK: PaletteKey = { label: '', blank: true };
const HALF_BLANK: PaletteKey = { label: '', blank: true, span: 0.5 };

/** 기본 2×2 행렬. 크기 지정(홀드 그리드)은 다음 판. */
const MATRIX_2X2 = String.raw`\begin{pmatrix}#? & #?\\#? & #?\end{pmatrix}`;

// --- 1번 탭: 좌(기호·함수) + 우(숫자·연산) 두 블록 ---

const NUM_LEFT: PaletteKey[][] = [
  [
    { label: 'x', strokes: chars('x') },
    { label: 'y', strokes: chars('y') },
    { label: 'a²', strokes: [...chars('^'), ...chars('2')], title: 'square' },
    { label: 'a^□', strokes: chars('^'), title: 'superscript' },
  ],
  [
    { label: '(', strokes: chars('(') },
    { label: ')', strokes: chars(')') },
    BLANK,
    BLANK,
  ],
  [
    { label: '|a|', strokes: chars('|'), title: 'absolute value' },
    { label: 'sin', strokes: chars('sin') },
    { label: 'cos', strokes: chars('cos') },
    { label: 'tan', strokes: chars('tan') },
  ],
  [
    { label: '⊞', insert: MATRIX_2X2, title: 'matrix (2×2)' },
    { label: 'a_□', strokes: chars('_'), title: 'subscript' },
    { label: '√', strokes: chars('sqrt'), title: 'sqrt' },
    { label: 'π', strokes: chars('pi'), title: 'pi' },
  ],
];

const NUM_RIGHT: PaletteKey[][] = [
  [
    { label: '7', strokes: chars('7') },
    { label: '8', strokes: chars('8') },
    { label: '9', strokes: chars('9') },
    { label: '÷', strokes: key('/', 'Slash'), title: 'fraction' },
    BLANK,
  ],
  [
    { label: '4', strokes: chars('4') },
    { label: '5', strokes: chars('5') },
    { label: '6', strokes: chars('6') },
    { label: '×', strokes: chars('*'), title: 'cdot' },
    BLANK,
  ],
  [
    { label: '1', strokes: chars('1') },
    { label: '2', strokes: chars('2') },
    { label: '3', strokes: chars('3') },
    { label: '−', strokes: chars('-') },
    BLANK,
  ],
  [
    { label: '0', strokes: chars('0') },
    { label: '.', strokes: chars('.') },
    // 평가가 아니라 **문자 `=`** 다 — 평가는 nav 줄의 ↵ 가 맡는다.
    { label: '=', strokes: chars('=') },
    { label: '+', strokes: chars('+') },
    { label: '⌫', strokes: key('Backspace', 'Backspace'), title: 'backspace' },
  ],
];

// --- 2번 탭: 기호 한 줄 + QWERTY ---

const ABC_TOP: PaletteKey[] = [
  { label: 'a²', strokes: [...chars('^'), ...chars('2')], title: 'square' },
  { label: 'a^□', strokes: chars('^'), title: 'superscript' },
  { label: '+', strokes: chars('+') },
  { label: '−', strokes: chars('-') },
  { label: '·', strokes: chars('*'), title: 'cdot' },
  { label: '×', strokes: chars('xx'), title: 'times' },
  { label: '÷', strokes: key('/', 'Slash'), title: 'fraction' },
  { label: '(', strokes: chars('(') },
  { label: ')', strokes: chars(')') },
  { label: 'a_□', strokes: chars('_'), title: 'subscript' },
];

const letters = (row: string): PaletteKey[] =>
  [...row].map((ch) => ({ label: ch, strokes: chars(ch) }));

const ABC_ROWS: PaletteKey[][] = [
  ABC_TOP,
  letters('qwertyuiop'),
  // 가운데 줄은 반 칸씩 들여 위/아래 줄과 키 폭을 맞춘다(합이 10칸).
  [HALF_BLANK, ...letters('asdfghjkl'), HALF_BLANK],
  [
    { label: '⇧', title: 'shift (uppercase)' },
    ...letters('zxcvbnm'),
    { label: ',', strokes: chars(',') },
    { label: '⌫', strokes: key('Backspace', 'Backspace'), title: 'backspace' },
  ],
];

/** `⇧` 는 입력이 아니라 상태 토글이라 `strokes` 가 없다 — 그걸로 식별한다. */
const SHIFT_LABEL = '⇧';

// --- 3번 탭: 함수·기호 ---

const SYM_ROWS: PaletteKey[][] = [
  [
    { label: '√', strokes: chars('sqrt'), title: 'sqrt' },
    { label: 'π', strokes: chars('pi'), title: 'pi' },
    { label: 'Σ', strokes: chars('sum'), title: 'sum' },
    { label: '∫', strokes: chars('int'), title: 'integral' },
    { label: '∞', strokes: chars('infinity') },
    { label: '∂', strokes: chars('del') },
  ],
  [
    { label: 'sin', strokes: chars('sin') },
    { label: 'cos', strokes: chars('cos') },
    { label: 'tan', strokes: chars('tan') },
    { label: 'ln', strokes: chars('ln') },
    { label: 'log', strokes: chars('log') },
    { label: 'exp', strokes: chars('exp') },
  ],
  [
    { label: 'tr', strokes: chars('tr') },
    { label: 'z̄', strokes: chars('conj'), title: 'conjugate' },
    { label: 'α', strokes: chars('alpha') },
    { label: 'β', strokes: chars('beta') },
    { label: 'θ', strokes: chars('theta') },
    BLANK,
  ],
];

export const PALETTE_LAYERS: readonly PaletteLayer[] = [
  { id: 'num', label: '123', kind: 'split', left: NUM_LEFT, right: NUM_RIGHT },
  { id: 'abc', label: 'abc', kind: 'rows', rows: ABC_ROWS },
  { id: 'sym', label: 'ƒ(x)', kind: 'rows', rows: SYM_ROWS },
];

/**
 * 모든 레이어 밑에 늘 있는 줄 — 이동·평가·셀 추가는 레이어를 안 갈아도 손 닿는 자리에.
 *
 * ⚠ **`code`를 반드시 채운다(실측 버그, `keyPalette.browser.test.tsx`에 핀).**
 * MathLive의 `mightProducePrintableCharacter`(mathlive.mjs 실측)는 `evt.code === ''`
 * 이면 **무조건 true**를 낸다 — 그래서 `code` 없이 Backspace를 보내면 "출력 가능한
 * 문자일 수도 있다"로 오판되어 삭제 대신 아무 일도 안 일어난다.
 */
export const NAV_ROW: PaletteKey[] = [
  { label: '←', strokes: key('ArrowLeft', 'ArrowLeft'), title: 'move left' },
  { label: '→', strokes: key('ArrowRight', 'ArrowRight'), title: 'move right' },
  // 평가(Enter). 숫자 탭의 `=` 는 문자 입력이라 이쪽과 역할이 갈린다.
  { label: '=', strokes: key('Enter', 'Enter'), title: 'evaluate (Enter)' },
  // Ctrl+Enter — 그룹 밖 아래에 새 빈 셀(`MathField.tsx`의 onInsertCell).
  {
    label: '⏎',
    strokes: key('Enter', 'Enter', { ctrlKey: true }),
    title: 'new cell below (Ctrl+Enter)',
  },
];

/**
 * 탭 줄 오른쪽 끝의 실행취소/다시실행.
 *
 * 여기도 `feedKey` 를 탄다 — Ctrl+Z/Y 는 `Workspace.tsx` 가 **window 의 capture
 * 단계**에서 듣는데, `feedKey` 가 셰도우 싱크로 쏜 이벤트도 캡처 경로가 window 에서
 * 시작하므로 그대로 걸린다. 그래서 리듀서로 가는 별도 배선(prop drilling)이 필요
 * 없고, 물리 Ctrl+Z 와 **같은 경로·같은 히스토리 단위**가 보장된다.
 */
export const HISTORY_KEYS: PaletteKey[] = [
  { label: '↶', strokes: key('z', 'KeyZ', { ctrlKey: true }), title: 'undo (Ctrl+Z)' },
  { label: '↷', strokes: key('y', 'KeyY', { ctrlKey: true }), title: 'redo (Ctrl+Y)' },
];

/** 대문자 상태에서 흘려보낼 키로 바꾼다. 글자 키가 아니면 그대로. */
function shifted(strokes: KeyStroke[]): KeyStroke[] {
  return strokes.map((s) =>
    /^[a-z]$/.test(s.key) ? { ...s, key: s.key.toUpperCase(), shiftKey: true } : s,
  );
}

/** 버튼 하나 누름 = strokes를 순서대로 활성 필드에 흘린다. 대상이 없으면 no-op. */
function press(k: PaletteKey, upper: boolean): void {
  const mf = getActiveMathField();
  if (mf === null) return;
  if (k.insert !== undefined) {
    mf.insert(k.insert, { selectionMode: 'item' });
    return;
  }
  const strokes = upper ? shifted(k.strokes ?? []) : (k.strokes ?? []);
  for (const s of strokes) feedKey(mf, s);
}

function PaletteButton({
  k,
  upper,
  onToggleShift,
  onPressed,
}: {
  k: PaletteKey;
  upper: boolean;
  onToggleShift: () => void;
  /** 실제 입력이 일어난 뒤 — 대문자 한 번 쓰고 풀기(one-shot)에 쓴다. */
  onPressed: () => void;
}) {
  const flex = k.span ?? 1;
  if (k.blank === true) return <span className="palette-gap" style={{ flex }} />;

  const isShift = k.label === SHIFT_LABEL && k.strokes === undefined;
  const label = upper && /^[a-z]$/.test(k.label) ? k.label.toUpperCase() : k.label;

  return (
    <button
      type="button"
      className={isShift && upper ? 'palette-key palette-key-active' : 'palette-key'}
      style={{ flex }}
      title={k.title}
      aria-pressed={isShift ? upper : undefined}
      // 포커스를 뺏지 않는다 — activeField가 이 버튼을 누르는 동안에도 그대로
      // "지금 편집 중인 필드"를 가리켜야 한다(SelectionToolbar와 같은 관행).
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => {
        if (isShift) {
          onToggleShift();
          return;
        }
        press(k, upper);
        onPressed();
      }}
    >
      {label}
    </button>
  );
}

export function KeyPalette() {
  const [layerId, setLayerId] = useState<string>(PALETTE_LAYERS[0].id);
  const [upper, setUpper] = useState(false);
  const layer = PALETTE_LAYERS.find((l) => l.id === layerId) ?? PALETTE_LAYERS[0];

  const renderRow = (keys: PaletteKey[], i: number) => (
    <div className="key-palette-row" key={i}>
      {keys.map((k, j) => (
        <PaletteButton
          key={j}
          k={k}
          upper={upper}
          onToggleShift={() => setUpper((v) => !v)}
          // 대문자는 **한 번 쓰고 풀린다**(모바일 키보드 관행).
          onPressed={() => setUpper(false)}
        />
      ))}
    </div>
  );

  return (
    <div className="key-palette" role="group" aria-label="Symbol keyboard">
      <div className="key-palette-tabs">
        <div className="key-palette-tablist" role="tablist">
          {PALETTE_LAYERS.map((l) => (
            <button
              key={l.id}
              type="button"
              role="tab"
              aria-selected={l.id === layerId}
              className={l.id === layerId ? 'palette-tab palette-tab-active' : 'palette-tab'}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => setLayerId(l.id)}
            >
              {l.label}
            </button>
          ))}
        </div>
        {/* 탭 오른쪽 끝 — 레이어와 무관하게 늘 같은 자리. */}
        <div className="key-palette-history">
          {HISTORY_KEYS.map((k) => (
            <PaletteButton
              key={k.label}
              k={k}
              upper={false}
              onToggleShift={() => undefined}
              onPressed={() => undefined}
            />
          ))}
        </div>
      </div>

      <div className="key-palette-body">
        {layer.kind === 'split' ? (
          <div className="key-palette-split">
            <div className="key-palette-block">{layer.left.map(renderRow)}</div>
            <div className="key-palette-block">{layer.right.map(renderRow)}</div>
          </div>
        ) : (
          <div className="key-palette-block">{layer.rows.map(renderRow)}</div>
        )}
      </div>

      <div className="key-palette-nav">{renderRow(NAV_ROW, 0)}</div>
    </div>
  );
}
