import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from 'react';
import { MathfieldElement, type InlineShortcutDefinitions } from 'mathlive';
import {
  ensureGhostLeftSupport,
  finalizeGhostFences,
  flushShortcutBuffer,
  modelOf,
  patchMathliveDisposedBlur,
} from '../editor/internals';
import { notifyFieldBlur, notifyFieldFocus, notifyFieldRemoved } from '../editor/activeField';
import { PLACEHOLDER_RULES, contentCount, findViolations, repairLatex } from '../editor/wellformed';
import { dispatchKeyOp } from '../editor/keyOps';
import { attachTouchGesture } from '../editor/touchGesture';
import { MOBILE_QUERY, isMobileViewport } from '../mobile';
import { ATOM_BOX_DEBUG } from '../features';
import { SelectionHandles } from './SelectionHandles';
import { configureKeybindings } from '../editor/keybindings';
import {
  expandSelectionSemantic,
  extendSelectionSibling,
  normalizeSelection,
  selectionIsSiblingRun,
} from '../editor/selection';

/** 변환 단축키 (임시 키바인딩 — 추후 사용자 지정 예정). Ctrl/Cmd+Shift+키. */
export const TRANSFORM_SHORTCUTS: Record<string, 'expand' | 'simplify' | 'factor'> = {
  e: 'expand',
  s: 'simplify',
  f: 'factor',
};

/**
 * 끌 기본 인라인 숏컷 트리거. mathlive "Shortcuts & features" 도움말에 나오는 텍스트
 * 자동변환 전체(사용자 지정, 실측 확인) — `node_modules/mathlive/mathlive.mjs`의
 * `INLINE_SHORTCUTS`에 실재하는 키만 담았다. 여기 없는 문자열(예: "PP", "ox", "(x)")은
 * 애초에 그 딕셔너리에 없는 항목이라 뺄 것도 없다. 키 조합 단축키(`/`→분수,
 * `Ctrl+2`→루트 등, `mf.keybindings`)는 별개 시스템이라 여기 대상이 아니다.
 */
const DISABLED_INLINE_SHORTCUTS = new Set<string>([
  // 논리/집합
  '&&',
  'and',
  'or',
  'not',
  '¬', // ¬ ('neg')
  'in',
  'xin',
  '!in',
  '^^',
  '^^^',
  'vv',
  'vvv',
  'nn',
  'nnn',
  'uu',
  'uuu',
  'setminus',
  'sub',
  'sup',
  'sube',
  'supe',
  'forall',
  'AA',
  'exists',
  'EE',
  '!exists',
  '!EE',
  'diamond',
  'square',
  'TT',
  'aleph',
  // 문자류
  'infty',
  'ii',
  'jj',
  'oo',
  'ee',
  'NN',
  'ZZ',
  'QQ',
  'RR',
  'CC',
  // 연산자
  '**',
  '***',
  '(/)',
  '(*)',
  '(-)',
  '@',
  '|><',
  '><|',
  '|><|',
  '-:',
  'divide',
  '|__',
  '__|',
  '|~',
  '~|',
  '(:',
  ':)',
  // 단위
  'mm',
  'cm',
  'km',
  'kg',
  // 화살표/논리 기호
  'iff',
  '>->',
  '->>',
  '>->>',
  '->',
  '->...',
  '|->',
  '-->',
  '<--',
  '=>',
  '==>',
  '<=>',
  '<->',
  'uarr',
  'darr',
  'rarr',
  'rArr',
  'larr',
  'lArr',
  'harr',
  'hArr',
  '|--',
  '|==',
  // 생략 부호
  '...',
  '+...',
  '-...',
  ':.',
  // 기타
  'dx',
  'dy',
  'dt',
]);

/**
 * 추가할 커스텀 인라인 숏컷. 형식은 mathlive `InlineShortcutDefinition`과 동일
 * (문자열 또는 `{ after, value }`) — `node_modules/mathlive/types/options.d.ts`의
 * `after` 컨텍스트 값 표 참고.
 */
const CUSTOM_INLINE_SHORTCUTS: InlineShortcutDefinitions = {
  tr: '\\operatorname{\\mathrm{tr}}',
  tt: '\\dagger',
  '**': '*',
  // 켤레. `Alt+-` 키바인딩(`editor/keybindings.ts`)과 같은 표기를 타이핑으로도 낼 수
  // 있게 한다 — 저쪽은 선택을 감싸야 해서 `#@`, 이쪽은 감쌀 선택이 없으니 `#?`(빈 칸)다.
  conj: '\\overline{#?}',
  // 아래 셋은 `KeyPalette.tsx` 의 ƒ(x)·αβγ 레이어 전용 — MathLive 기본 인라인 숏컷
  // 사전에 없는 트리거라(실측, `mathlive.mjs` 의 `INLINE_SHORTCUTS`) 여기서 만든다.
  star: '\\star',
  // 미분 표기. `#?` 는 분모의 변수 자리(기본 `d` 뒤에 이어 쓴다, 예: `ddx` → `\frac{d}{dx}`).
  ddx: '\\frac{d}{d#?}',
  // 끝시그마(ς). `sigma`(→ `\sigma`)는 기본 사전에 있지만 변형은 없다.
  varsigma: '\\varsigma',
  // 나눗셈 기호. 기본 사전의 `divide`/`-:` 는 의도적으로 꺼 뒀다(DISABLED_INLINE_SHORTCUTS
  // 아래) — 그 결정은 그대로 두고, 숫자 탭의 `÷` 키만을 위해 새 트리거를 만든다.
  // (숫자 탭의 다른 `÷`/`×` 자리는 각각 분수·`\cdot` 로 이미 자리를 잡고 있다 —
  // 여기 `div` 는 그와 구분되는 진짜 나눗셈 기호가 필요해진 자리에만 쓴다.)
  div: '\\div',
};

/**
 * mathlive 기본 인라인 숏컷 딕셔너리(`mf.inlineShortcuts`, ~150여 개)에서 일부를
 * 끄고 커스텀 숏컷을 얹는다. `mf.inlineShortcuts = ...`는 기존 기본값과 병합되지
 * 않고 완전히 대체하므로, 아무것도 설정하기 전에 getter로 기본값을 먼저 읽어야 한다.
 */
