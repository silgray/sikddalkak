import { asKnownInteger, exprKey } from '../expression/key';
import type { TypedExpr } from '../expression/node';

/**
 * `prettify`(`prettify.ts`) 가 쓰는 정렬 기준 — 사람이 읽기 좋은 순서.
 *
 * ⚠ **아직 실험 중이다.** `src/algebra/test/sort_add.ts` 에서 그대로 옮겨왔고,
 * `npm run algebra-test` 랩에서 계속 다듬일 자리다. `normalize/normalize.ts` 의
 * `sortTerms`/`sortScalars` 와 헷갈리지 말 것 — 그쪽은 **노드 동일성**(같은 값 ⇒ 같은
 * 트리)을 위한 정규 순서라 값을 바꾸면 동류항 판정이 깨진다. 여기는 값에 영향을 주지
 * 않는 **출력용 순서**다.
 */

export type SortKey = (a: TypedExpr, b: TypedExpr) => number;

/**
 * 노드 타입별 순위. **클수록 무겁고, 정렬 시 앞으로 온다.**
 *
 * 구조 노드(`add`/`neg`/`scalarMul`/`matMul`/`mul`/`matPow`/`scalarPow`)는 0 —
 * 자기 무게가 없고 자식에게서 물려받는다. `matPow`/`scalarPow` 가 여기 있는 덕에
 * "거듭제곱의 등급 = max(밑, 지수)" 가 예외 없이 일반 규칙에서 나온다.
 *
 * 값 사이 간격을 벌려둔 건 나중에 끼워넣기 쉬우라고. 절대값은 의미 없고 대소만 본다.
 */
const RANK: Record<TypedExpr['op'], number> = {
  // 큰 연산자 — 세로로 자리를 차지해서 식의 주인공처럼 보이는 것들
  sum: 100,
  prod: 100,
  integral: 100,
  deriv: 100,

  sym: 50,
  matIdentity: 50,

  call: 40,
  apply: 40,

  frac: 30,
  dot: 30,
  cross: 30,

  transpose: 20,

  num: 10,
  matrix: 10,

  // 구조 노드 — 자식에게서 물려받는다
  add: 0,
  neg: 0,
  mul: 0,
  scalarMul: 0,
  matMul: 0,
  matPow: 0,
  scalarPow: 0,
};

// cmp > 0: second is bigger
// cmp < 0: first is bigger
// cmp == 0: same
type GradeCmp = { readonly grade: number; readonly cmp: number };

/**
 * 직속 자식 노드들. 바운드 변수 이름·미분 차수처럼 식이 아닌 필드는 뺀다.
 *
 * `expression/traversal.ts` 의 `mapChildren` 과 겹쳐 보이지만 다른 것이다 — 저건 빌더로
 * 다시 조립하며 `Result`/모양 검사를 낸다. 여긴 그냥 읽기만 하는 접근자라 훨씬 가볍다.
 * 두 번째 소비자가 생기기 전까진 여기 둔다.
 */
function children(e: TypedExpr): readonly TypedExpr[] {
  switch (e.op) {
    case 'num':
    case 'sym':
    case 'matIdentity':
      return [];
    case 'matrix':
      return e.rows.flat();
    case 'add':
      return e.terms;
    case 'neg':
    case 'transpose':
      return [e.operand];
    case 'scalarMul':
    case 'matMul':
      return e.factors;
    case 'mul':
      return [e.scalar, e.nonScalar];
    case 'dot':
    case 'cross':
      return [e.left, e.right];
    case 'matPow':
    case 'scalarPow':
      return [e.base, e.exponent];
    case 'call':
    case 'apply':
      return e.args;
    case 'frac':
      return [e.numerator, e.denominator];
    case 'deriv':
      return [e.body];
    case 'sum':
    case 'prod':
    case 'integral':
      return [e.body, ...(e.lower ? [e.lower] : []), ...(e.upper ? [e.upper] : [])];
  }
}

