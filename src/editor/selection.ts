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
 * `siblingRunRange` 와 `caretRunRange` 의 공통 뼈대.
 *
 * MathLive의 선택은 atom 트리를 평탄하게 훑은 정수 오프셋이라, 서로 다른 부모의
 * atom을 걸치는 구간도 표현할 수 있다. 그런 구간은 부분식이 아니고(LaTeX로 뽑으면
 * 행렬 셀 구분이 사라진다), 렌더도 층층이 겹친 박스로 어긋난다. 그래서 양 끝의
 * 문맥 사슬에서 **최초 공통 문맥**을 찾아 그 레벨의 형제 경계로 스냅한다.
 *
 * 두 공개 함수의 차이는 **끝을 어느 쪽으로 스냅하느냐 하나뿐**이다(`shrinkEnd`).
 * 시작은 언제나 바깥(왼쪽)으로 넓힌다 — 첨자 보정도 왼쪽으로 넓히는 방향이라
 * 둘이 같은 뼈대를 쓸 수 있다.
 */
function runRange(
  model: InternalModel,
  a0: number,
  b0: number,
  shrinkEnd: boolean,
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

  /** offset에서 `dir` 방향으로 가장 가까운 common 형제 경계. 없으면 null. */
  const boundaryFrom = (offset: number, dir: -1 | 1): number | null => {
    for (let q = offset; q >= 0 && q <= model.lastOffset; q += dir) {
      if (inCtx(model.at(q), common)) return q;
    }
    return null;
  };

  // 시작: a 이하의 가장 가까운 형제 경계 (a가 어떤 형제의 내부면 그 형제 앞까지 넓힌다).
  let lo = boundaryFrom(a, -1) ?? whole[0];
  let hi: number;
  if (shrinkEnd) {
    // 끝을 **안쪽으로** 당긴다 — b가 어떤 형제의 내부면 그 형제를 통째로 뺀다.
    const shrunk = boundaryFrom(b, -1);
    // 당긴 결과가 시작을 넘어서 아무 것도 안 남으면, 그 끝만 확장으로 되돌린다.
    // (드래그 상태를 안 보는 순수 폴백이라 같은 입력이면 늘 같은 출력이다.)
    hi = shrunk !== null && shrunk > lo ? shrunk : (boundaryFrom(b, 1) ?? whole[1]);
  } else {
    // 끝: b 이상의 가장 가까운 형제 경계 (b가 내부면 그 형제 끝까지 넓힌다).
    hi = boundaryFrom(b, 1) ?? whole[1];
  }

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
 * **선택 불변식의 핵심**: [a,b]를 **포함하는** 최소한의 "한 문맥 연속 형제 열".
 *
 * 성질: 멱등(이미 정규형이면 그대로) · **포함(원래 범위를 잃지 않음)** · 결정적.
 * `normalizeSelection` 게이트가 이걸 쓴다 — MathLive가 만든 선택까지 여기를 지나므로
 * **절대 좁히면 안 된다**(좁히면 게이트가 멀쩡한 선택을 지운다). 손가락으로 만든
 * 선택을 파생할 때는 `caretRunRange` 쪽이다.
 */
export function siblingRunRange(
  model: InternalModel,
  a0: number,
  b0: number,
): [number, number] | null {
  return runRange(model, a0, b0, false);
}

/**
 * **원시 캐럿 두 개에서 화면 선택을 파생**한다 (`editor/rawSelection.ts`).
 *
 * `siblingRunRange` 와 최소 공통 부모까지는 같고, **끝을 안쪽으로 당기는** 것만
 * 다르다 — 끝 캐럿이 어떤 자식 *안*에 있으면 그 자식은 선택에서 **뺀다**. 그래야
 * 분모 안에서 잡은 선택을 오른쪽으로 조금 끌었을 때 분수가 통째로 삼켜지지 않는다.
 *
 * ⚠ **비대칭이 의도다.** 시작 캐럿은 여전히 바깥으로 넓힌다 — 양끝을 다 당기면
 * "온전히 들어온 자식이 하나도 없는" 상태가 잦아져 드래그 도중 선택이 자주 깜빡인다
 * (설계 논의에서 실제로 걸렸다). 지금은 양끝이 **둘 다 자기 이하의 가장 가까운
 * 경계**로 스냅한다.
 *
 * 결과는 유효한 형제 열이라 `normalizeSelection`(=`siblingRunRange`)을 **멱등하게**
 * 통과한다 — 게이트가 우리 결과를 되돌려 놓지 않는다.
 */
export function caretRunRange(
  model: InternalModel,
  a0: number,
  b0: number,
): [number, number] | null {
  return runRange(model, a0, b0, true);
}

/** 덧셈 경계가 되는 연산자인지 (`+`/`-`만; `\cdot`·`\times`는 곱셈이라 항 안에 남는다). */
export function isAdditiveOp(atom: InternalAtom | undefined): boolean {
  return atom?.type === 'mbin' && (atom.command === '+' || atom.command === '-');
}

/**
 * [a,b]를 포함하는 최소 "곱셈 항" 형제 run. `siblingRunRange`와 같은 문맥에서 돌되
 * `+`/`-` 형제를 **경계로** 삼아 넘지 않는다 (`1+xy`의 `xy`, `1` 처럼).
 *
 * ⚠ `siblingRunRange`(선택 정규화 게이트)와 별개다 — 드래그 선택까지 항 경계로
 * 강제하면 안 되므로, 이건 Ctrl+D 확장·괄호 감싸기에서만 쓴다. 항 run도 유효한
 * 형제 run이라 이후 `normalizeSelection`을 멱등하게 통과한다.
 */
export function termRunRange(
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

  // 왼쪽: a 이하 가장 가까운 형제 경계에서 시작해, 왼쪽 atom이 덧셈 연산자가
  // 아닌 동안 계속 왼쪽으로 넓힌다 (덧셈 연산자를 만나면 그 앞에서 멈춘다).
  let lo: number | null = null;
  for (let q = a; q >= 0; q -= 1) {
    if (inCtx(model.at(q), common)) {
      lo = q;
      break;
    }
  }
  if (lo === null) return null;
  for (;;) {
    if (isAdditiveOp(model.at(lo))) break; // lo 왼쪽 atom이 덧셈 연산자 — 포함 안 함
    const prev = prevSiblingBoundary(model, common, lo);
    if (prev === null) break;
    lo = prev;
  }

  // 오른쪽: b 이상 가장 가까운 형제 경계에서, 오른쪽 atom이 덧셈 연산자가 아닌
  // 동안 계속 오른쪽으로 넓힌다.
  let hi: number | null = null;
  for (let q = b; q <= model.lastOffset; q += 1) {
    if (inCtx(model.at(q), common)) {
      hi = q;
      break;
    }
  }
  if (hi === null) return null;
  for (;;) {
    const next = nextSiblingBoundary(model, common, hi);
    if (next === null) break;
    if (isAdditiveOp(model.at(next))) break; // hi 오른쪽 atom이 덧셈 연산자
    hi = next;
  }
  return [lo, hi];
}

/**
 * 현재 선택을 형제 열 불변식에 맞게 교정한다. 바꿨으면 true.
 * 선택이 만들어지는 **모든 경로**(드래그·shift+화살표·Ctrl+D·더블클릭·Ctrl+A·
 * 실행취소 복구)가 selection-change를 거치므로, 거기서 이 함수만 부르면 된다.
 */
/**
 * 정규화를 잠시 멈춘다. 구조 편집 연산(keyOps)은 자기가 원하는 범위를 정확히
 * 알고 선택하므로, 게이트가 그 선택을 다시 넓히면 안 된다 — 실제로 첨자 보정
 * 규칙이 `e^1`의 첨자 치환 범위를 밑까지 넓혀 `e`를 삼킨 적이 있다.
 */
let normalizationSuspended = 0;
export function suspendNormalization<T>(fn: () => T): T {
  normalizationSuspended += 1;
  try {
    return fn();
  } finally {
    normalizationSuspended -= 1;
  }
}

export function normalizeSelection(mf: MathfieldElement): boolean {
  try {
    if (normalizationSuspended > 0) return false;
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

/** offset이 속한 branch 내용 전체의 [시작, 끝]. (첨자 내용, 분모 내용 등) */
export function branchRangeAt(model: InternalModel, offset: number): [number, number] | null {
  const ctx = ctxAt(model, offset);
  return ctx === null ? null : branchRange(model, ctx);
}

/**
 * atom 하나가 차지하는 [시작, 끝] 오프셋. 끝은 `offsetOf`, 시작은 같은 문맥의
 * 이전 형제 경계다 (첫 형제면 branch 시작). 편집 연산이 "이 atom을 통째로
 * 다른 내용으로 치환"할 때 쓴다.
 */
export function atomBounds(model: InternalModel, atom: InternalAtom): [number, number] | null {
  const end = model.offsetOf(atom);
  if (end < 0) return null;
  const ctx: SiblingCtx = {
    parent: atom.parent ?? null,
    branch: JSON.stringify(atom.parentBranch ?? null),
  };
  const prev = prevSiblingBoundary(model, ctx, end);
  if (prev !== null) return [prev, end];
  const whole = branchRange(model, ctx);
  return whole === null ? null : [whole[0], end];
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

/** 캐럿 옆(왼쪽 우선, 없으면 오른쪽)의 atom 하나가 차지하는 범위. 없으면 null. */
function caretUnitRange(model: InternalModel, pos: number): [number, number] | null {
  const left = model.at(pos);
  if (left !== undefined && left.type !== 'first') {
    const b = atomBounds(model, left);
    if (b !== null) return b;
  }
  const right = model.at(pos + 1);
  if (right !== undefined && right.type !== 'first') {
    const b = atomBounds(model, right);
    if (b !== null) return b;
  }
  return null;
}

/**
 * Ctrl+D: 의미 단위 선택 확장. 한 번 누를 때 사다리를 한 칸 올라간다:
 *   원자 → 곱셈 항(`+`/`-` 앞에서 멈춤) → branch 내용 전체 → 소유 atom(한 레벨 위) → …
 * 각 단계는 "현재보다 큰 가장 작은 후보"라 오름차순·멱등이다. `+`가 없는 식은
 * 항 == branch라 항 단계가 자연히 접혀(추가 누름 없음) 회귀가 없다.
 * 예: `1+xy`에서 `y`(또는 캐럿) → `xy` → `1+xy` → (root면 끝).
 */
export function expandSelectionSemantic(mf: MathfieldElement): void {
  const model = modelOf(mf);
  if (model === null) return;

  if (mf.selectionIsCollapsed) {
    // 가장 작은 단위(캐럿 옆 원자)부터. 원자가 없으면 branch 내용으로 폴백.
    const unit = caretUnitRange(model, model.position);
    if (unit !== null) {
      setSelectionRange(mf, unit[0], unit[1]);
      return;
    }
    const ctx = ctxAt(model, model.position);
    const range = ctx === null ? null : branchRange(model, ctx);
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

  // 항 단계: 선택보다 크고 branch보다 작은 곱셈 항이 있으면 거기로 먼저.
  const term = termRunRange(model, a, b);
  if (
    term !== null &&
    (term[0] < a || term[1] > b) &&
    !(term[0] === range[0] && term[1] === range[1])
  ) {
    setSelectionRange(mf, term[0], term[1]);
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
