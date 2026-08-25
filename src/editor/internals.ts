import { MathfieldElement } from 'mathlive';

/**
 * MathLive **내부 API** 접근을 모아두는 곳. 공개 API로 불가능한 것들만 있다.
 * 전부 실측으로 확인한 구조에 의존하므로, mathlive 버전을 올릴 때 이 파일이
 * 재확인 목록이다. 각 접근은 실패해도 조용히 폴백하도록 방어한다.
 * (에디터 회귀 스위트(editor.browser.test.tsx)가 깨지면 여기부터 본다.)
 */

/** 내부 model의 우리가 쓰는 최소 표면. */
export type InternalAtom = {
  parent?: InternalAtom | null;
  parentBranch?: unknown;
  type?: string;
  /** leftright(fence)의 여는 구분자. ghost면 `'?'`. */
  leftDelim?: string;
  /** leftright(fence)의 닫는 구분자. ghost면 `'?'`. */
  rightDelim?: string;
  /** atom의 LaTeX 커맨드/문자 (`+`, `-`, `\cdot`, `x` 등). 연산자 판별에 쓴다. */
  command?: string;
  /**
   * 첨자 branch의 atom 열. ⚠ **위·아래 첨자는 한 atom(`subsup`)이 함께 들고 있다**
   * (실측) — 한쪽만 지우려면 반대쪽을 여기서 꺼내 되살려야 한다.
   * 첫 원소는 언제나 `first` 센티넬이라, 내용이 있으면 길이가 1보다 크다.
   */
  superscript?: InternalAtom[];
  subscript?: InternalAtom[];
  /** true로 쓰면 MathLive가 원본 LaTeX 캐시(verbatimLatex)를 버린다. */
  isDirty?: boolean;
};
export type InternalModel = {
  getAtoms: (range: [number, number]) => InternalAtom[];
  at: (offset: number) => InternalAtom | undefined;
  offsetOf: (atom: InternalAtom) => number;
  lastOffset: number;
  anchor: number;
  position: number;
};

export function modelOf(mf: MathfieldElement): InternalModel | null {
  const model = (mf as unknown as { _mathfield?: { model?: InternalModel } })._mathfield?.model;
  return model ?? null;
}

/**
 * MathLive가 원자 화면 상자를 **뷰포트 좌표로 캐싱**해 두는 곳
 * (`mathfield.atomBoundsCache`, `getAtomBounds`/`getElementInfo` 가 읽는다). 비우는
 * 곳은 원래 셋뿐이다(실측): 재렌더 직전(rAF), 렌더 끝, 그리고 자기 자신의
 * `onPointerDown`. **패닝은 렌더도 pointerdown도 없이 `scrollLeft` 만 옮기므로**
 * 캐시가 안 비워져 핸들이 스크롤을 따라가지 않는다 — `SelectionHandles.tsx` 가
 * 기하 변화(스크롤·리사이즈)를 감지했을 때만 이걸 불러 강제로 비운다.
 *
 * ⚠ 매 프레임 부르면 안 된다 — 캐시가 비면 `getOffsetFromPoint` 가 원자마다
 * `querySelectorAll`+`getBoundingClientRect` 를 다시 돌아 홀드 드래그 같은
 * 프레임마다 히트테스트하는 경로에서 버벅인다.
 */
export function clearAtomBoundsCache(mf: MathfieldElement): void {
  const internal = (mf as unknown as { _mathfield?: { atomBoundsCache?: Map<string, unknown> } })
    ._mathfield;
  internal?.atomBoundsCache?.clear();
}

/**
 * 오프셋 하나가 화면에서 서는 **뷰포트 x**. 못 재면 `null`.
 *
 * 오프셋은 원자 **사이**의 경계라, 그 자리는 "오프셋 `q` 로 끝나는 원자의 오른쪽"
 * 이다. 예외는 branch 맨 앞(`first` 센티넬) — 거기선 뒤따르는 첫 원자의 **왼쪽**을
 * 쓴다. ⚠ **센티넬 자기 상자를 쓰면 안 된다**: 그 값은 자기가 아니라 부모 컨테이너
 * 전체로 나오고 레이아웃 타이밍까지 탄다(`resolveOffsetAt` 의 ⚠ 참고). 진짜 원자
 * 상자만 믿는다.
 */
