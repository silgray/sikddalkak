import { useRef, useState, useSyncExternalStore } from 'react';
import { getActiveMathField, isFieldFocused, subscribeFieldFocus } from '../editor/activeField';
import { feedKey, type KeyStroke } from '../editor/feedKey';
import { HOLD_DELAY_MS } from '../editor/touchGesture';

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
  /**
   * 톤을 깔아 흰 기호 키와 갈라 놓는다 — 숫자·백스페이스처럼 **자주 두드리는**
   * 키다. 색은 `styles/keyPalette.css` 의 `.palette-key-tint` 가 정한다.
   */
  tint?: boolean;
  /**
   * 강조색으로 채운다 — 하단 nav 줄의 `=`(평가)처럼 "이게 핵심 동작"임을 눈에
   * 먼저 띄워야 하는 자리(시안). 색은 `.palette-key-accent`.
   */
  accent?: boolean;
  /**
   * ⇧ 가 켜졌을 때 이 키 대신 흘릴 시퀀스. 대문자 **명령이 따로 있는** 그리스
   * 문자용이다(Γ Δ Θ Λ Ξ Π Σ Φ Ψ Ω — MathLive 인라인 숏컷 사전에 실재하는 것만,
   * 실측). 없으면 `shifted()` 로 대체한다 — 그건 단일 글자 키만 대문자화하므로,
   * 대문자 명령이 없는 그리스 키는 `upperStrokes` 없이 그대로(소문자) 나간다.
   */
  upperStrokes?: KeyStroke[];
  /**
   * 이 키만은 `PaletteButton` 이 아니라 전용 컴포넌트가 그린다 — 지금은
   * `'matrix'` 하나뿐(길게 눌러 크기를 고르는 `MatrixKeyButton`). `strokes`/
   * `insert` 는 이 키에서 안 쓴다(무시된다) — 자리만 데이터로 잡아 둔다.
   */
  special?: 'matrix';
};

/** ƒ(x) 레이어의 한 구획 — 소제목 + 그 아래 키들(7열 격자, 시안). */
export type PaletteSection = {
  heading: string;
  keys: PaletteKey[];
};

/** 한 레이어의 배치. 1번 탭은 좌/우(+선택 우측 좁은 열) 블록, ƒ(x) 탭은 소제목 달린 구획들. */
export type PaletteLayer = {
  id: string;
  label: string;
} & (
  | { kind: 'rows'; rows: PaletteKey[][] }
  | {
      kind: 'split';
      left: PaletteKey[][];
      right: PaletteKey[][];
      /** 좌우 블록 밖, 오른쪽 끝의 좁은 열(1번 탭의 ⌫ 자리, 시안). */
      aside?: PaletteKey[][];
    }
  | { kind: 'sections'; sections: PaletteSection[] }
);

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

/** 짧게 누르면(홀드 미만) 이 크기로 삽입한다 — 예전의 고정 2×2와 같은 기본값. */
const MATRIX_DEFAULT_SIZE = { rows: 2, cols: 2 };

/** `rows`×`cols` 행렬 LaTeX. 칸마다 `#?` 로 비워 둔다(placeholder). */
function matrixLatex(rows: number, cols: number): string {
  const row = Array.from({ length: cols }, () => '#?').join(' & ');
  const body = Array.from({ length: rows }, () => row).join('\\\\');
  return String.raw`\begin{pmatrix}${body}\end{pmatrix}`;
}

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
    { label: ',', strokes: chars(',') },
    // □/□ 는 이 앱이 이미 쓰는 "빈 자리" 표기다(옆의 a²·a^□·a_□ 와 같은 어휘) —
    // 분수 구조 자체를 그리는 전용 아이콘 없이 그 관례를 그대로 쓴다.
    { label: '□/□', strokes: key('/', 'Slash'), title: 'fraction' },
  ],
  [
    { label: '|a|', strokes: chars('|'), title: 'absolute value' },
    { label: 'sin', strokes: chars('sin') },
    { label: 'cos', strokes: chars('cos') },
    { label: 'tan', strokes: chars('tan') },
  ],
  [
    { label: '⊞', special: 'matrix', title: 'matrix (hold for size)' },
    { label: 'a_□', strokes: chars('_'), title: 'subscript' },
    { label: '√', strokes: chars('sqrt'), title: 'sqrt' },
    { label: 'π', strokes: chars('pi'), title: 'pi' },
  ],
];

