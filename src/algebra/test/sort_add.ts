import { type TypedExpr } from "../index";

type SortKey = (a: TypedExpr, b: TypedExpr) => number;

function mapAll(
  xs: readonly TypedExpr[],
  f: (x: TypedExpr) => TypedExpr,
): readonly TypedExpr[] {
  let changed = false;
  const out = xs.map((x) => {
    const y = f(x);
    if (y !== x) changed = true;
    return y;
  });
  return changed ? out : xs;
}

/** 자식 정리 후 정렬. 내용도 순서도 그대로면 입력 배열을 그대로 돌려준다. */
function mapAndSort(
  xs: readonly TypedExpr[],
  f: (x: TypedExpr) => TypedExpr,
  key: SortKey,
): readonly TypedExpr[] {
  const next = mapAll(xs, f);
  const sorted = next.toSorted(key);
  return sorted.every((x, i) => x === next[i]) ? next : sorted;
}

export function prettify(e: TypedExpr, addKey: SortKey, mulKey: SortKey): TypedExpr;
export function prettify(e: null, addKey: SortKey, mulKey: SortKey): null;
export function prettify(
  e: TypedExpr | null,
  addKey: SortKey,
  mulKey: SortKey,
): TypedExpr | null;
export function prettify(
  e: TypedExpr | null,
  addKey: SortKey,
  mulKey: SortKey,
): TypedExpr | null {
  if (e === null) return null;
  const go = (x: TypedExpr) => prettify(x, addKey, mulKey);

  switch (e.op) {
    case 'num':
    case 'sym':
    case 'matIdentity':
      return e;

    case 'matrix': {
      let changed = false;
      const rows = e.rows.map((row) => {
        const next = mapAll(row, go);
        if (next !== row) changed = true;
        return next;
      });
      return changed ? { ...e, rows } : e;
    }

    case 'neg':
    case 'transpose': {
      const operand = go(e.operand);
      return operand === e.operand ? e : { ...e, operand };
    }

    case 'matMul': {
      const factors = mapAll(e.factors, go);
      return factors === e.factors ? e : { ...e, factors };
    }

    case 'mul': {
      const scalar = go(e.scalar);
      const matrix = go(e.matrix);
      return scalar === e.scalar && matrix === e.matrix ? e : { ...e, scalar, matrix };
    }

    case 'dot':
    case 'cross': {
      const left = go(e.left);
      const right = go(e.right);
      return left === e.left && right === e.right ? e : { ...e, left, right };
    }

    case 'matPow':
    case 'scalarPow': {
      const base = go(e.base);
      const exponent = go(e.exponent);
      return base === e.base && exponent === e.exponent ? e : { ...e, base, exponent };
    }

    case 'call':
    case 'apply': {
      const args = mapAll(e.args, go);
      return args === e.args ? e : { ...e, args };
    }

    case 'frac': {
      const numerator = go(e.numerator);
      const denominator = go(e.denominator);
      return numerator === e.numerator && denominator === e.denominator
        ? e
        : { ...e, numerator, denominator };
    }

    case 'deriv': {
      const body = go(e.body);
      return body === e.body ? e : { ...e, body };
    }

    case 'sum':
    case 'prod':
    case 'integral': {
      const body = go(e.body);
      const lower = prettify(e.lower, addKey, mulKey);
      const upper = prettify(e.upper, addKey, mulKey);
      return body === e.body && lower === e.lower && upper === e.upper
        ? e
        : { ...e, body, lower, upper };
    }

    case 'add': {
      console.log("before comp", e.terms);
      const terms = mapAndSort(e.terms, go, addKey);
      console.log("after comp", terms);
      return terms === e.terms ? e : { ...e, terms };
    }

    case 'scalarMul': {
      console.log("before comp", e.factors);
      const factors = mapAndSort(e.factors, go, mulKey);
      console.log("after comp", factors);
      return factors === e.factors ? e : { ...e, factors };
    }
  }
}


/* =================================== */

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
type GradeCmp = { readonly grade: number, readonly cmp: number};

/** 직속 자식 노드들. 바운드 변수 이름·미분 차수처럼 식이 아닌 필드는 뺀다. */
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
      return [e.scalar, e.matrix];
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
    return {grade: 0, cmp: gb.rank - ga.rank};
  }
  return {grade: gb.rank, cmp: 0};
}

/**
 * 정렬 2층
 */
type AtomPower = { readonly atom: TypedExpr; readonly exponent: number };

function constIntExponent(e: TypedExpr): number | null {
  if (e.op === 'num') {
    const v = Number(e.value);
    return Number.isInteger(v) ? v : null;
  }
  if (e.op === 'neg') {
    const n = constIntExponent(e.operand);
    return n === null ? null : -n;
  }
  return null;
}

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
      return [...decomposeFactors(e.scalar), ...decomposeFactors(e.matrix)];
    case 'scalarPow':
    case 'matPow': {
      const n = constIntExponent(e.exponent);
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

const degreeCache = new WeakMap<TypedExpr, number>();

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

/** 축 순서로 정렬 + 같은 원자 지수 합산. */
function normalizedFactors(e: TypedExpr): readonly AtomPower[] {
  const hit = factorCache.get(e);
  if (hit !== undefined) return hit;

  const sorted = decomposeFactors(e).toSorted((p, q) => compareAtoms(p.atom, q.atom));
  const out: AtomPower[] = [];
  for (const ap of sorted) {
    const last = out.at(-1);
    if (last !== undefined && compareAtoms(last.atom, ap.atom) === 0) {
      out[out.length - 1] = { atom: last.atom, exponent: last.exponent + ap.exponent };
    } else {
      out.push(ap);
    }
  }
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
  return normalizedFactors(e).reduce((s, ap) => s + ap.exponent, 0);
}

/**
 *   1. compareGrade (done)
 *   2. 총차수 내림차순
 *   3. 원자 축 위 지수 벡터 사전순 (grlex)
 *   4. 비가환 인수 열 비교
 *   5. exprKey 사전순 — 전순서 보장용 폴백
 */
export function compareTerms(a: TypedExpr, b: TypedExpr): number {
  // 1. compareGrade
  const byGrade = compareGrade(a, b);
  if (byGrade.cmp !== 0) return byGrade.cmp;

  // 2. polynomial 내림차순 정렬
  const byDegree = totalDegree(b) - totalDegree(a);
  if (byDegree !== 0) return byDegree;

  const byMonomial = compareMonomials(a, b);
  if (byMonomial !== 0) return byMonomial;

  // TODO: 4층 — decomposeFactors 결과 재사용
  return exprKey(a).localeCompare(exprKey(b));
}

function exprKey(e: TypedExpr): string {
  return "";
}


/* ============== multiply key =============== */

function getMulKeyValue(expr: TypedExpr): string {
  if(expr.op === "sym") {
    return expr.name;
  }
  if(expr.op === 'scalarPow') {
    return getMulKeyValue(expr.base);
  }
  return "";
}

export function compareScalars(a: TypedExpr, b: TypedExpr): number {
  return getMulKeyValue(a).localeCompare(getMulKeyValue(b));
}

export const sort_keys = [
    {termKey: compareTerms, mulKey: compareScalars},
];