/**
 * 서브트리 전체의 무게. `rank` 는 등장하는 노드 중 가장 무거운 것의 순위,
 * `count` 는 그 순위에 해당하는 노드의 개수.
 *
 * `count` 가 필요한 이유: `\sin(\int h)` 와 `(\int f)^{\sum a^n x}` 는 최대 등급이
 * 같아서 `rank` 만으로는 안 갈린다. 개수를 보면 1 vs 2 로 갈린다.
 */
type Grade = { readonly rank: number; readonly count: number };

/**
 * TypedExpr 원본을 건드리지 않고 곁다리로 붙이는 방식. 노드가 불변이라
 * 참조를 키로 캐싱해도 안전하고, 노드가 버려지면 항목도 같이 사라진다.
 * 구조는 같지만 객체가 다른 두 노드는 각각 계산되는데, 결과가 같으니 상관없다.
 */
const cache = new WeakMap<TypedExpr, Grade>();

function gradeOf(e: TypedExpr): Grade {
  const hit = cache.get(e);
  if (hit !== undefined) return hit;

  const own = RANK[e.op];
  let rank = own;
  let count = own > 0 ? 1 : 0;

  for (const child of children(e)) {
    const g = gradeOf(child);
    if (g.rank > rank) {
      rank = g.rank;
      count = g.count;
    } else if (g.rank === rank) {
      count += g.count;
    }
  }

  const grade: Grade = { rank, count };
  cache.set(e, grade);
  return grade;
}

/**
 * 정렬 1층. 무거운 쪽이 먼저, 같으면 개수 많은 쪽이 먼저.
 * 순수 상수항은 `rank` 가 `num` 이라 자연히 맨 뒤로 간다.
 *
 * 0 을 돌려주면 "이 층에서는 안 갈렸다" 는 뜻 — 호출부가 다음 층으로 내려간다.
 */
function compareGrade(a: TypedExpr, b: TypedExpr): GradeCmp {
  const ga = gradeOf(a);
  const gb = gradeOf(b);
  if (ga.rank !== gb.rank) {
    return { grade: 0, cmp: gb.rank - ga.rank };
  }
  return { grade: gb.rank, cmp: 0 };
}

/**
 * 정렬 2층
 */
type AtomPower = { readonly atom: TypedExpr; readonly exponent: number };

/** 곱셈 구조를 뚫고 (원자, 지수) 목록으로. 지수가 상수 정수일 때만 pow를 뚫는다. */
function decomposeFactors(e: TypedExpr): readonly AtomPower[] {
  switch (e.op) {
    case 'num':
      return [];
    case 'neg':
      return decomposeFactors(e.operand);
    case 'scalarMul':
    case 'matMul':
      return e.factors.flatMap(decomposeFactors);
    case 'mul':
      return [...decomposeFactors(e.scalar), ...decomposeFactors(e.nonScalar)];
    case 'scalarPow':
    case 'matPow': {
      const n = asKnownInteger(e.exponent);
      if (n === null) return [{ atom: e, exponent: 1 }];
      return decomposeFactors(e.base).map((ap) => ({
        atom: ap.atom,
        exponent: ap.exponent * n,
      }));
    }
    default:
      return [{ atom: e, exponent: 1 }];
  }
}

function isPow(e: TypedExpr): e is Extract<TypedExpr, { op: 'scalarPow' | 'matPow' }> {
  return e.op === 'scalarPow' || e.op === 'matPow';
}

/** 투명 노드(pow/neg)를 뚫은 대표 타입 순위. */
function headRank(e: TypedExpr): number {
  if (isPow(e)) return Math.max(headRank(e.base), headRank(e.exponent));
  if (e.op === 'neg') return headRank(e.operand);
  return RANK[e.op];
}

function headName(e: TypedExpr): string {
  if (e.op === 'sym') return e.name;
  if (e.op === 'call' || e.op === 'apply') return e.name;
  return e.op;
}