export function boundaryXOf(mf: MathfieldElement, offset: number): number | null {
  try {
    const model = modelOf(mf);
    const isSentinel = model !== null && model.at(offset)?.type === 'first';
    const box = isSentinel
      ? mf.getElementInfo(offset + 1)?.bounds
      : mf.getElementInfo(offset)?.bounds;
    if (box === undefined) return null;
    return isSentinel ? box.left : box.right;
  } catch {
    return null;
  }
}

/**
 * 센티넬이 나왔을 때, **그 센티넬의 branch 안에서** 손가락에 가장 가까운 형제
 * 경계를 직접 고른다. MathLive는 "점이 이 branch 안에 있다"까지는 맞게 알려준
 * 셈이라(센티넬의 부모 상자가 점을 품었으니), 그 안에서 자리만 우리가 정한다.
 */
function nearestBoundaryInBranch(
  mf: MathfieldElement,
  model: InternalModel,
  sentinel: number,
  x: number,
  bias: -1 | 0 | 1,
): number | null {
  const home = model.at(sentinel);
  if (home === undefined) return null;
  const parent = home.parent ?? null;
  const branch = JSON.stringify(home.parentBranch ?? null);

  let best: number | null = null;
  let bestDist = Infinity;
  // 센티넬은 그 branch의 첫 오프셋이라 형제 경계는 전부 그 뒤에 있다. 중간에
  // 끼는 중첩 내용은 (parent, branch) 비교가 걸러낸다.
  for (let q = sentinel; q <= model.lastOffset; q += 1) {
    const atom = model.at(q);
    if (atom === undefined) continue;
    if ((atom.parent ?? null) !== parent) continue;
    if (JSON.stringify(atom.parentBranch ?? null) !== branch) continue;
    const edge = boundaryXOf(mf, q);
    if (edge === null) continue;
    const d = Math.abs(x - edge);
    // 같은 거리면 bias가 가리키는 쪽을 고른다 (왼쪽 -1 / 오른쪽 +1).
    if (d < bestDist || (d === bestDist && bias > 0)) {
      bestDist = d;
      best = q;
    }
  }
  return best;
}

/**
 * 화면 좌표 → 모델 오프셋. **네이티브 탭과 같은 경로**로 물어본다.
 *
 * **드래그 파이프라인 ① — 픽셀 → 오프셋.** 손가락이 짚은 좌표를 **원시 캐럿**
 * 하나로 바꾼다. 여기서 나온 값은 아직 선택이 아니다 — 선택으로 만드는 건 ②의
 * `caretRunRange`(`editor/selection.ts`)고, 그 결과를 다시 화면 좌표로 되돌리는
 * 건 ③의 `measure`(`components/SelectionHandles.tsx`)다.
 *
 * ⚠ **실측한 진짜 함정은 `atomBoundsCache` 다.** `getOffsetFromPoint` 한 번이
 * 트리를 훑으며 원자 상자를 재고 그 결과를 캐시에 쌓는데, 거기 `first` 센티넬의
 * 상자가 들어가면 **그 다음 호출부터** 그 센티넬이 자기 branch 어디서나 이겨버린다.
 * 센티넬 상자는 자기 자신이 아니라 **부모 컨테이너 전체**로 재지기 때문이다
 * (`getNodeBounds` 가 높이 0인 노드에서 부모로 올라간다) — `distance()` 는 점이
 * 상자 안이면 0을 주므로 무조건 이긴다.
 *
 * MathLive 자신의 탭(`onPointerDown`)이 **항상 정확한 이유가 바로 이것**이다:
 * 탭마다 캐시를 비우고 시작한다. 우리 드래그는 pointermove마다 히트테스트하므로
 * 안 비우면 두 번째 이동부터 오염된 값을 쓴다 — 그게 "커서가 엉뚱한 데로 튀는"
 * 증상이었다(실측: 매 호출 비우면 결과가 진짜 탭과 **정확히 일치**한다).
 *
 * ⚠ **한 번만 비우는 걸로는 안 된다** — 그 다음 첫 호출이 다시 오염시킨다(실측).
 *
 * 뒤의 센티넬 보정은 캐시를 비운 뒤에도 남는 가장자리를 메우는 **2차 안전망**이다.
 * (센티넬 오프셋 자체는 branch 맨 앞을 가리키는 정당한 값이라, 캐시가 깨끗하면
 * 거의 안 걸린다.)
 */