function configureInlineShortcuts(mf: MathfieldElement): void {
  const defaults = mf.inlineShortcuts;
  const merged: InlineShortcutDefinitions = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (!DISABLED_INLINE_SHORTCUTS.has(key)) merged[key] = value;
  }
  mf.inlineShortcuts = { ...merged, ...CUSTOM_INLINE_SHORTCUTS };
}

/**
 * 셰도우 DOM 안쪽에 얹는 우리 CSS.
 *
 * MathLive의 렌더 결과는 셰도우 루트 안이라 전역 스타일시트가 못 닿고,
 * 노출된 `::part()` 는 컨테이너 몇 개뿐이다. 대신 셰도우 루트가 `mode: 'open'`
 * 이라(`mathlive.mjs:40817` 실측) `adoptedStyleSheets` 로 직접 얹을 수 있다.
 * MathLive 자신도 같은 방식으로 자기 시트를 넣으므로 뒤에 붙이면 우리가 이긴다.
 *
 * 시트는 모듈 전역에 **한 장**만 만들어 모든 필드가 공유한다.
 */
/**
 * 모바일에서 "바깥을 탭했다" 로 볼 최대 이동(px). 이보다 많이 움직였으면 스크롤이라
 * 보고 선택을 안 푼다. `editor/touchGesture.ts` 의 판정 임계와 같은 값이다.
 */
const TAP_SLOP_PX = 8;

const SHADOW_CSS = `
/* \\overline 은 렌더 박스가 type:'ignore' 라 원자 간 자동 간격이 아예 안 붙는다
   (mathlive.mjs 의 overline render: new Box(stack, {classes:'overline', type:'ignore'})).
   그래서 앞뒤 글자에 딱 붙어 읽기 어렵다 — 숨 쉴 틈만 준다. */
.ML__latex .overline {
  margin-left: 0.08em;
  margin-right: 0.08em;
}

/* 줄 **안쪽** 여백. \\overline 의 vlist는 두 줄이다 — 내용 줄과 줄(overline-line) 줄
   (실측 구조: .overline > .ML__vlist-t > .ML__vlist-r > .ML__vlist > span×2).
   줄은 자기 칸의 width:100% 라 vlist 폭을 따라가므로, **내용 쪽에만** 좌우 패딩을
   주면 vlist가 그만큼 넓어지고 줄이 내용보다 길게 뻗는다 — 내용이 줄 끝에 닿지 않는다. */
.ML__latex .overline .ML__vlist > span:first-child > span:not(.ML__pstrut) {
  padding-left: 0.12em;
  padding-right: 0.12em;
}

/* ☰ 메뉴 버튼을 필드 높이 가운데로. MathLive 기본은 \`.ML__toggles\` 에
   \`align-self: flex-start\` 라 위에 붙는데, 행렬처럼 키가 큰 식에서는 버튼만
   맨 위에 동떨어져 보인다. \`.ML__toggles\` 는 노출된 part가 아니라(part는
   menu-toggle/virtual-keyboard-toggle 둘뿐) 전역 CSS로는 못 닿는다 — 그래서 여기. */
.ML__container > .ML__toggles {
  align-self: center;
}

/* 모바일에서만 세로 페이지 스크롤을 브라우저에 되돌려 준다.

   MathLive는 \`.ML__container\` 에 \`touch-action: none\` 을 건다("Prevent the
   browser from trying to interpret touch gestures in the field") — 그런데
   touch-action은 히트된 요소와 그 조상들의 **교집합**이라, 호스트에 걸어둔
   \`pan-y\`(\`styles/selectionHandles.css\`)가 이 한 줄에 통째로 무효화된다.
   그 결과 셀 위에서 시작한 손짓으로는 페이지가 아예 안 굴러간다(사용자 보고).
   셰도우 DOM 안이라 전역 CSS로는 못 닿아 여기서 덮는다.

   가로 손짓은 그대로 우리 것이다 — \`pan-y\` 는 세로만 브라우저에 넘긴다
   (\`editor/touchGesture.ts\` 의 패닝·홀드 선택이 가로를 계속 쓴다). 홀드
   선택이 성립한 뒤의 **세로** 드래그(분수의 분자/분모 넘나들기)는 브라우저가
   가져가면 안 되므로, 그때만 \`touchmove\` 로 막는다(같은 파일).

   임계값은 \`src/mobile.ts\` 의 \`MOBILE_QUERY\` 하나를 쓴다 — 셰도우 CSS라
   \`src/styles/\` 밖에 있어 \`styles/mediaQuery.test.ts\` 가 못 보는 자리다. */
@media ${MOBILE_QUERY} {
  .ML__container {
    touch-action: pan-y;
  }

  /* \\sqrt 안쪽 오른쪽 끝에 탭 여백을 준다. 근호 본문이 자기 너비에 딱 맞게
     렌더되어(위 vinculum이 마지막 글자 바로 뒤에서 끝난다), "본문 맨 끝, 근호
     안쪽"에 캐럿을 두려는 탭이 손가락으로는 짚을 자리가 없었다(사용자 보고,
     \\sqrt{1+x^2} 예시). \\overline 과 같은 구조적 이유로 같은 트릭을 쓴다:
     이 줄(sqrt-line, vinculum)은 width: 100% 라 자기 칸(vlist)의 폭을
     따라가므로, **본문 쪽에만** 오른쪽 패딩을 주면 vlist가 그만큼 넓어지고
     줄이 그 여백까지 뻗는다 — 실측(76px→81px폭, +0.35em 만큼).

     .overline 과 달리 sqrt의 바깥 원자에는 걸 만한 클래스가 없다
     (mathlive.mjs 의 ML__sqrt CSS 클래스는 죽은 규칙 — 실제로는 안 붙는다).
     대신 .ML__sqrt-sign(근호 기호)의 다음 형제가 언제나 본문의 .ML__vlist-t2
     라는 구조(실측: SqrtAtom.render, [delimBox, bodyBox])로 짚는다 —
     \\sqrt[n]{} 처럼 앞에 지수 상자가 붙어도 그 둘의 인접 관계는 안 바뀐다.

     왼쪽 패딩은 안 준다 — 근호 기호와 본문 사이는 이미 붙어 있는 게 맞는
     렌더(수학 표기 관례)라 왼쪽을 벌리면 오히려 어색해 보인다. */
  .ML__latex .ML__sqrt-sign + .ML__vlist-t2 > .ML__vlist-r > .ML__vlist > span:first-child > span:not(.ML__pstrut) {
    padding-right: 0.35em;
  }
}
`;

