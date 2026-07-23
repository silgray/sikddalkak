import type { MathfieldElement } from 'mathlive';

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
