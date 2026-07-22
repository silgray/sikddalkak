import type { MathfieldElement } from 'mathlive';

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
 * 돌아오고 회귀 테스트/검증에서 잡힌다. mathlive 버전을 올릴 때 재확인할 것.
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