/** 숫자 키 하나. 톤을 깔아 옆의 흰 연산자 키와 갈라 놓는다(`PaletteKey.tint`). */
function digit(ch: string): PaletteKey {
  return { label: ch, strokes: chars(ch), tint: true };
}

// 4열 — ⌫ 는 이 그리드 밖, 오른쪽 좁은 열(`NUM_ASIDE`)에 따로 산다(시안 B4:
// 두 블록 사이 20px 틈 + 36px 전용 열. `.key-palette-split`/`.key-palette-aside`,
// `keyPalette.css`).
const NUM_RIGHT: PaletteKey[][] = [
  [digit('7'), digit('8'), digit('9'), { label: '÷', strokes: chars('div'), title: 'divide' }],
  [digit('4'), digit('5'), digit('6'), { label: '×', strokes: chars('*'), title: 'cdot' }],
  [digit('1'), digit('2'), digit('3'), { label: '−', strokes: chars('-') }],
  [
    digit('0'),
    digit('.'),
    // 평가가 아니라 **문자 `=`** 다 — 평가는 nav 줄의 ↵ 가 맡는다.
    { label: '=', strokes: chars('=') },
    { label: '+', strokes: chars('+') },
  ],
];

/** 1번 탭 오른쪽 끝의 좁은 열 — 빈 칸 셋 위에 ⌫ 하나(시안). */
const NUM_ASIDE: PaletteKey[][] = [
  [BLANK],
  [BLANK],
  [BLANK],
  [{ label: '⌫', strokes: key('Backspace', 'Backspace'), title: 'backspace', tint: true }],
];

// --- 2번 탭: 숫자 한 줄 + QWERTY ---
// (기호는 `123`·`ƒ(x)` 탭에 이미 있다 — 여기 첫 줄은 시안대로 숫자를 둔다.)

/** 톤 없는 숫자 — `digit()`(123 탭)와 달리 abc·αβγ 탭은 흰 배경을 쓴다(시안). */
function plainDigit(ch: string): PaletteKey {
  return { label: ch, strokes: chars(ch) };
}

const DIGITS_ROW: PaletteKey[] = [...'1234567890'].map(plainDigit);

const letters = (row: string): PaletteKey[] =>
  [...row].map((ch) => ({ label: ch, strokes: chars(ch) }));

