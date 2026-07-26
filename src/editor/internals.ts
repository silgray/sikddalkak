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