export function resolveOffsetAt(
  mf: MathfieldElement,
  x: number,
  y: number,
  bias: -1 | 0 | 1,
): number | null {
  try {
    // ⚠ **매 호출 직전에 캐시를 비워야 한다.** `getOffsetFromPoint` 한 번이 트리를
    // 훑으며 `atomBoundsCache` 를 채우는데, 거기 센티넬의 부모-크기 상자가 들어가면
    // **그 다음 호출부터** 그 센티넬이 자기 branch 어디서나 이겨버린다(실측).
    // MathLive 자신의 탭(`onPointerDown`)이 항상 정확한 이유가 바로 이것 —
    // 탭마다 캐시를 비우고 시작한다. 우리는 pointermove마다 히트테스트하므로
    // 안 비우면 두 번째 이동부터 오염된 값을 쓴다.
    // (한 번만 비우는 걸로는 안 된다 — 그 다음 첫 호출이 다시 오염시킨다, 실측.)
    clearAtomBoundsCache(mf);
    const offset = mf.getOffsetFromPoint(x, y, { bias });
    // console.log(`[resolve] x:${x}, y:${y}, offset:${offset}`);
    if (offset < 0) return null;
    const model = modelOf(mf);
    // 내부 model을 못 잡으면 걸러낼 방법이 없다 — 기존 동작(그대로 쓰기)으로 폴백.
    if (model === null) return offset;
    if (model.at(offset)?.type !== 'first') return offset;
    return nearestBoundaryInBranch(mf, model, offset, x, bias);
  } catch {
    return null;
  }
}

/**
 * 셰도우 DOM 안의 키보드 이벤트 싱크(`.ML__keyboard-sink`, contenteditable 스팬).
 * MathLive는 여기서 keydown/keypress/input을 듣는다(`delegateKeyboardEvents`,
 * mathlive.mjs 실측) — 호스트(`math-field` 엘리먼트)에 이벤트를 쏘면 이 리스너들을
 * 아예 안 거친다. `feedKey.ts` 가 물리 키 입력과 같은 경로를 타려고 여기로 합성
 * `KeyboardEvent`를 디스패치한다(브라우저 테스트 하네스의 `pressKey`와 같은 자리).
 */
export function keyboardSinkOf(mf: MathfieldElement): HTMLElement | null {
  return mf.shadowRoot?.querySelector<HTMLElement>('.ML__keyboard-sink') ?? null;
}

/**
 * 셰도우 DOM 안의 콘텐츠 상자(`.ML__content`). **가로 스크롤 컨테이너**다 —
 * `overflow: hidden` 이라(mathlive.mjs 실측) 브라우저 네이티브 패닝은 없고,
 * MathLive 자신도 캐럿을 따라갈 때 `field.scroll({left})` 로 여기를 직접 옮긴다
 * (`Mathfield.scrollIntoView`). 그래서 넘침 측정(`FieldClip.tsx`)과 터치 패닝
 * (`touchGesture.ts`)이 둘 다 이 요소의 `scrollLeft`/`scrollWidth` 를 본다.
 *
 * ⚠ `::part(content)` 에 `overflow` 를 덮어쓰면 이 스크롤 컨테이너가 사라진다
 * (`styles.css` 의 경고 참고).
 */
export function contentOf(mf: Element): HTMLElement | null {
  return mf.shadowRoot?.querySelector<HTMLElement>('.ML__content') ?? null;
}

/**
 * MathLive의 인라인 숏컷 키 버퍼를 비운다. 외부에서 값을 밀어넣을 때(실행취소
 * 등) 같이 불러야 한다 — 안 그러면 버퍼에 남은 옛 글자와 다음 입력이 이어붙어
 * 숏컷 매칭돼, 이미 되돌린 글자가 되살아난다 (예: s → undo → 'in' 입력 = \sin).
 */