const ABC_ROWS: PaletteKey[][] = [
  DIGITS_ROW,
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

// --- 3번 탭: 그리스 문자 ---

/**
 * 그리스 소문자 하나. `upper`(대문자 명령이 따로 있는 열 글자만)는
 * `PaletteKey.upperStrokes` 로 얹는다 — 나머지는 `press()`/`shifted()` 가 그냥
 * 소문자 그대로 흘린다(대문자로 우겨 붙이면 트리거 자체가 안 맞는다).
 *
 * ⚠ **`ο`(omicron)만 예외** — MathLive 기본 사전에 `omicron` 트리거가 없다
 * (실측, 로마자 `o` 와 겹쳐 보여 따로 안 둔 듯하다). 그래서 이 키만 진짜 글자
 * `o` 하나를 흘린다 — 어차피 로마자 o와 시각적으로 구분이 안 되니 해가 없다.
 */
function greek(label: string, trigger: string, upperTrigger?: string): PaletteKey {
  if (trigger === 'o') return { label, strokes: chars('o') };
  return {
    label,
    strokes: chars(trigger),
    title: trigger,
    upperStrokes: upperTrigger === undefined ? undefined : chars(upperTrigger),
  };
}

const GR_ROWS: PaletteKey[][] = [
  DIGITS_ROW,
  // 9칸뿐이라 양끝에 반 칸씩 들여 위 숫자 줄(10칸)과 세로로 맞춘다(ABC_ROWS의
  // asdf 줄과 같은 요령).
  [
    HALF_BLANK,
    // ς(끝시그마)는 대문자가 없다 — `MathField.tsx` 의 커스텀 `varsigma` 트리거.
    greek('ς', 'varsigma'),
    greek('ε', 'epsilon'),
    greek('ρ', 'rho'),
    greek('τ', 'tau'),
    greek('υ', 'upsilon'),
    greek('θ', 'theta', 'Theta'),
    greek('ι', 'iota'),
    greek('ο', 'o'),
    greek('π', 'pi', 'Pi'),
    HALF_BLANK,
  ],
  [
    HALF_BLANK,
    greek('α', 'alpha'),
    greek('σ', 'sigma', 'Sigma'),
    greek('δ', 'delta', 'Delta'),
    greek('φ', 'phi', 'Phi'),
    greek('γ', 'gamma', 'Gamma'),
    greek('η', 'eta'),
    greek('ξ', 'xi', 'Xi'),
    greek('κ', 'kappa'),
    greek('λ', 'lambda', 'Lambda'),
    HALF_BLANK,
  ],
  [
    { label: '⇧', title: 'shift (uppercase)', span: 1.3 },
    greek('ζ', 'zeta'),
    greek('χ', 'chi'),
    greek('ψ', 'psi', 'Psi'),
    greek('ω', 'omega', 'Omega'),
    greek('β', 'beta'),
    greek('ν', 'nu'),
    greek('μ', 'mu'),
    { label: '⌫', strokes: key('Backspace', 'Backspace'), title: 'backspace', span: 1.3 },
  ],
];

// --- 4번 탭: 함수·기호 (소제목 달린 구획, 시안) ---

/**
 * 소제목 달린 구획들(시안) — 7열 스크롤 격자. 각 트리거는 실측 확인했다
 * (`node_modules/mathlive/mathlive.mjs` 의 `INLINE_SHORTCUTS`, 없는 셋은
 * `MathField.tsx` 의 `CUSTOM_INLINE_SHORTCUTS` 에 새로 얹었다: `star`·`ddx`).
 *
 * ⚠ 예전 sym 탭에 있던 `∞`·`∂`·conjugate(`z̄`)는 시안 이 화면엔 없어서 뺐다 —
 * `∞`는 `infinity`, conjugate 는 `conj` 트리거로 여전히 살아있으니(각각
 * Alt+- 키바인딩 등 다른 경로), 없어진 건 **이 팔레트의 버튼**뿐이다.
 */
const SYM_SECTIONS: PaletteSection[] = [
  {
    heading: 'Operators',
    keys: [
      { label: '√', strokes: chars('sqrt'), title: 'sqrt' },
      { label: 'Σ', strokes: chars('sum'), title: 'sum' },
      { label: '∏', strokes: chars('prod'), title: 'product' },
      { label: '×', strokes: chars('times'), title: 'times' },
      { label: '·', strokes: chars('*'), title: 'cdot' },
      { label: '⋆', strokes: chars('star'), title: 'star' },
      // 'tt' 는 기존 커스텀 트리거(`MathField.tsx`)를 그대로 쓴다 — 라벨만 †.
      { label: '†', strokes: chars('tt'), title: 'dagger' },
    ],
  },
  {
    heading: 'Trigonometric',
    keys: [
      { label: 'sin', strokes: chars('sin') },
      { label: 'cos', strokes: chars('cos') },
      { label: 'tan', strokes: chars('tan') },
      { label: 'sec', strokes: chars('sec') },
      { label: 'csc', strokes: chars('csc') },
      { label: 'cot', strokes: chars('cot') },
    ],
  },
  {
    heading: 'Inverse trig',
    keys: [
      { label: 'arcsin', strokes: chars('arcsin') },
      { label: 'arccos', strokes: chars('arccos') },
      { label: 'arctan', strokes: chars('arctan') },
    ],
  },
  {
    heading: 'Hyperbolic',
    keys: [
      { label: 'sinh', strokes: chars('sinh') },
      { label: 'cosh', strokes: chars('cosh') },
      { label: 'tanh', strokes: chars('tanh') },
      { label: 'coth', strokes: chars('coth') },
      { label: 'sech', strokes: chars('sech') },
    ],
  },
  {
    heading: 'Log & exp',
    keys: [
      { label: 'ln', strokes: chars('ln') },
      { label: 'log', strokes: chars('log') },
      { label: 'lg', strokes: chars('lg') },
      { label: 'exp', strokes: chars('exp') },
    ],
  },
  {
    heading: 'Matrix & complex',
    keys: [
      { label: 'det', strokes: chars('det') },
      // 기존 커스텀 트리거를 그대로 쓴다(`MathField.tsx`).
      { label: 'tr', strokes: chars('tr') },
      // MathLive 기본 사전은 대문자 `Re`/`Im` 만 있다(소문자 없음, 실측).
      { label: 'Re', strokes: chars('Re'), title: 'real part' },
      { label: 'Im', strokes: chars('Im'), title: 'imaginary part' },
    ],
  },
  {
    heading: 'Other',
    keys: [
      // `conj` 커스텀 트리거(`\overline{#?}`, `MathField.tsx`)를 재사용한다 —
      // 시안의 "위에 줄 긋기"와 기존 켤레 표기가 결과적으로 같은 LaTeX이다.
      { label: 'a̅', strokes: chars('conj'), title: 'overline' },
      { label: '∇', strokes: chars('nabla') },
      { label: 'd/dx', strokes: chars('ddx'), title: 'derivative' },
    ],
  },
];

export const PALETTE_LAYERS: readonly PaletteLayer[] = [
  { id: 'num', label: '123', kind: 'split', left: NUM_LEFT, right: NUM_RIGHT, aside: NUM_ASIDE },
  { id: 'abc', label: 'abc', kind: 'rows', rows: ABC_ROWS },
  { id: 'gr', label: 'αβγ', kind: 'rows', rows: GR_ROWS },
  { id: 'sym', label: 'ƒ(x)', kind: 'sections', sections: SYM_SECTIONS },
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
  // Ctrl+Enter — 그룹 밖 아래에 새 빈 셀(`MathField.tsx`의 onInsertCell). 시안은
  // 화살표 다음, 평가 앞에 둔다 — 폭도 평가보다 좁다(56px 대 96px, span으로 흉내).
  {
    label: '⏎',
    strokes: key('Enter', 'Enter', { ctrlKey: true }),
    title: 'new cell below (Ctrl+Enter)',
    span: 0.85,
  },
  // 평가(Enter). 숫자 탭의 `=` 는 문자 입력이라 이쪽과 역할이 갈린다. 시안에서
  // 이 줄의 유일한 강조색 키다 — "이게 핵심 동작"임을 눈에 먼저 띄운다.
  { label: '=', strokes: key('Enter', 'Enter'), title: 'evaluate (Enter)', accent: true, span: 1.6 },
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

/**
 * 대문자 상태에서 흘려보낼 키로 바꾼다. **단일 글자 키만** 대문자화한다 —
 * 여러 글자를 흘리는 트리거(`chars('alpha')` 등)를 통째로 대문자화하면
 * 글자 하나하나가 `shiftKey:true` 로 나가 트리거 자체가 안 맞아버린다
 * (실측: `SHIFT` 를 누른 채 다른 탭의 `sin`/`alpha` 류 키를 누르면 리터럴
 * "SIN"/"ALPHA" 가 그대로 박혔다 — 그리스 탭을 새로 얹으며 드러난 기존 버그,
 * 여기서 같이 고친다). 대문자 명령이 따로 있는 키는 `PaletteKey.upperStrokes`
 * 로 명시하고, 여기 도달하는 건 그게 없는 경우뿐이다.
 */
function shifted(strokes: KeyStroke[]): KeyStroke[] {
  if (strokes.length !== 1) return strokes;
  const [s] = strokes;
  if (!/^[a-z]$/.test(s.key)) return strokes;
  return [{ ...s, key: s.key.toUpperCase(), shiftKey: true }];
}

/** 버튼 하나 누름 = strokes를 순서대로 활성 필드에 흘린다. 대상이 없으면 no-op. */
function press(k: PaletteKey, upper: boolean): void {
  const mf = getActiveMathField();
  if (mf === null) return;
  if (k.insert !== undefined) {
    mf.insert(k.insert, { selectionMode: 'item' });
    return;
  }
  const strokes = upper ? (k.upperStrokes ?? shifted(k.strokes ?? [])) : (k.strokes ?? []);
  for (const s of strokes) feedKey(mf, s);
}

/**
 * 격자 한 칸의 열/행(1부터 시작, `MATRIX_GRID_SIZE` 까지).
 */
type MatrixSize = { rows: number; cols: number };

/** 행렬 크기 고르는 격자의 한 변 길이. */
const MATRIX_GRID_SIZE = 5;

/**
 * 행렬 키 — 길게 누르면 5×5 격자가 뜨고, 손가락을 격자 위로 끌면 크기가
 * 미리보기로 따라온다(시안). **짧게 누르면**(홀드 시간 못 채우고 뗌) 예전과
 * 같은 기본 2×2를 넣는다 — 이 갈래는 `PaletteButton`의 일반 클릭 경로와 똑같이
 * 동작해야 하므로 `onClick` 을 그대로 쓰고, 홀드로 이미 처리한 경우에만
 * `suppressClick` 으로 그 뒤에 오는 click을 걸러낸다.
 *
 * ⚠ **포커스를 안 뺏는다** — 다른 팔레트 키와 같은 관행으로 `pointerdown` 에서
 * `preventDefault` 한다. 홀드 로직이 그 위에 얹히므로 이것부터 깨지면 안 된다.
 */
function MatrixKeyButton({
  flex,
  title,
  onInserted,
}: {
  flex: number;
  title: string | undefined;
  /** 삽입이 끝난 뒤(홀드든 짧은 클릭이든) — shift 한 번 쓰고 풀기와 같은 규율. */
  onInserted: () => void;
}) {
  const [preview, setPreview] = useState<MatrixSize | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const suppressClick = useRef(false);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const clearHoldTimer = () => {
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  };

  /** 손가락 좌표 → 격자 칸(1..MATRIX_GRID_SIZE). 격자가 아직 안 떴으면 null. */
  const cellAt = (clientX: number, clientY: number): MatrixSize | null => {
    const grid = gridRef.current;
    if (grid === null) return null;
    const rect = grid.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const clamp = (v: number) => Math.min(MATRIX_GRID_SIZE, Math.max(1, v));
    const cols = clamp(Math.ceil(((clientX - rect.left) / rect.width) * MATRIX_GRID_SIZE));
    const rows = clamp(Math.ceil(((clientY - rect.top) / rect.height) * MATRIX_GRID_SIZE));
    return { rows, cols };
  };

  const insert = (size: MatrixSize): void => {
    const mf = getActiveMathField();
    if (mf === null) return;
    mf.insert(matrixLatex(size.rows, size.cols), { selectionMode: 'item' });
  };

  return (
    <button
      type="button"
      className="palette-key"
      style={{ flex, position: 'relative' }}
      title={title}
      onPointerDown={(e) => {
        e.preventDefault();
        // 홀드 중엔 손가락이 버튼 밖(격자 위)으로 나간다 — 캡처해야 이 버튼이
        // move/up을 계속 받는다. 실패해도(브라우저/환경에 따라 던질 수 있다,
        // 실측 — 이 포인터가 "활성"으로 안 잡히는 경우) 뒤 로직은 계속 돈다.
        // 캡처가 안 됐을 뿐 대부분의 손짓은 여전히 같은 요소 위에서 끝난다.
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* 캡처 실패 — 무시하고 계속한다 */
        }
        clearHoldTimer();
        held.current = false;
        holdTimer.current = setTimeout(() => {
          held.current = true;
          setPreview(MATRIX_DEFAULT_SIZE);
        }, HOLD_DELAY_MS);
      }}
      onPointerMove={(e) => {
        if (!held.current) return;
        const cell = cellAt(e.clientX, e.clientY);
        if (cell !== null) setPreview(cell);
      }}
      onPointerUp={() => {
        clearHoldTimer();
        if (held.current) {
          insert(preview ?? MATRIX_DEFAULT_SIZE);
          suppressClick.current = true;
          onInserted();
        }
        setPreview(null);
        held.current = false;
      }}
      onPointerCancel={() => {
        clearHoldTimer();
        setPreview(null);
        held.current = false;
      }}
      onClick={() => {
        if (suppressClick.current) {
          // 홀드로 이미 넣었다 — 뒤이은 click은 또 넣지 않는다.
          suppressClick.current = false;
          return;
        }
        insert(MATRIX_DEFAULT_SIZE);
        onInserted();
      }}
    >
      ⊞
      {preview !== null && (
        <div className="matrix-picker">
          <div className="matrix-picker-label">
            {preview.rows} × {preview.cols} matrix
          </div>
          <div className="matrix-picker-grid" ref={gridRef}>
            {Array.from({ length: MATRIX_GRID_SIZE * MATRIX_GRID_SIZE }, (_, i) => {
              const row = Math.floor(i / MATRIX_GRID_SIZE) + 1;
              const col = (i % MATRIX_GRID_SIZE) + 1;
              const on = row <= preview.rows && col <= preview.cols;
              return (
                <div
                  key={i}
                  className={on ? 'matrix-picker-cell matrix-picker-cell-on' : 'matrix-picker-cell'}
                />
              );
            })}
          </div>
        </div>
      )}
    </button>
  );
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
  if (k.special === 'matrix') {
    return <MatrixKeyButton flex={flex} title={k.title} onInserted={onPressed} />;
  }

  const isShift = k.label === SHIFT_LABEL && k.strokes === undefined;
  // 라벨도 실제로 나갈 게 대문자일 때만 그려 보인다 — 로마자는 항상 그렇고
  // (`.toUpperCase()` 는 그리스 문자도 정확히 대문자로 바꾼다, θ→Θ), 그리스는
  // `upperStrokes` 가 있는 열 글자만 그렇다(나머지는 눌러도 소문자 그대로 나가므로
  // 라벨도 안 바뀌어야 앞뒤가 맞는다).
  const showUpper = upper && (/^[a-z]$/.test(k.label) || k.upperStrokes !== undefined);
  const label = showUpper ? k.label.toUpperCase() : k.label;
  const className = [
    'palette-key',
    k.tint === true ? 'palette-key-tint' : null,
    k.accent === true ? 'palette-key-accent' : null,
    isShift && upper ? 'palette-key-active' : null,
  ]
    .filter((c) => c !== null)
    .join(' ');

  return (
    <button
      type="button"
      className={className}
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
  /**
   * 포커스된 셀이 하나도 없으면 접는다 — 물리 키보드가 안 뜨는 것과 같은 규칙이다.
   * 판정은 `editor/activeField.ts` 의 게이트가 통째로 하고 여기는 구독만 한다
   * (모바일 분기가 아니다 — 데스크톱에서는 CSS가 어차피 늘 숨긴다).
   *
   * 접는 일 자체는 CSS 몫이다: `hidden` 만 걸고 `display` 와 `.app` 바닥 여백은
   * `styles/keyPalette.css` 가 정한다(대원칙 3 — 그리기만 하고 숨김은 CSS에).
   */
  const focused = useSyncExternalStore(subscribeFieldFocus, isFieldFocused, () => false);

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
    <div className="key-palette" role="group" aria-label="Symbol keyboard" hidden={!focused}>
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
        {layer.kind === 'split' && (
          <div className="key-palette-split">
            <div className="key-palette-block">{layer.left.map(renderRow)}</div>
            <div className="key-palette-block">{layer.right.map(renderRow)}</div>
            {/* 좌우 블록 밖, 오른쪽 끝의 좁은 열(1번 탭의 ⌫ 자리, 시안 B4). */}
            {layer.aside !== undefined && (
              <div className="key-palette-aside">{layer.aside.map(renderRow)}</div>
            )}
          </div>
        )}
        {layer.kind === 'rows' && (
          <div className="key-palette-block">{layer.rows.map(renderRow)}</div>
        )}
        {layer.kind === 'sections' && (
          <div className="key-palette-sections">
            {layer.sections.map((section) => (
              <div className="key-palette-section" key={section.heading}>
                <div className="key-palette-section-heading">{section.heading}</div>
                <div className="key-palette-section-grid">
                  {section.keys.map((k, j) => (
                    <PaletteButton
                      key={j}
                      k={k}
                      upper={upper}
                      onToggleShift={() => setUpper((v) => !v)}
                      onPressed={() => setUpper(false)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="key-palette-nav">{renderRow(NAV_ROW, 0)}</div>
    </div>
  );
}
