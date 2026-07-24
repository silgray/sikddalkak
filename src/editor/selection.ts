import type { MathfieldElement } from 'mathlive';
import { modelOf, type InternalAtom, type InternalModel } from './internals';

/**
 * 선택 조작 — 내부 atom 트리를 "형제 문맥"으로 읽어 구현한다.
 *
 * "형제 문맥" = (부모 atom, branch). 같은 문맥의 오프셋들이 한 레벨의 형제 열이다.
 * 오프셋 q가 문맥에 속한다 ⇔ q에서 끝나는 atom(model.at(q))의 (parent, branch)가 같다.
 */
type SiblingCtx = { parent: InternalAtom | null; branch: string };

function ctxAt(model: InternalModel, offset: number): SiblingCtx | null {
  const atom = model.at(offset);
  if (atom === undefined) return null;
  return { parent: atom.parent ?? null, branch: JSON.stringify(atom.parentBranch ?? null) };
}

function inCtx(atom: InternalAtom | undefined, ctx: SiblingCtx): boolean {
  return (
    atom !== undefined &&
    (atom.parent ?? null) === ctx.parent &&
    JSON.stringify(atom.parentBranch ?? null) === ctx.branch
  );
}

/** ctx 형제 열에서 offset 바로 왼쪽 형제 경계. 없으면 null. */
function prevSiblingBoundary(model: InternalModel, ctx: SiblingCtx, offset: number): number | null {
  for (let q = offset - 1; q >= 0; q -= 1) {
    if (inCtx(model.at(q), ctx)) return q;
  }
  return null;
}

/** ctx 형제 열에서 offset 바로 오른쪽 형제 경계. 없으면 null. */
function nextSiblingBoundary(model: InternalModel, ctx: SiblingCtx, offset: number): number | null {
  for (let q = offset + 1; q <= model.lastOffset; q += 1) {
    if (inCtx(model.at(q), ctx)) return q;
  }
  return null;
}

/** offset이 속한 형제 문맥부터 바깥으로 올라가는 사슬 (안 → 밖). */
function chainOf(model: InternalModel, offset: number): SiblingCtx[] {
  const chain: SiblingCtx[] = [];
  let ctx = ctxAt(model, offset);
  while (ctx !== null) {
    chain.push(ctx);
    const owner = ctx.parent;
    if (owner === null || owner === undefined) break;
    ctx = { parent: owner.parent ?? null, branch: JSON.stringify(owner.parentBranch ?? null) };
  }
  return chain;
}

/** ctx branch 전체의 [시작, 끝] 오프셋 (내용 전부). 빈 branch면 null. */
function branchRange(model: InternalModel, ctx: SiblingCtx): [number, number] | null {
  let lo: number | null = null;
  let hi = 0;
  for (let q = 0; q <= model.lastOffset; q += 1) {
    if (inCtx(model.at(q), ctx)) {
      if (lo === null) lo = q;
      hi = q;
    }
  }
  return lo === null ? null : [lo, hi];
}

/** 범위 안의 실제 atom들 (MathLive가 각 branch 앞에 두는 'first' 센티널 제외). */
function meaningfulAtoms(model: InternalModel, range: [number, number]): InternalAtom[] {
  return model.getAtoms(range).filter((atom) => atom.type !== 'first');
}

/**
 * **선택 불변식의 핵심**: [a,b]를 포함하는 최소한의 "한 문맥 연속 형제 열"을 구한다.
 *
 * MathLive의 선택은 atom 트리를 평탄하게 훑은 정수 오프셋이라, 서로 다른 부모의
 * atom을 걸치는 구간도 표현할 수 있다. 그런 구간은 부분식이 아니고(LaTeX로 뽑으면
 * 행렬 셀 구분이 사라진다), 렌더도 층층이 겹친 박스로 어긋난다. 그래서 양 끝의
 * 문맥 사슬에서 최초 공통 문맥을 찾아 그 레벨의 형제 경계로 넓힌다.
 *
 * 성질: 멱등(이미 정규형이면 그대로) · 포함(원래 범위를 잃지 않음) · 결정적.
 */