export function flushShortcutBuffer(mf: MathfieldElement): void {
  try {
    (
      mf as unknown as { _mathfield?: { flushInlineShortcutBuffer?: () => void } }
    )._mathfield?.flushInlineShortcutBuffer?.();
  } catch {
    // 내부 API — 없어도 동작 자체는 유지된다.
  }
}

/**
 * MathLive 0.110.0 버그 우회.
 *
 * MathLive는 포커스 추적을 정적 전역(`_globallyFocusedMathfield`)으로 하는데,
 * `dispose()`(disconnectedCallback에서 호출)가 이 전역을 지우지 않는다. 포커스된
 * mathfield가 DOM에서 제거되면(예: 편집 중인 결과 행이 분리로 언마운트) 브라우저는
 * blur 이벤트를 쏘지 않으므로 전역에 dispose된 필드가 남고, 다음 mathfield가
 * 포커스될 때 onFocus가 그 낡은 참조의 onBlur를 호출한다:
 *
 *   onBlur → model.getValue() → atomToString → this.mathfield.options
 *                                              ^^^^^^^^^^^^^^ dispose로 undefined → 크래시
 *
 * cleanup에서 미리 blur()를 불러도 내부 이벤트 경로가 이를 onBlur까지 전달하지
 * 않아 소용없음을 실측으로 확인했다. 그래서 내부 onBlur에 "dispose된 필드면
 * 무시" 가드를 씌운다. 가드가 스킵한 직후 onFocus가 전역을 새 필드로 교체하므로
 * 낡은 참조는 자연히 사라진다.
 *
 * 내부 클래스는 export되지 않아 인스턴스를 통해 프로토타입에 접근한다. 내부
 * 구조가 바뀌면(필드명 변경 등) 조용히 아무것도 하지 않는다 — 그 경우 크래시가
 * 돌아오고 회귀 테스트/검증에서 잡힌다.
 */

type InternalMathfield = {
  /** dispose()가 undefined로 만드는 백링크 — 생존 여부 판별에 쓴다. */
  element?: unknown;
};
type InternalHost = { _mathfield?: { constructor?: { prototype?: unknown } } };

let patched = false;

export function patchMathliveDisposedBlur(mf: MathfieldElement): void {
  if (patched) return;
  const proto = (mf as unknown as InternalHost)._mathfield?.constructor?.prototype as
    | { onBlur?: (...args: unknown[]) => unknown }
    | undefined;
  if (proto === undefined || typeof proto.onBlur !== 'function') return;
  patched = true;

  const original = proto.onBlur;
  proto.onBlur = function (this: InternalMathfield, ...args: unknown[]) {
    if (this.element === undefined || this.element === null) return undefined;
    return original.apply(this, args);
  };
}

/**
 * ghost **왼쪽** 구분자 지원 (MathLive에 없는 것을 얹는다).
 *
 * MathLive는 `rightDelim === '?'`(ghost 닫는 괄호)만 지원한다 — 반투명 렌더도,
 * 직렬화 시 짝으로 되돌리는 것도 오른쪽 전용이다(`matchingLeftDelim` 함수 자체가 없다).
 * 우리는 닫는 괄호를 여는 괄호와 대칭으로 만들려고 `leftDelim === '?'` 를 쓰므로,
 * 그 두 가지를 프로토타입 패치로 채운다:
 *
 *  1. **렌더** — 렌더하는 동안만 짝 여는 구분자로 바꿔 원본에 맡기고, 결과 Box에
 *     MathLive 자신의 `ML__smart-fence__close`(opacity 0.5) 클래스를 붙인다.
 *     `Box.classes`는 markup 생성 시점에 읽히므로 사후 변경이 먹힌다(실측).
 *     그래서 다크모드·forced-colors 변형까지 MathLive CSS를 그대로 재사용한다.
 *  2. **직렬화** — 그냥 두면 `\left?` 가 문서·localStorage·CE로 샌다(실측).
 *     같은 방식으로 짝 여는 구분자로 바꿔 원본에 맡긴다.
 *
 * 내부 클래스가 export되지 않아 임시 필드에서 인스턴스를 얻어 프로토타입을 잡는다.
 * 실패하면 `false` — 호출부는 ghost-left를 **만들지 않는 쪽으로** 폴백해야 한다
 * (`?` 글리프가 그대로 보이는 깨진 렌더를 피하려고).
 */
