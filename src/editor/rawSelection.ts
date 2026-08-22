import type { MathfieldElement } from 'mathlive';
import { modelOf } from './internals';
import { siblingRunRange } from './selection';

/**
 * **원시 캐럿** — 손가락(또는 핸들)이 실제로 짚은 두 오프셋. 화면에 보이는
 * `mf.selection` 은 이 둘을 감싸는 최소 형제 열(`siblingRunRange`)로 **파생**된
 * 값일 뿐이다.
 *
 * 왜 필요한가: 홀드 드래그가 구조 경계를 넘으면 `siblingRunRange` 가 상위 레벨로
 * 스냅한다. 그런데 그 스냅된 **결과**를 다음 조작(핸들 드래그)의 출발점으로 삼으면,
 * 한번 넓어진 선택을 다시 좁힐 방법이 없다 — 좁히려 해도 이미 넓은 범위에서 다시
 * 스냅될 뿐이다. 원시 좌표를 따로 쥐고 있으면, 손가락을 되돌렸을 때
 * `siblingRunRange(원시a, 원시b)` 가 처음부터 다시 계산되어 자연스럽게 좁아진다.
 *
 * 저장은 `WeakMap` — 필드가 사라지면 같이 사라지고 별도 정리가 필요 없다.
 */
type RawPair = { readonly a: number; readonly b: number; readonly shown: readonly [number, number] };

const store = new WeakMap<MathfieldElement, RawPair>();

/**
 * 원시 캐럿 `(a, b)` 를 기억하고, 그 최소 형제 열로 `mf.selection` 을 세팅한다.
 * `mf.selection` 세팅은 `selection-change` 를 발화시켜 `MathField` 의
 * `normalizeSelection` 게이트를 지나가지만, `siblingRunRange` 는 멱등이라 여기서
 * 미리 스냅해 둔 값과 같은 결과가 나온다 — 게이트가 두 벌이 되지 않는다.
 */
export function setRawSelection(mf: MathfieldElement, a: number, b: number): void {
  const model = modelOf(mf);
  if (model === null) return;
  const snapped = siblingRunRange(model, a, b);
  if (snapped === null) return;
  store.set(mf, { a, b, shown: snapped });
  mf.selection = {
    ranges: [snapped],
    direction: b < a ? 'backward' : 'forward',
  };
}

/**
 * 기억해 둔 원시 캐럿 쌍. 선택이 없으면 `null`.
 *
 * **낡음 판정**: 기억해 둔 `shown` 이 지금 `mf.selection` 과 다르면, 다른 경로
 * (타이핑·Ctrl+D·팔레트·실행취소·탭)가 선택을 바꾼 것이다 — 그 경로들은 원시
 * 캐럿을 모른다. 그럴 땐 원시 쌍을 버리고 **지금 보이는 범위 자체**를 새 씨앗으로
 * 돌려준다(둘 다 같은 값). 별도의 무효화 훅이 필요 없다 — 다음 `setRawSelection`
 * 호출이 정본이 된다.
 */
export function rawSelection(mf: MathfieldElement): readonly [number, number] | null {
  if (mf.selectionIsCollapsed) return null;
  const range = mf.selection.ranges[0];
  if (range === undefined) return null;
  const cached = store.get(mf);
  if (cached !== undefined && cached.shown[0] === range[0] && cached.shown[1] === range[1]) {
    return [cached.a, cached.b];
  }
  return [range[0], range[1]];
}