/**
 * 디버그 전용 — 원자 상자에 1px 테두리 (`features.ts` 의 `ATOM_BOX_DEBUG`, `?atombox`).
 *
 * `outline` 이라 레이아웃을 안 건드린다 — `border` 를 쓰면 글자가 밀려서 재려던
 * 그 좌표가 달라진다. `outline-offset: -1px` 로 안쪽에 그려 이웃 상자끼리 선이
 * 겹쳐 두꺼워지는 것도 막는다.
 *
 * 잎(글리프)과 컨테이너를 색으로 가른다 — `:has()` 로 자식 원자를 품었는지 본다.
 * **파란 상자 사이의 맨 자리가 곧 히트테스트가 헛짚는 구간**이다.
 */
const ATOM_BOX_CSS = `
.ML__latex [data-atom-id] {
  outline: 1px solid rgba(59, 110, 245, 0.55);
  outline-offset: -1px;
}

.ML__latex [data-atom-id]:has([data-atom-id]) {
  outline-color: rgba(200, 60, 60, 0.35);
}
`;

/**
 * 이 노드가 키 팔레트(`KeyPalette.tsx`) 안인가. 팔레트는 셀 그룹 밖에 고정으로 떠
 * 있지만 **편집 표면의 일부**라, "필드 바깥을 눌렀다" 판정에서 빼야 한다.
 * `pointerdown` 의 target은 보통 Element지만 텍스트 노드로 올 여지를 남겨 방어한다.
 */
function isInKeyPalette(node: Node | null): boolean {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  return el?.closest('.key-palette') != null;
}

let shadowSheet: CSSStyleSheet | null = null;

function applyShadowStyles(mf: MathfieldElement): void {
  try {
    const root = mf.shadowRoot;
    if (root === null || !('adoptedStyleSheets' in root)) return;
    if (shadowSheet === null) {
      shadowSheet = new CSSStyleSheet();
      shadowSheet.replaceSync(ATOM_BOX_DEBUG ? SHADOW_CSS + ATOM_BOX_CSS : SHADOW_CSS);
    }
    if (root.adoptedStyleSheets.includes(shadowSheet)) return;
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, shadowSheet];
  } catch {
    // 셰도우 스타일은 미관 문제라 실패해도 그냥 넘어간다 (내부 API 접근 규율).
  }
}

/**
 * ☰ 메뉴에서 쓰지 않는 항목을 걷어낸다.
 * - mode(수식/text/LaTeX)·variant(글꼴)·color·background-color: 안 씀
 * - 행렬 구분 기호 서브메뉴(environment-*): 선택 위 플로팅 툴바로 이전
 * 항목 id는 실측 덤프 기준 (mathlive 0.110). 남는 연속 구분선도 정리한다.
 */
function pruneMenu(mf: MathfieldElement): void {
  try {
    // 행/열 추가·삭제는 뺀다 — 행렬 크기는 삽입한 뒤 바뀌지 않는다(정책).
    // 크기를 잘못 골랐으면 행렬을 지우고 다시 삽입한다. `insert-matrix` 는 남긴다.
    // `insert`(구조/미적분 삽입 서브메뉴)도 뺀다 — 거기 항목들이 넣는 표기 상당수가
    // 이 앱의 파서에 없다(`\bigm|_{x=...}` 값매김 막대 등, 실측). 골라도 못 읽는 항목을
    // 메뉴에 둘 이유가 없다. id는 정확 일치라(아래 필터) `insert-matrix` 는 안 걸린다.
    const REMOVE = new Set([
      'mode',
      'variant',
      'color',
      'background-color',
      'add-row-above',
      'add-row-below',
      'add-column-before',
      'add-column-after',
      'delete-row',
      'delete-column',
      'insert',
    ]);
    type Item = { id?: string; type?: string; submenu?: Item[] };
    const items = (mf.menuItems as Item[]).filter((item) => {
      if (item.id !== undefined && REMOVE.has(item.id)) return false;
      // 구분 기호 서브메뉴는 부모에 id가 없다 — 자식 id로 식별한다.
      if (item.submenu?.some((s) => s.id?.startsWith('environment-'))) return false;
      return true;
    });
    // 제거로 생긴 연속 구분선(divider)을 하나로.
    const cleaned: Item[] = [];
    for (const item of items) {
      const isDivider = item.id === undefined && item.submenu === undefined;
      const prev = cleaned[cleaned.length - 1];
      const prevDivider = prev !== undefined && prev.id === undefined && prev.submenu === undefined;
      if (isDivider && (cleaned.length === 0 || prevDivider)) continue;
      cleaned.push(item);
    }
    mf.menuItems = cleaned as typeof mf.menuItems;
  } catch {
    // 메뉴 구조가 바뀌면(버전 업) 기본 메뉴 그대로 둔다.
  }
}

/** 부모가 명시적으로 조작할 때 쓰는 핸들 (선택 변환 등). */
export type MathFieldHandle = {
  /**
   * 현재 선택을 주어진 LaTeX으로 치환하고 필드의 새 전체 값과 캐럿, 그리고
   * 치환 **직전**의 선택 범위를 돌려준다 (undo가 선택까지 복구할 수 있게).
   * 선택이 없으면 아무것도 하지 않고 null. 치환 중에는 onEdit 보고를 억제하므로
   * 커밋은 호출자가 직접 dispatch해야 한다 (structural 편집으로 즉시 평가되게).
   */
  replaceSelection: (
    latex: string,
  ) => { value: string; caret: number; selectionBefore: readonly [number, number] } | null;
};