type InternalBox = { classes?: string; children?: InternalBox[] };
type GhostFenceAtom = { leftDelim?: string; rightDelim?: string };
type LeftRightProto = {
  render?: (this: GhostFenceAtom, context: unknown) => InternalBox | null;
  _serialize?: (this: GhostFenceAtom, options: unknown) => string;
};

/** ghost 오른쪽 구분자가 흉내낼 닫는 구분자 (여는 구분자의 짝). */
function matchingCloseDelim(leftDelim: string | undefined): string {
  switch (leftDelim) {
    case '\\lbrack':
    case '[':
      return '\\rbrack';
    case '\\lbrace':
    case '{':
      return '\\rbrace';
    case '|':
      return '|';
    case '\\lparen':
      return '\\rparen';
    default:
      return ')';
  }
}

/** ghost 왼쪽 구분자가 흉내낼 여는 구분자 (닫는 구분자의 짝). */
function matchingOpenDelim(rightDelim: string | undefined): string {
  switch (rightDelim) {
    case '\\rbrack':
    case ']':
      return '\\lbrack';
    case '\\rbrace':
    case '}':
      return '\\lbrace';
    case '|':
      return '|';
    case '\\rparen':
      return '\\lparen';
    default:
      return '(';
  }
}

/** Box 트리에서 처음 만나는 여는 구분자 박스에 반투명 클래스를 붙인다. */
function markGhostOpenBox(box: InternalBox | null): boolean {
  if (box === null || typeof box !== 'object') return false;
  if (typeof box.classes === 'string' && box.classes.includes('ML__open')) {
    box.classes = `${box.classes} ML__smart-fence__close`;
    return true;
  }
  // 왼쪽 구분자는 본문보다 먼저 오므로 전위 순회의 첫 매치가 항상 바깥 fence의 것이다.
  for (const child of box.children ?? []) {
    if (markGhostOpenBox(child)) return true;
  }
  return false;
}

let ghostLeftSupported: boolean | null = null;

/** 임시 필드를 띄워 `LeftRightAtom` 프로토타입을 얻는다 (export되지 않음). */
function leftRightPrototype(): LeftRightProto | null {
  const probe = new MathfieldElement();
  try {
    probe.style.position = 'fixed';
    probe.style.left = '-9999px';
    document.body.append(probe);
    probe.setValue(String.raw`\left(x\right)`, { silenceNotifications: true });
    const model = modelOf(probe);
    if (model === null) return null;
    for (let q = 0; q <= model.lastOffset; q += 1) {
      const atom = model.at(q);
      if (atom?.type === 'leftright') {
        return Object.getPrototypeOf(atom) as LeftRightProto;
      }
    }
    return null;
  } finally {
    probe.remove();
  }
}

/**
 * ghost-left 패치를 최초 1회 적용한다. 지원 여부를 반환하며, 결과는 캐시된다.
 * 호출부(닫는 괄호 키 연산)는 `false`면 ghost-left를 만들지 말아야 한다.
 */
export function ensureGhostLeftSupport(): boolean {
  if (ghostLeftSupported !== null) return ghostLeftSupported;
  ghostLeftSupported = false;
  try {
    const proto = leftRightPrototype();
    if (proto === null) return false;
    const originalRender = proto.render;
    const originalSerialize = proto._serialize;
    if (typeof originalRender !== 'function' || typeof originalSerialize !== 'function') {
      return false;
    }

    proto.render = function (this: GhostFenceAtom, context: unknown) {
      if (this.leftDelim !== '?') return originalRender.call(this, context);
      this.leftDelim = matchingOpenDelim(this.rightDelim);
      try {
        const box = originalRender.call(this, context);
        markGhostOpenBox(box);
        return box;
      } finally {
        this.leftDelim = '?';
      }
    };

    proto._serialize = function (this: GhostFenceAtom, options: unknown) {
      if (this.leftDelim !== '?') return originalSerialize.call(this, options);
      this.leftDelim = matchingOpenDelim(this.rightDelim);
      try {
        return originalSerialize.call(this, options);
      } finally {
        this.leftDelim = '?';
      }
    };

    ghostLeftSupported = true;
    return true;
  } catch {
    // 내부 구조가 바뀌었다 — ghost-left 없이 동작한다 (호출부가 폴백).
    return false;
  }
}