export function siblingRunRange(
  model: InternalModel,
  a0: number,
  b0: number,
): [number, number] | null {
  const a = Math.min(a0, b0);
  const b = Math.max(a0, b0);
  const chainA = chainOf(model, a);
  const common = chainOf(model, b).find((cb) =>
    chainA.some((ca) => ca.parent === cb.parent && ca.branch === cb.branch),
  );
  if (common === undefined) return null;
  const whole = branchRange(model, common);
  if (whole === null) return null;

  // 왼쪽: a 이하의 가장 가까운 형제 경계 (a가 어떤 형제의 내부면 그 형제 앞).
  let left: number | null = null;
  for (let q = a; q >= 0; q -= 1) {
    if (inCtx(model.at(q), common)) {
      left = q;
      break;
    }
  }
  // 오른쪽: b 이상의 가장 가까운 형제 경계 (b가 내부면 그 형제 끝).
  let right: number | null = null;
  for (let q = b; q <= model.lastOffset; q += 1) {
    if (inCtx(model.at(q), common)) {
      right = q;
      break;
    }
  }
  let lo = left ?? whole[0];
  const hi = right ?? whole[1];

  // 첨자(subsup)는 밑에 붙는 조각이라 혼자 떼면 `^{2y}`처럼 파싱 불가한 LaTeX가
  // 된다(실측). 앞 형제(밑)를 포함할 때까지 왼쪽으로 넓힌다.
  for (let guard = 0; guard < 4; guard += 1) {
    const first = meaningfulAtoms(model, [lo, hi])[0];
    if (first === undefined || first.type !== 'subsup') break;
    const prev = prevSiblingBoundary(model, common, lo);
    if (prev === null) break;
    lo = prev;
  }
  return [lo, hi];
}

/**
 * 현재 선택을 형제 열 불변식에 맞게 교정한다. 바꿨으면 true.
 * 선택이 만들어지는 **모든 경로**(드래그·shift+화살표·Ctrl+D·더블클릭·Ctrl+A·
 * 실행취소 복구)가 selection-change를 거치므로, 거기서 이 함수만 부르면 된다.
 */
export function normalizeSelection(mf: MathfieldElement): boolean {
  try {
    if (mf.selectionIsCollapsed) return false;
    const model = modelOf(mf);
    if (model === null) return false;
    const { ranges, direction } = mf.selection;
    if (ranges.length === 0) return false;
    // 행렬 셀별 다중 선택도 전체를 감싸는 한 구간으로 접는다.
    const lo = Math.min(...ranges.map((r) => r[0]));
    const hi = Math.max(...ranges.map((r) => r[1]));
    const snapped = siblingRunRange(model, lo, hi);
    if (snapped === null) return false;
    const [a, b] = snapped;
    if (ranges.length === 1 && ranges[0][0] === a && ranges[0][1] === b) return false;
    mf.selection = { ranges: [[a, b]], direction: direction === 'backward' ? 'backward' : 'forward' };
    return true;
  } catch {
    // 내부 API 실패 — 선택을 건드리지 않는다 (기존 동작).
    return false;
  }
}

function setSelectionRange(mf: MathfieldElement, anchor: number, extent: number): void {
  mf.selection = {
    ranges: [[Math.min(anchor, extent), Math.max(anchor, extent)]],
    direction: extent < anchor ? 'backward' : 'forward',
  };
}

/**
 * shift+←/→ 를 같은 레벨(형제) 단위로 만든다. MathLive 기본 확장은 분수·행렬
 * 오른쪽에서 구조 **안으로** 파고들어 빈 조각을 선택한다(실측) — 여기서는
 * 확장 끝에 맞닿은 형제 atom 전체를 한 번에 선택 범위에 넣는다.
 * 처리했으면 true (호출자가 preventDefault).
 */