type Props = {
  value: string;
  readOnly?: boolean;
  ref?: Ref<MathFieldHandle>;
  /**
   * 사용자 입력 1회마다. latex = 전체 값, caret = 입력 직후 캐럿 오프셋.
   * 문서는 키 입력마다 갱신되고 실행취소도 이 단위로 쌓인다.
   * (평가는 상위 계층이 디바운스한다 — 여기서는 지연 없음)
   */
  onEdit?: (latex: string, caret: number) => void;
  /** Enter를 눌렀을 때. 확정하고 다음으로 넘어가는 신호다. */
  onEnter?: (latex: string) => void;
  /**
   * 선택 영역이 바뀔 때. 선택이 없으면(collapsed) null, 있으면 선택된 LaTeX.
   * 선택 변환 버튼의 표시 여부 판단에 쓴다.
   */
  onSelectionChange?: (selectedLatex: string | null) => void;
  /**
   * 캐럿이 경계에서 더 갈 곳이 없을 때 (MathLive `move-out`).
   * 셀 스택이 인접 셀로 포커스를 넘기는 데 쓴다.
   */
  onMoveOut?: (direction: 'forward' | 'backward' | 'upward' | 'downward') => void;
  /** 변환 단축키 (Ctrl+Shift+E/S/F). 선택이 있을 때 Cell의 applyTransform으로. */
  onTransformShortcut?: (op: 'expand' | 'simplify' | 'factor') => void;
  /** 빈 필드에서 backspace — 셀 삭제/위 셀 이동은 CellStack이 조율. */
  onDeleteEmpty?: () => void;
  /** Ctrl+Enter(아래)/Ctrl+Shift+Enter(위) — 그룹 밖에 새 빈 셀. */
  onInsertCell?: (position: 'above' | 'below') => void;
  /**
   * Alt+↑/↓ — 이 셀이 속한 그룹 전체를 위/아래로.
   *
   * `caret` 은 **누르는 순간의 캐럿 오프셋**이다. 재정렬은 React가 DOM 서브트리를
   * 실제로 옮기는 일이라 그 과정에서 필드가 blur되고, 리듀서가 포커스를 다시 지시할
   * 때 캐럿을 어디에 놓을지 알아야 한다 — 문서(`tab.lastCursor`)에는 마우스 클릭·
   * 화살표로 옮긴 캐럿이 안 남으므로 여기서 실어 보내는 수밖에 없다.
   */
  onMoveGroup?: (delta: -1 | 1, caret: number) => void;
  /** Shift+Alt+↑/↓ — 복제해 그룹 밖에 놓는다(방향은 명세대로 반대). `caret` 은 위와 같다. */
  onDuplicate?: (position: 'above' | 'below', caret: number) => void;
  /**
   * 값이 바뀔 때마다가 아니라, 이 토큰이 바뀔 때만 포커스를 준다.
   * 리렌더마다 focus()가 불려 커서가 튀는 것을 막기 위한 장치.
   */
  focusToken?: number | null;
  /**
   * focusToken 발화 시 캐럿을 놓을 오프셋. 실행취소가 "그 편집이 일어났던
   * 자리"로 캐럿을 되돌릴 때 쓴다. 없으면 MathLive 기본 동작.
   */
  focusOffset?: number | null;
  /**
   * focusToken 발화 시 복구할 선택 범위. 있으면 focusOffset보다 우선한다 —
   * 선택 변환의 실행취소가 "조작 직전의 선택"을 되살릴 때 쓴다.
   */
  focusSelection?: readonly [number, number] | null;
  /**
   * 이 값이 바뀌면 편집 중(focused)이어도 `value`를 강제로 반영한다.
   * 실행취소/다시실행이 포커스된 필드의 내용을 되돌리기 위한 유일한 경로.
   */
  syncKey?: number;
};

/**
 * `<math-field>` 웹 컴포넌트 React 래퍼.
 *
 * JSX가 아니라 `new MathfieldElement()` 로 직접 만들어 붙인다. 그래야
 *   1. custom element JSX 타입 선언(React 버전마다 다름)이 필요 없고
 *   2. React가 이 엘리먼트를 리렌더로 건드릴 수 없어서
 *      "uncontrolled로 다룬다"는 규칙이 구조적으로 보장된다.
 *
 * 데이터 흐름: 키 입력마다 onEdit으로 문서가 즉시 갱신된다(실행취소 단위).
 * 반대 방향(state -> mathfield)은 사용자가 방금 친 값과 같아 no-op이고,
 * 실행취소/로드 같은 외부 변경만 syncKey/value 이펙트로 흘러든다.
 */