/**
 * 이 필드의 ghost fence를 전부 진짜 구분자로 확정한다 (포커스가 셀을 떠날 때).
 *
 * ghost는 "지금 편집 중인 셀의 순간 상태"라는 의미를 코드로 못박는 장치다. LaTeX
 * 표현은 어차피 확정본과 같으므로(직렬화가 짝으로 바꾼다) 문서·계산·저장에는 아무
 * 영향이 없고, 반투명 표시만 사라진다.
 *
 * `isDirty`를 함께 세워야 한다 — MathLive가 원본 LaTeX을 verbatim 캐시에 들고 있으면
 * 구분자를 바꿔도 직렬화 결과가 안 바뀐다(실측).
 */
export function finalizeGhostFences(mf: MathfieldElement): void {
  try {
    const model = modelOf(mf);
    if (model === null) return;
    for (let q = 0; q <= model.lastOffset; q += 1) {
      const atom = model.at(q);
      if (atom?.type !== 'leftright') continue;
      if (atom.leftDelim === '?') {
        atom.leftDelim = matchingOpenDelim(atom.rightDelim);
        atom.isDirty = true;
      }
      if (atom.rightDelim === '?') {
        atom.rightDelim = matchingCloseDelim(atom.leftDelim);
        atom.isDirty = true;
      }
    }
  } catch {
    // 내부 API — 실패해도 ghost가 남을 뿐 문서에는 영향이 없다.
  }
}

/** fence 한 개의 ghost 여부. 감싸기 전후로 ghost 상태를 옮길 때 쓴다. */
export type GhostFlags = { left: boolean; right: boolean };

/**
 * 범위 안 fence들의 ghost 여부를 **오프셋 순서대로** 뽑는다.
 *
 * 괄호로 감쌀 때 우리는 내용을 LaTeX으로 뽑아 다시 넣는데, 직렬화가 `'?'` 를 짝으로
 * 바꾸므로 그 과정에서 안쪽 ghost가 전부 확정돼버린다(실측). 감싸기 전에 이걸로
 * 상태를 떠두고 나중에 `restoreGhostFlags` 로 되돌린다.
 */
export function captureGhostFlags(
  model: InternalModel,
  range: readonly [number, number],
): GhostFlags[] {
  const out: GhostFlags[] = [];
  try {
    for (let q = range[0]; q <= Math.min(range[1], model.lastOffset); q += 1) {
      const atom = model.at(q);
      if (atom?.type !== 'leftright') continue;
      out.push({ left: atom.leftDelim === '?', right: atom.rightDelim === '?' });
    }
  } catch {
    return [];
  }
  return out;
}

/** `captureGhostFlags` 로 떠둔 상태를 같은 순서의 fence들에 되돌린다. */
export function restoreGhostFlags(
  model: InternalModel,
  range: readonly [number, number],
  flags: readonly GhostFlags[],
): void {
  if (flags.length === 0) return;
  try {
    let i = 0;
    for (let q = range[0]; q <= Math.min(range[1], model.lastOffset); q += 1) {
      const atom = model.at(q);
      if (atom?.type !== 'leftright') continue;
      const flag = flags[i];
      i += 1;
      if (flag === undefined) return;
      if (flag.left) {
        atom.leftDelim = '?';
        atom.isDirty = true;
      }
      if (flag.right) {
        atom.rightDelim = '?';
        atom.isDirty = true;
      }
    }
  } catch {
    // 내부 API — 실패하면 ghost가 확정된 채로 남는다 (문서에는 영향 없음).
  }
}