/** 원자끼리의 전순서. 음수면 a가 먼저. */
function compareAtoms(a: TypedExpr, b: TypedExpr): number {
  if (a === b) return 0;

  const ga = gradeOf(a);
  const gb = gradeOf(b);
  if (ga.rank !== gb.rank) return gb.rank - ga.rank;
  if (ga.count !== gb.count) return gb.count - ga.count;

  // 지수가 밑보다 의미적으로 우세 — a^{\sum} 이 (\sum)^a 보다 먼저
  const ap = isPow(a);
  const bp = isPow(b);
  if (ap && bp) {
    const ea = gradeOf(a.exponent);
    const eb = gradeOf(b.exponent);
    if (ea.rank !== eb.rank) return eb.rank - ea.rank;
    const byBase = compareAtoms(a.base, b.base);
    if (byBase !== 0) return byBase;
    return compareAtoms(a.exponent, b.exponent);
  }
  if (ap) return compareAtoms(a.base, b) || -1;
  if (bp) return compareAtoms(a, b.base) || 1;

  const ra = headRank(a);
  const rb = headRank(b);
  if (ra !== rb) return rb - ra;

  const na = headName(a);
  const nb = headName(b);
  if (na !== nb) return na.localeCompare(nb);

  const ca = children(a);
  const cb = children(b);
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const c = compareAtoms(ca[i], cb[i]);
    if (c !== 0) return c;
  }
  return cb.length - ca.length;
}

const factorCache = new WeakMap<TypedExpr, readonly AtomPower[]>();

/** 축 순서로 정렬. */
function normalizedFactors(e: TypedExpr): readonly AtomPower[] {
  const hit = factorCache.get(e);
  if (hit !== undefined) return hit;

  const out = [...decomposeFactors(e)].sort((p, q) => compareAtoms(p.atom, q.atom));
  factorCache.set(e, out);
  return out;
}

/** grlex — 합친 축 위에서 지수 벡터 사전순. 없는 축은 지수 0. */
function compareMonomials(a: TypedExpr, b: TypedExpr): number {
  const fa = normalizedFactors(a);
  const fb = normalizedFactors(b);

  let i = 0;
  let j = 0;
  while (i < fa.length && j < fb.length) {
    const c = compareAtoms(fa[i].atom, fb[j].atom);
    if (c !== 0) return c;
    if (fa[i].exponent !== fb[j].exponent) return fb[j].exponent - fa[i].exponent;
    i++;
    j++;
  }
  return (fb.length - j) - (fa.length - i);
}

function totalDegree(e: TypedExpr): number {
  return normalizedFactors(e)
    .filter((s) => s.atom.op !== 'num')
    .reduce((s, ap) => s + ap.exponent, 0);
}

/**
 *   1. compareGrade
 *   2. 총차수 내림차순
 *   3. 원자 축 위 지수 벡터 사전순 (grlex)
 *   4. 비가환 인수 열 비교 — TODO, 지금은 5로 폴백
 *   5. exprKey 사전순 — 전순서 보장용 폴백
 */
export function compareTerms(a: TypedExpr, b: TypedExpr): number {
  const byGrade = compareGrade(a, b);
  if (byGrade.cmp !== 0) return byGrade.cmp;

  const byDegree = totalDegree(b) - totalDegree(a);
  if (byDegree !== 0) return byDegree;

  const byMonomial = compareMonomials(a, b);
  if (byMonomial !== 0) return byMonomial;

  // TODO: 4층 — decomposeFactors 결과 재사용
  return exprKey(a).localeCompare(exprKey(b));
}

/* ============== multiply key =============== */

function getMulKeyValue(expr: TypedExpr): string {
  if (expr.op === 'sym') {
    return expr.name;
  }
  if (expr.op === 'scalarPow') {
    return getMulKeyValue(expr.base);
  }
  return '';
}

export function compareScalars(a: TypedExpr, b: TypedExpr): number {
  return getMulKeyValue(a).localeCompare(getMulKeyValue(b));
}

export const PRETTY_ORDER: { readonly compareTerms: SortKey; readonly compareFactors: SortKey } =
  { compareTerms, compareFactors: compareScalars };