export function extendSelectionSibling(mf: MathfieldElement, dir: 'left' | 'right'): boolean {
  const model = modelOf(mf);
  if (model === null) return false;
  const anchor = model.anchor;
  const extent = model.position;
  const ctx = ctxAt(model, anchor);
  if (ctx === null || !inCtx(model.at(extent), ctx)) return false; // 다른 레벨 — 기본 동작
  const next =
    dir === 'left'
      ? prevSiblingBoundary(model, ctx, extent)
      : nextSiblingBoundary(model, ctx, extent);
  if (next === null) return false; // 열의 끝 — 기본 동작(이동 없음/move-out)
  setSelectionRange(mf, anchor, next);
  return true;
}

/**
 * Ctrl+D: 의미 단위 선택 확장.
 * - 선택 없음 → 캐럿이 속한 branch 내용 전체 (분모 안이면 분모 내용)
 * - 선택이 branch 내용 전체와 일치 → 그 branch를 가진 atom 통째 (분모 → 분수)
 * - 그 외 → 선택을 모두 포함하는 가장 낮은 branch 내용으로 스냅
 * 반복해서 누르면 한 레벨씩 올라간다.
 */
export function expandSelectionSemantic(mf: MathfieldElement): void {
  const model = modelOf(mf);
  if (model === null) return;
  if (mf.selectionIsCollapsed) {
    const ctx = ctxAt(model, model.position);
    if (ctx === null) return;
    const range = branchRange(model, ctx);
    if (range !== null) setSelectionRange(mf, range[0], range[1]);
    return;
  }
  const [a, b] = mf.selection.ranges[0];

  // a, b 각각의 branch 사슬(안→밖)에서 처음 만나는 공통 branch.
  const chainA = chainOf(model, a);
  const common = chainOf(model, b).find((cb) =>
    chainA.some((ca) => ca.parent === cb.parent && ca.branch === cb.branch),
  );
  if (common === undefined) return;
  const range = branchRange(model, common);
  if (range === null) return;

  if (a === range[0] && b === range[1]) {
    // 이미 branch 내용 전체 → 그 branch를 가진 atom 통째로 (한 레벨 위).
    const owner = common.parent;
    if (owner === null || owner === undefined) return; // root — 더 위 없음
    const end = model.offsetOf(owner);
    const ownerCtx: SiblingCtx = {
      parent: owner.parent ?? null,
      branch: JSON.stringify(owner.parentBranch ?? null),
    };
    const start = prevSiblingBoundary(model, ownerCtx, end);
    setSelectionRange(mf, start ?? 0, end);
    return;
  }
  setSelectionRange(mf, range[0], range[1]);
}

/**
 * 선택이 한 그룹 안의 형제 run인지. 행렬 셀 경계를 가로지르는 드래그 선택은
 * atom들의 (parent, branch)가 갈려서 여기서 걸러진다 — 그런 조각을 latex로
 * 재구성하면 셀 구분이 사라진 엉뚱한 식(`xx^2-1`)이 되므로 변환 대상이 아니다.
 * 내부 model API라 실패하면 통과(기존 동작)로 폴백한다.
 */
export function selectionIsSiblingRun(mf: MathfieldElement): boolean {
  try {
    const model = modelOf(mf);
    if (model === null) return true;
    const { ranges } = mf.selection;
    if (ranges.length !== 1) return false; // 셀별 다중 범위 선택
    let parent: InternalAtom | null | undefined;
    let branch: string | undefined;
    for (const atom of model.getAtoms(ranges[0])) {
      const b = JSON.stringify(atom.parentBranch ?? null);
      if (branch === undefined) {
        parent = atom.parent;
        branch = b;
      } else if (parent !== atom.parent || branch !== b) {
        return false;
      }
    }
    return true;
  } catch {
    return true;
  }
}