export function MathField({
  value,
  readOnly = false,
  ref,
  onEdit,
  onEnter,
  onSelectionChange,
  onMoveOut,
  onTransformShortcut,
  onDeleteEmpty,
  onInsertCell,
  onMoveGroup,
  onDuplicate,
  focusToken,
  focusOffset,
  focusSelection,
  syncKey,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mfRef = useRef<MathfieldElement | null>(null);

  // 핸들러는 ref로 들고 있어야 prop이 바뀌어도 엘리먼트를 다시 만들지 않는다.
  const handlers = useRef({
    onEdit,
    onEnter,
    onSelectionChange,
    onMoveOut,
    onTransformShortcut,
    onDeleteEmpty,
    onInsertCell,
    onMoveGroup,
    onDuplicate,
  });
  handlers.current = {
    onEdit,
    onEnter,
    onSelectionChange,
    onMoveOut,
    onTransformShortcut,
    onDeleteEmpty,
    onInsertCell,
    onMoveGroup,
    onDuplicate,
  };
  const initialValue = useRef(value);
  /**
   * 마운트된 mathfield. 선택 핸들(`SelectionHandles`)이 렌더 트리에서 이걸 봐야
   * 해서 ref가 아니라 state다 — 마운트 직후 한 번만 바뀐다.
   */
  const [mounted, setMounted] = useState<MathfieldElement | null>(null);

  // 편집 중인지 추적한다. 편집 중에는 외부 value 동기화가 입력을 덮지 않도록 막는다.
  const isEditing = useRef(false);
  /** replaceSelection 중 input 이벤트 보고를 억제한다 (커밋은 호출자가 한다). */
  const suppressReport = useRef(false);
  /** 현재 선택을 부모에 보고하는 함수. 마운트 이펙트가 채우고 핸들이 재사용한다. */
  const reportRef = useRef<(() => void) | undefined>(undefined);

  // useLayoutEffect여야 한다: layout cleanup은 React가 DOM 노드를 떼기 **전에**
  // 동기 실행된다. 포커스된 mathfield가 blur 없이 DOM에서 떨어지면 MathLive의
  // 전역 포커스 추적(_globallyFocusedMathfield)에 dispose된 필드가 남고, 다음
  // 필드가 포커스될 때 그 낡은 참조의 onBlur를 불러 크래시한다 (mathlivePatch.ts).
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const mf = new MathfieldElement();
    mf.value = initialValue.current;
    // MathLive 자체 가상 키보드는 항상 끈다 — 자체 팔레트(KeyPalette.tsx)가 그걸
    // 대체한다. 자체 VK는 우리 keyOps.ts·앱 단축키·인라인 숏컷 판정 경로를 우회한다.
    mf.mathVirtualKeyboardPolicy = 'manual';
    // `\` 를 치면 뜨던 LaTeX 명령어 검색 팝오버를 끈다. 이 앱의 입력 수단은 인라인
    // 숏컷(`sqrt`, `sum`…)과 키바인딩이고, 그 목록은 도움말 패널이 맡는다 — 타이핑
    // 중에 자동완성 창이 끼어들면 캐럿·선택 흐름만 끊긴다.
    mf.popoverPolicy = 'off';
    // 클립보드로 복사할 때 기본값인 `$$...$$` 감싸기를 뺀다 — LaTeX 문자열 자체가
    // 정본이라(CLAUDE.md 변환 경계 ①) 복사 결과도 그와 같아야 한다.
    mf.onExport = (_from, latex) => latex;

    mf.addEventListener('input', () => {
      if (suppressReport.current) return;
      // 구조 불변식의 단일 게이트 (rules.ts). 파손된 형태가 문서·화면에 한 키
      // 입력 이상 살아남지 못하게, 교정본을 캐럿 보존으로 되써넣고 문서에도
      // 교정본만 보고한다 — 그래서 undo는 언제나 "직전 정상 상태"로 간다.
      const fix = repairLatex(mf.value);
      if (fix.changed) {
        // 캐럿은 "같은 내용 위치"로 되돌린다. MathLive 오프셋은 원자 인덱스라
        // 문자열 splice와 직접 대응하지 않으므로, 캐럿 앞의 내용 토큰 수를
        // 기준으로 다시 찾는다 (구조 토큰이 사라져도 안정적).
        // 주의: 이 복원은 **근사**다. 구조 경계에서는 여러 오프셋이 같은 내용 카운트를
        // 가져(`x\left(a\right)` 의 오프셋 1은 괄호 밖, 2는 괄호 안 — 둘 다 앞이 `x`)
        // 문자열만으로는 구분할 수 없다. 그래서 사용자의 캐럿 의도가 분명한 편집
        // (괄호 쌍 삭제 등)은 여기까지 오지 않고 `keyOps.ts` 에서 캐럿까지 직접 정한다.
        // 여기 남는 건 붙여넣기·깨진 저장본 교정처럼 되돌릴 의도가 없는 경우뿐이다.
        const before = contentCount(mf.getValue({ ranges: [[0, mf.position]] }, 'latex'));
        suppressReport.current = true;
        try {
          mf.setValue(fix.latex, { silenceNotifications: true });
        } finally {
          suppressReport.current = false;
        }
        let target = mf.lastOffset;
        for (let q = 0; q <= mf.lastOffset; q += 1) {
          if (contentCount(mf.getValue({ ranges: [[0, q]] }, 'latex')) >= before) {
            target = q;
            break;
          }
        }
        // placeholder를 새로 끼워 넣은 규칙(`PLACEHOLDER_RULES`: 행렬 빈 행, 빈 첨자,
        // 빈 \overline)이 걸렸다면 위 근사는 못 미친다 — `\placeholder` 도 command
        // 토큰이라 contentCount에 잡히지만, 그 앞(비우기 전 마지막 내용) 지점에서 이미
        // `before` 와 일치해버려 placeholder까지 가지 않고 멈춘다. 그 결과 캐럿이
        // "방금 비운 자리" 가 아니라 그 **앞**에 남아, 이어서 치는 값이 엉뚱한 데
        // 끼어든다(실측). 이 규칙들만은 캐럿 의도가 분명하다(방금 비운 자리에
        // 이어 쓰려는 것) — 새로 생긴 placeholder 바로 앞에 캐럿을 둔다. MathLive는
        // placeholder 앞 캐럿에서 타이핑하면 그 자리를 그대로 대체한다(실측).
        if (fix.applied.some((id) => PLACEHOLDER_RULES.has(id))) {
          const model = modelOf(mf);
          if (model !== null) {
            // 문서에 다른 placeholder(예: 아직 안 채운 분수)가 더 있을 수 있으니
            // "처음 찾은 것"이 아니라 위 근사치(target)와 가장 가까운 것을 고른다.
            let bestQ: number | null = null;
            for (let q = 0; q <= model.lastOffset; q += 1) {
              if (model.at(q)?.type !== 'placeholder') continue;
              if (bestQ === null || Math.abs(q - target) < Math.abs(bestQ - target)) bestQ = q;
            }
            if (bestQ !== null) target = Math.max(0, bestQ - 1);
          }
        }
        mf.position = target;
        flushShortcutBuffer(mf);
      }
      if (import.meta.env.DEV) {
        const left = findViolations(mf.value);
        if (left.length > 0) {
          console.warn('[wellformed] 교정 후에도 위반', left.map((v) => v.ruleId), mf.value);
        }
      }
      handlers.current.onEdit?.(mf.value, mf.position);
    });

    // 선택 불변식의 단일 게이트. 모든 선택 경로(드래그·shift+화살표·Ctrl+D·
    // 더블클릭·Ctrl+A·실행취소 복구)가 selection-change를 지나가므로, 여기서
    // 한 번 교정하면 "선택은 항상 한 레벨의 연속 형제 열"이 보장된다.
    // (핸들러 안에서 selection을 재설정해도 재귀 발화하지 않는다 — 실측)
    const reportSelection = () => {
      normalizeSelection(mf);
      const notify = handlers.current.onSelectionChange;
      if (notify === undefined) return;
      if (mf.selectionIsCollapsed) {
        notify(null);
        return;
      }
      // 정규화 뒤에도 형제 열이 아니면 불변식이 깨진 것 — 조작 대상에서 뺀다.
      if (!selectionIsSiblingRun(mf)) {
        if (import.meta.env.DEV) {
          console.warn('[selection] 정규화 후에도 형제 열이 아님', mf.selection.ranges);
        }
        notify(null);
        return;
      }
      notify(mf.getValue(mf.selection, 'latex'));
    };
    reportRef.current = reportSelection;

    mf.addEventListener('focusin', () => {
      isEditing.current = true;
      // 포커스의 단일 게이트(`editor/activeField.ts`). 팔레트가 키를 흘릴 대상과
      // "지금 포커스된 필드가 있나"(가상 키보드 표시)가 둘 다 여기서 나온다.
      notifyFieldFocus(mf);
      // selection-change는 "변화"에만 발화한다. 이미 선택이 있는 필드에 포커스가
      // 들어오면 이벤트 없이 선택만 존재해 버튼 상태가 어긋난다 — 즉시 보고해 동기화.
      reportSelection();
    });
    /** 이 필드가 속한 셀 그룹. 그룹 밖에 단독으로 띄운 경우(테스트)엔 자기 자신. */
    const scopeOf = (): Element => host.closest('.cell-group') ?? host;

    /**
     * 선택을 **실제로 푼다** — 버튼만 숨기는 게 아니라 캐럿·선택 범위를 초기화한다.
     * 모델에 선택이 살아 있으면 다시 포커스했을 때 되살아나, 사용자가 보기엔
     * "해제했는데 안 풀린" 상태가 된다.
     */
    const clearSelection = () => {
      if (!mf.selectionIsCollapsed) {
        mf.selection = { ranges: [[0, 0]], direction: 'forward' };
      }
      // 선택 변경은 `selection-change` → `reportSelection` 으로도 보고되지만,
      // 이미 접혀 있던 경우엔 이벤트가 안 나므로 여기서도 한 번 알린다.
      handlers.current.onSelectionChange?.(null);
    };

    mf.addEventListener('focusout', (ev) => {
      isEditing.current = false;
      // 포커스 게이트에 알린다 — 확정은 저쪽이 한 태스크 미룬다(셀 간 이동은
      // focusout → focusin 이 잇따르므로 즉시 놓으면 팔레트가 깜빡인다).
      notifyFieldBlur(mf);
      // ghost 괄호는 "편집 중인 셀의 순간 상태"다 — 셀을 떠나면 확정한다.
      // LaTeX 표현은 동일하므로 문서·계산에는 영향이 없다 (반투명 표시만 사라진다).
      finalizeGhostFences(mf);
      // 창 포커스 전환(alt-tab, relatedTarget이 null)만으로는 안 푼다 — 돌아왔을 때
      // 하던 선택이 남아 있어야 한다. 하지만 포커스가 **이 셀 그룹 밖의 다른 곳**으로
      // 확실히 옮겨갔으면(relatedTarget이 있고 그룹 DOM 밖) 그건 사용자가 실제로
      // 자리를 뜬 것이니 해제한다 — TransformButtons/SelectionToolbar는
      // mousedown에서 preventDefault해 포커스를 안 뺏으므로 그 클릭으로는 여기가
      // 안 탄다.
      const related = (ev as FocusEvent).relatedTarget as Node | null;
      if (related !== null && !scopeOf().contains(related)) clearSelection();
    });
    mf.addEventListener('selection-change', reportSelection);

    // 선택 해제의 두 번째 경로 — 셀 그룹 **밖**을 누르거나 거기서 드래그를 시작하면
    // 해제한다. `focusout` 만으로는 못 잡는다: 그룹 밖 빈 여백(스택 배경 등)을 누르면
    // 포커스가 어디로도 안 옮겨가 focusout 자체가 안 난다. capture 단계라 대상 쪽이
    // 이벤트를 삼켜도 우리가 먼저 본다. 선택이 없으면 즉시 빠져나오므로, 필드마다
    // 하나씩 달려 있어도 부담이 없다.
    /** 모바일에서 "바깥 탭인지 스크롤인지" 판정을 기다리는 중인 구독. */
    let outsideTap: AbortController | null = null;
    const onOutsidePointerDown = (ev: PointerEvent) => {
      if (mf.selectionIsCollapsed) return;
      const target = ev.target as Node | null;
      if (target !== null && scopeOf().contains(target)) return;
      // 키 팔레트는 "바깥" 이 아니다 — 키보드이지 딴 데가 아니다(`KeyPalette.tsx`).
      // 셀 그룹 밖에 고정으로 떠 있어 `scopeOf()` 에 안 잡히므로 명시적으로 뺀다.
      // 안 빼면 **placeholder 위에서 화살표가 제자리를 맴돈다**: 캐럿이 placeholder에
      // 서면 MathLive가 그걸 선택 상태로 만드는데(collapsed=false), 그 상태에서 팔레트를
      // 누를 때마다 여기가 선택을 지워 캐럿이 0으로 돌아가기 때문이다. 물리 키보드는
      // pointerdown이 아예 없어서 안 겪는 차이다
      // (실측·회귀 핀: `editor/feedKeyParity.browser.test.tsx`).
      if (isInKeyPalette(target)) return;
      // 데스크톱은 누른 즉시 해제한다 — 마우스로 바깥을 누르는 건 늘 "여기로 옮김"이다.
      if (!isMobileViewport()) {
        clearSelection();
        return;
      }
      // 모바일에서 바깥을 짚는 손짓의 대부분은 **페이지 스크롤**이다. 누른 즉시
      // 풀면 선택을 잡아둔 채 아래로 훑어보는 것 자체가 불가능해진다(사용자 보고).
      // 손을 뗄 때까지 기다렸다가, 거의 안 움직였으면(=탭이면) 그때 푼다.
      const x0 = ev.clientX;
      const y0 = ev.clientY;
      outsideTap?.abort();
      const controller = new AbortController();
      outsideTap = controller;
      const finish = (up: PointerEvent): void => {
        controller.abort();
        outsideTap = null;
        if (Math.abs(up.clientX - x0) < TAP_SLOP_PX && Math.abs(up.clientY - y0) < TAP_SLOP_PX) {
          clearSelection();
        }
      };
      document.addEventListener('pointerup', finish, {
        capture: true,
        signal: controller.signal,
      });
      document.addEventListener(
        'pointercancel',
        () => {
          controller.abort();
          outsideTap = null;
        },
        { capture: true, signal: controller.signal },
      );
    };
    document.addEventListener('pointerdown', onOutsidePointerDown, { capture: true });

    // 캐럿이 경계를 넘으려 할 때 — 셀 간 이동의 신호.
    mf.addEventListener('move-out', (ev) => {
      const direction = (ev as CustomEvent<{ direction: string }>).detail?.direction;
      if (
        direction === 'forward' ||
        direction === 'backward' ||
        direction === 'upward' ||
        direction === 'downward'
      ) {
        handlers.current.onMoveOut?.(direction);
      }
    });
    mf.addEventListener('keydown', (ev) => {
      // MathLive의 'change'는 blur 시에도 발사되므로 Enter만 직접 잡는다.
      if (ev.key !== 'Enter') return;
      // 항상 막는다 — 수정자 조합별 MathLive 기본 동작(행렬 행 삽입 등)은
      // `editor/keybindings.ts` 의 BLOCKED_KEYBINDINGS가 무력화해 두지만, 여기서도
      // 막아 두면 바인딩이 없는 새 조합이 브라우저 기본(개행 등)으로 새지 않는다.
      ev.preventDefault();
      if (ev.ctrlKey || ev.metaKey) {
        // Ctrl(+Shift)+Enter — 그룹 밖에 새 빈 셀. Shift면 위, 아니면 아래.
        handlers.current.onInsertCell?.(ev.shiftKey ? 'above' : 'below');
        return;
      }
      if (ev.altKey || ev.shiftKey) return; // 정의되지 않은 조합 — 아무 것도 안 한다
      handlers.current.onEnter?.(mf.value);
    });

    // 선택 조작 단축키. capture 단계여야 MathLive 기본 처리보다 먼저 가로챈다.
    mf.addEventListener(
      'keydown',
      (ev) => {
        // Escape 비활성화. MathLive 기본 ESC(선택 확장 → 원본 LaTeX 모드 노출)가
        // 혼란스러워 통째로 막는다. 추후 단축키로 재지정 예정. readOnly 체크보다
        // 앞에 둬서 입력·결과 필드 모두에서 중화한다.
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          return;
        }
        if (mf.readOnly) return;
        // Ctrl/Cmd+Shift+E/S/F: 선택 변환 단축키 (임시 키바인딩).
        if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && !ev.altKey) {
          const op = TRANSFORM_SHORTCUTS[ev.key.toLowerCase()];
          if (op !== undefined) {
            ev.preventDefault();
            ev.stopImmediatePropagation();
            handlers.current.onTransformShortcut?.(op);
            return;
          }
        }
        // 빈 필드에서 backspace: 셀 삭제 + 위 셀 이동 신호.
        if (ev.key === 'Backspace' && mf.value.trim() === '' && mf.selectionIsCollapsed) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          handlers.current.onDeleteEmpty?.();
          return;
        }
        // Alt+↑/↓: 그룹 전체를 위/아래로. Shift+Alt+↑/↓: 이 셀을 복제해 그룹 밖에
        // 놓는다 — 방향은 명세대로 반대다(↑ 누르면 아래에, ↓ 누르면 위에 놓인다).
        if (ev.altKey && !ev.ctrlKey && !ev.metaKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          if (ev.shiftKey) {
            handlers.current.onDuplicate?.(ev.key === 'ArrowUp' ? 'below' : 'above', mf.position);
          } else {
            handlers.current.onMoveGroup?.(ev.key === 'ArrowUp' ? -1 : 1, mf.position);
          }
          return;
        }
        // Ctrl/Cmd+D: 의미 단위 선택 확장 (브라우저 북마크를 가로챈다).
        if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'd') {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          try {
            expandSelectionSemantic(mf);
          } catch {
            // 내부 API 실패 — 아무것도 안 한다 (기본 동작도 없음).
          }
          return;
        }
        // shift+←/→: 같은 레벨(형제) 단위 선택 확장.
        if (
          ev.shiftKey &&
          !ev.ctrlKey &&
          !ev.metaKey &&
          !ev.altKey &&
          (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')
        ) {
          try {
            if (extendSelectionSibling(mf, ev.key === 'ArrowLeft' ? 'left' : 'right')) {
              ev.preventDefault();
              ev.stopImmediatePropagation();
            }
          } catch {
            // 내부 API 실패 — MathLive 기본 확장으로 폴백.
          }
        }
      },
      { capture: true },
    );

    // 구조 보존 편집 연산 (keyOps.ts 레지스트리). 괄호 쌍 생성/제거, 밑 없는
    // 첨자 차단, 첨자 내용 강등 등 — "파손을 애초에 만들지 않는" 층이다.
    // capture 단계여야 MathLive의 자체 처리보다 먼저 가로챌 수 있다.
    mf.addEventListener(
      'keydown',
      (ev) => {
        if (mf.readOnly) return;
        if (ev.ctrlKey || ev.metaKey || ev.altKey) return; // 단축키는 위 리스너 담당
        if (dispatchKeyOp(mf, ev.key)) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          // 연산이 문서를 바꿨으면 insert가 input 이벤트를 발사해
          // onEdit으로 문서·실행취소가 한 단위로 갱신된다.
        }
      },
      { capture: true },
    );

    host.append(mf);
    // ⚠ **MathLive 실측 함정 — 마운트 직후 선택이 내용 전체다.** append 전에 옵션을
    // 하나라도 건드리면(`mathVirtualKeyboardPolicy` 등, 전부 `_setOptions` 를 탄다)
    // 대기 중이던 선택이 `[[0, -1]]`(= 전체 선택)로 덮인다 — `mf.value` 가 넣어둔
    // 캐럿 하나(`[[-1, -1]]`)를 지우고 간다(`mathlive.mjs` 의 `_setOptions`,
    // `readOnly` 는 append 뒤에 켜지므로 결과 셀도 예외가 아니다). 그러면 탭을
    // 처음 열자마자 모든 셀이 포커스도 없이 전체 선택된 채로 서고 선택 핸들까지
    // 달린다(사용자 보고). 갓 뜬 필드에 선택이 있을 이유가 없으므로 접는다.
    mf.position = mf.lastOffset;
    // 인라인 숏컷 On/Off 커스터마이징. `inlineShortcuts` getter/setter는 mathfield가
    // mount(= append)되기 전에 부르면 "Mathfield not mounted" 에러를 던진다(실측).
    configureInlineShortcuts(mf);
    // ctrl/alt/shift 키바인딩 On/Off 커스터마이징 — 같은 mount 후 제약(`editor/keybindings.ts`).
    configureKeybindings(mf);
    // 셰도우 DOM 안쪽 렌더 손질 (append 후여야 셰도우 루트가 있다).
    applyShadowStyles(mf);
    // ☰ 메뉴에서 안 쓰는 항목 제거 (append 후여야 기본 메뉴가 구성돼 있다).
    pruneMenu(mf);
    // 포커스된 필드가 언마운트될 때의 MathLive 크래시 우회 (editor/internals.ts 참고).
    // 내부 프로토타입에 접근해야 해서 살아있는 인스턴스가 필요하다. 최초 1회만 적용됨.
    patchMathliveDisposedBlur(mf);
    // ghost 여는 괄호(닫는 괄호 입력용) 렌더·직렬화 패치. 최초 1회만 실제 작업을
    // 하고 결과가 캐시된다 — 키 입력 도중이 아니라 여기서 미리 데워둔다.
    ensureGhostLeftSupport();
    // 모바일 터치 제스처(가로 스크롤 / 홀드 선택 / 컨텍스트 메뉴 차단).
    // 데스크톱에서는 아무 것도 가로채지 않는다 (`editor/touchGesture.ts`).
    const detachTouchGesture = attachTouchGesture(mf, host);

    mfRef.current = mf;
    setMounted(mf);
    return () => {
      setMounted(null);
      document.removeEventListener('pointerdown', onOutsidePointerDown, { capture: true });
      outsideTap?.abort();
      detachTouchGesture();
      // `remove()` 는 포커스된 필드에서도 focusout 을 안 쏜다 — 게이트에 직접 알려야
      // 사라진 필드가 "포커스 중"으로 남지 않는다(`editor/activeField.ts`).
      // `remove()` 는 포커스된 필드에서도 focusout 을 안 쏜다 — 게이트에 직접 알려야
      // 사라진 필드가 "포커스 중"으로 남지 않는다(`editor/activeField.ts`).
      notifyFieldRemoved(mf);
      mf.remove();
      mfRef.current = null;
    };
  }, []);

  // readOnly는 보통 컴포넌트 수명 내내 고정이지만 안전하게 동기화한다.
  useEffect(() => {
    if (mfRef.current !== null) mfRef.current.readOnly = readOnly;
  }, [readOnly]);

  // 외부에서 값이 바뀐 경우에만 반영한다 (결과 셀 갱신, 로드 등).
  // 편집 중에는 건드리지 않는다 — 키 입력마다 문서가 갱신되므로 평상시에는
  // 두 값이 같아 no-op이지만, 다른 셀의 재평가가 끼어드는 타이밍을 방어한다.
  useEffect(() => {
    const mf = mfRef.current;
    if (mf !== null && !isEditing.current && mf.value !== value) {
      mf.setValue(value, { silenceNotifications: true });
      flushShortcutBuffer(mf);
    }
  }, [value]);

  // 강제 반영: 편집 중이어도 value를 밀어넣는다. 실행취소/다시실행 전용.
  // value가 아니라 syncKey에만 의존하므로 평상시 타이핑에는 절대 끼어들지 않는다.
  const firstSync = useRef(true);
  useEffect(() => {
    if (firstSync.current) {
      firstSync.current = false;
      return; // 마운트 시점의 값은 이미 반영돼 있다.
    }
    const mf = mfRef.current;
    if (mf !== null && mf.value !== value) {
      mf.setValue(value, { silenceNotifications: true });
      // 실행취소로 내용이 바뀌었다 — 숏컷 버퍼에 남은 옛 타이핑을 반드시 비운다.
      flushShortcutBuffer(mf);
    }
  }, [syncKey]);

  // 포커스 지시. focusSelection이 있으면 선택 복구, 아니면 focusOffset으로 캐럿.
  // syncKey 이펙트가 먼저 선언돼 있어 값 반영 → 포커스/캐럿 순서가 보장된다.
  useEffect(() => {
    if (focusToken === null || focusToken === undefined) return;
    const mf = mfRef.current;
    if (mf === null) return;
    mf.focus();
    // focus() 자체는 선택/캐럿을 안 건드린다(모델에 있던 값 그대로 둔다) — 우리가
    // 원하는 특정 자리로 보내려면 그 뒤에 명시적으로 놓아야 한다.
    if (focusSelection !== null && focusSelection !== undefined) {
      const clamp = (v: number) => Math.max(0, Math.min(v, mf.lastOffset));
      mf.selection = {
        ranges: [[clamp(focusSelection[0]), clamp(focusSelection[1])]],
        direction: 'forward',
      };
    } else if (focusOffset !== null && focusOffset !== undefined) {
      mf.position = Math.max(0, Math.min(focusOffset, mf.lastOffset));
    }
  }, [focusToken]);

  useImperativeHandle(
    ref,
    () => ({
      replaceSelection(latex: string) {
        const mf = mfRef.current;
        if (mf === null || mf.selectionIsCollapsed) return null;
        const [from, to] = mf.selection.ranges[0];
        suppressReport.current = true;
        try {
          mf.insert(latex, { insertionMode: 'replaceSelection', selectionMode: 'item' });
        } finally {
          suppressReport.current = false;
        }
        // 프로그래밍적 삽입은 키 입력 이벤트를 안 거치므로 mathlive 자체 버퍼 관리
        // (onKeystroke의 자동 flush)를 안 탄다 — 명시적으로 비워야 한다. 안 그러면
        // 변환 직전 타이핑이 버퍼에 남아 다음 입력과 이어붙어 엉뚱한 숏컷이 튄다
        // (예: "s" 타이핑 중 선택해 expand 클릭 → 이어서 "in" 입력 = 뜬금없는 \sin).
        flushShortcutBuffer(mf);
        // 삽입물이 새로 선택된 상태다(selectionMode:'item'). 그 선택을 재보고해
        // 버튼 상태를 갱신한다 — expand ↔ factor 왕복이 자연스럽게 된다.
        reportRef.current?.();
        return { value: mf.value, caret: mf.position, selectionBefore: [from, to] as const };
      },
    }),
    [],
  );

  // `math-field` 는 위 이펙트가 직접 append 한다 — 여기 React 자식은 그 뒤에 붙는
  // 오버레이(선택 핸들)뿐이다.
  return (
    <div ref={hostRef} className={readOnly ? 'mf mf-readonly' : 'mf'}>
      <SelectionHandles mf={mounted} container={hostRef.current} />
    </div>
  );
}
