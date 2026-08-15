import type { TypedExpr } from './expression/node';
import { toRealNumber } from './literal/literal';
import { asKnownInteger } from './expression/key';
import { fail, ok, type Result } from './result/result';
import { isScalar } from './shape/shape';

/**
 * 수치 평가기 — **재작성이 값을 바꾸지 않았는지 대조하는 용도**다.
 *
 * 이게 이 모듈의 "빈틈없음"을 만드는 핵심 장치다(설계 §10②). 심볼에 구체적인 수를 채워
 * 넣고 `evalNumeric(rewrite(e)) ≈ evalNumeric(e)` 를 확인하면, 교환법칙을 잘못 쓰거나
 * 인수 순서를 뒤집는 버그가 자동으로 드러난다. 사람이 눈으로 볼 수 없는 종류의 실수다.
 *
 * 값은 전부 `number[][]` (행 우선). 스칼라는 `[[x]]` — 모양 도메인과 같은 규약이다.
 */

export type Matrix = readonly (readonly number[])[];

const scalarValue = (m: Matrix): number | null =>
  m.length === 1 && m[0].length === 1 ? m[0][0] : null;

export type NumericBindings = Readonly<Record<string, Matrix>>;

const SCALAR_FNS: Record<string, (x: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  exp: Math.exp, ln: Math.log, log: Math.log10,
  sqrt: Math.sqrt, abs: Math.abs,
};

/**
 * 복소수를 봐야만 뜻이 서는 `call` 들 — 이 평가기는 실수만 담으므로(`Matrix` 는
 * `number[][]`) 퍼즈 대조에서 뺀다(`case 'call'` 참고).
 */
const COMPLEX_ONLY_CALLS = new Set(['Re', 'Im', 'conjugate', 'conj', 'dagger']);

const map2 = (a: Matrix, b: Matrix, f: (x: number, y: number) => number): Matrix =>
  a.map((row, i) => row.map((x, j) => f(x, b[i][j])));

const scale = (k: number, m: Matrix): Matrix => m.map((row) => row.map((x) => k * x));

function matMul(a: Matrix, b: Matrix): Matrix {
  return a.map((row) =>
    b[0].map((_, j) => row.reduce((sum, x, k) => sum + x * b[k][j], 0)),
  );
}

const transpose = (m: Matrix): Matrix => m[0].map((_, j) => m.map((row) => row[j]));

function trace(m: Matrix): Result<Matrix> {
  if (m.length !== m[0].length) return fail('shape-mismatch', 'tr needs a square matrix');
  let sum = 0;
  for (let i = 0; i < m.length; i += 1) sum += m[i][i];
  return ok([[sum]]);
}

/** 여인수 전개용 소행렬 — `i`행/`j`열을 뺀 나머지. */
function minor(m: Matrix, skipRow: number, skipCol: number): Matrix {
  return m.filter((_, i) => i !== skipRow).map((row) => row.filter((_, j) => j !== skipCol));
}

function determinantValue(m: Matrix): number {
  const n = m.length;
  if (n === 1) return m[0][0];
  if (n === 2) return m[0][0] * m[1][1] - m[0][1] * m[1][0];
  let det = 0;
  for (let j = 0; j < n; j += 1) {
    const sign = j % 2 === 0 ? 1 : -1;
    det += sign * m[0][j] * determinantValue(minor(m, 0, j));
  }
  return det;
}

function determinant(m: Matrix): Result<Matrix> {
  if (m.length !== m[0].length) return fail('shape-mismatch', 'det needs a square matrix');
  return ok([[determinantValue(m)]]);
}

/** 열/행 방향에 상관없이 벡터의 성분을 뽑는다. */
const components = (m: Matrix): number[] => m.flatMap((row) => [...row]);

export function evalNumeric(e: TypedExpr, assignment: NumericBindings): Result<Matrix> {
  switch (e.op) {
    case 'num': {
      // 복소수는 `Matrix`(number[][])에 담을 자리가 없다. 정직하게 거절하면 퍼즈가
      // 그 표본을 버린다 — 조용히 실수부만 쓰는 것보다 낫다.
      const value = toRealNumber(e.value);
      return value === null
        ? fail('unsupported', 'Numeric check does not cover complex numbers')
        : ok([[value]]);
    }

    case 'sym': {
      const value = assignment[e.name];
      return value === undefined
        ? fail('unknown-shape', `No value assigned to ${e.name}`)
        : ok(value);
    }

    case 'matIdentity': {
      const rows = e.shape.rows;
      if (typeof rows !== 'number') return fail('unknown-shape', 'Identity matrix has no known size');
      return ok(Array.from({ length: rows }, (_, i) => Array.from({ length: rows }, (_, j) => (i === j ? 1 : 0))));
    }

    case 'matrix': {
      const rows: number[][] = [];
      for (const row of e.rows) {
        const cells: number[] = [];
        for (const cell of row) {
          const v = evalNumeric(cell, assignment);
          if (!v.ok) return v;
          const s = scalarValue(v.value);
          if (s === null) return fail('shape-mismatch', 'A matrix entry must be a scalar');
          cells.push(s);
        }
        rows.push(cells);
      }
      return ok(rows);
    }

    case 'add': {
      let acc: Matrix | null = null;
      for (const term of e.terms) {
        const v = evalNumeric(term, assignment);
        if (!v.ok) return v;
        acc = acc === null ? v.value : map2(acc, v.value, (x, y) => x + y);
      }
      return acc === null ? fail('malformed', 'Empty sum') : ok(acc);
    }

    case 'neg': {
      const v = evalNumeric(e.operand, assignment);
      return v.ok ? ok(scale(-1, v.value)) : v;
    }

    case 'scalarMul': {
      let acc = 1;
      for (const f of e.factors) {
        const v = evalNumeric(f, assignment);
        if (!v.ok) return v;
        const s = scalarValue(v.value);
        if (s === null) return fail('shape-mismatch', 'scalarMul factor must be a scalar');
        acc *= s;
      }
      return ok([[acc]]);
    }

    case 'matMul': {
      const values: Matrix[] = [];
      for (const f of e.factors) {
        const v = evalNumeric(f, assignment);
        if (!v.ok) return v;
        values.push(v.value);
      }
      let acc = values[0];
      for (let i = 1; i < values.length; i += 1) {
        if (acc[0].length !== values[i].length) {
          return fail('shape-mismatch', 'Inner dimensions differ');
        }
        acc = matMul(acc, values[i]);
      }
      return ok(acc);
    }

    case 'mul': {
      const s = evalNumeric(e.scalar, assignment);
      if (!s.ok) return s;
      const m = evalNumeric(e.nonScalar, assignment);
      if (!m.ok) return m;
      const k = scalarValue(s.value);
      if (k === null) return fail('shape-mismatch', 'mul.scalar must be a scalar');
      return ok(scale(k, m.value));
    }

    case 'dot': {
      const l = evalNumeric(e.left, assignment);
      if (!l.ok) return l;
      const r = evalNumeric(e.right, assignment);
      if (!r.ok) return r;
      const a = components(l.value);
      const b = components(r.value);
      if (a.length !== b.length) return fail('shape-mismatch', 'Dot product length mismatch');
      return ok([[a.reduce((sum, x, i) => sum + x * b[i], 0)]]);
    }

    case 'cross': {
      const l = evalNumeric(e.left, assignment);
      if (!l.ok) return l;
      const r = evalNumeric(e.right, assignment);
      if (!r.ok) return r;
      const [a1, a2, a3] = components(l.value);
      const [b1, b2, b3] = components(r.value);
      const out = [a2 * b3 - a3 * b2, a3 * b1 - a1 * b3, a1 * b2 - a2 * b1];
      // 결과의 방향(열/행)은 왼쪽 피연산자를 따른다 — elaborate가 정한 모양과 같다.
      return ok(l.value.length === 1 ? [out] : out.map((x) => [x]));
    }

    case 'transpose': {
      const v = evalNumeric(e.operand, assignment);
      return v.ok ? ok(transpose(v.value)) : v;
    }

    case 'matPow': {
      // 지수가 상수 정수가 아니면 대조하지 않는다 (`A^n`). 정직하게 실패해야 퍼즈가
      // 그 표본을 버린다 — 값을 찍으면 대조 자체를 못 믿는다.
      const power = asKnownInteger(e.exponent);
      if (power === null) {
        return fail('unsupported', 'Numeric check needs a constant integer exponent');
      }
      if (power < 0) {
        // 역행렬은 일부러 뺐다. 이 평가기는 **대조용**이라, 특이행렬 처리와 수치 오차까지
        // 떠안으면 대조 자체를 믿기 어려워진다. 역행렬이 낀 식은 속성 테스트에서 건너뛴다.
        return fail('unsupported', 'Numeric check does not cover matrix inverses');
      }
      const v = evalNumeric(e.base, assignment);
      if (!v.ok) return v;
      const n = v.value.length;
      let acc: Matrix = Array.from({ length: n }, (_, i) =>
        Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
      );
      for (let i = 0; i < power; i += 1) acc = matMul(acc, v.value);
      return ok(acc);
    }

    case 'scalarPow': {
      const base = evalNumeric(e.base, assignment);
      if (!base.ok) return base;
      const exponent = evalNumeric(e.exponent, assignment);
      if (!exponent.ok) return exponent;
      const b = scalarValue(base.value);
      const x = scalarValue(exponent.value);
      if (b === null || x === null) return fail('shape-mismatch', 'scalarPow needs scalars');
      return ok([[Math.pow(b, x)]]);
    }

    case 'call': {
      // `det`/`tr` 은 인수가 행렬이라 아래 `SCALAR_FNS` 경로(스칼라 1인수)와 다르게
      // 직접 계산한다 — 퍼즈가 실제로 대조할 수 있게.
      if (e.name === 'det' || e.name === 'tr') {
        const m = evalNumeric(e.args[0], assignment);
        if (!m.ok) return m;
        return e.name === 'det' ? determinant(m.value) : trace(m.value);
      }
      // `Re`/`Im`/`conjugate`, 그리고 후위 켤레 `conj`(`^*`)/`dagger`(`^\dagger`) —
      // 값 도메인이 실수뿐이라(`Matrix` 는 `number[][]`) 대조하지 않는다. 복소수 리터럴
      // 자체를 이 평가기가 못 담는 것과 같은 이유(`case 'num'` 참고).
      if (COMPLEX_ONLY_CALLS.has(e.name)) {
        return fail('unsupported', `Numeric check does not cover ${e.name}`);
      }
      const fn = SCALAR_FNS[e.name];
      if (fn === undefined) return fail('unsupported', `No numeric definition for ${e.name}`);
      const arg = evalNumeric(e.args[0], assignment);
      if (!arg.ok) return arg;
      const x = scalarValue(arg.value);
      return x === null ? fail('shape-mismatch', 'Expected a scalar argument') : ok([[fn(x)]]);
    }

    // 사용자 정의 함수 호출 — 이 평가기가 대조하는 건 재작성 전후 값이지, 함수 정의를
    // 다시 해석해 값을 매기는 일이 아니다(`deriv`/`integral` 과 같은 이유, 아래 참고).
    // `foldFunctions`(`transform/evaluate.ts`)가 이미 전개했어야 정상이라 여기 남아
    // 있으면 그 자체가 미평가 상태라는 뜻이고, 대조할 값이 없다.
    case 'apply':
      return fail('unsupported', 'Numeric check does not cover unexpanded function calls');

    case 'frac': {
      const numerator = evalNumeric(e.numerator, assignment);
      if (!numerator.ok) return numerator;
      const denominator = evalNumeric(e.denominator, assignment);
      if (!denominator.ok) return denominator;
      const d = scalarValue(denominator.value);
      if (d === null) return fail('shape-mismatch', 'frac denominator must be a scalar');
      return ok(scale(1 / d, numerator.value));
    }

    // 미분·적분은 대조하지 않는다 — 이 평가기는 재작성 전후 값 대조 전용이고, 그 대조
    // 대상은 `evaluate` 가 CE로 위임하거나 원소별로 계산한 결과다. 별도로 재구현해
    // 대조하면 "값이 같다"는 확인이 아니라 "우리 구현 두 벌이 서로 같다"는 확인이 되어
    // 버그를 못 잡는다 — `matPow` 의 역행렬과 같은 이유로 정직하게 거절한다.
    case 'deriv':
      return fail('unsupported', 'Numeric check does not cover derivatives');
    case 'integral':
      return fail('unsupported', 'Numeric check does not cover integrals');

    case 'sum':
    case 'prod': {
      const lo = e.lower !== null ? asKnownInteger(e.lower) : null;
      const hi = e.upper !== null ? asKnownInteger(e.upper) : null;
      if (lo === null || hi === null) {
        return fail('unsupported', `Numeric check needs constant integer bounds for ${e.op}`);
      }
      if (lo > hi) {
        const rows = typeof e.shape.rows === 'number' ? e.shape.rows : 1;
        const cols = typeof e.shape.cols === 'number' ? e.shape.cols : 1;
        return ok(
          Array.from({ length: rows }, (_, i) =>
            Array.from({ length: cols }, (_, j) => (e.op === 'prod' && i === j ? 1 : 0)),
          ),
        );
      }
      let acc: Matrix | null = null;
      for (let i = lo; i <= hi; i += 1) {
        const v = evalNumeric(e.body, { ...assignment, [e.variable]: [[i]] });
        if (!v.ok) return v;
        acc = acc === null ? v.value : e.op === 'sum' ? map2(acc, v.value, (x, y) => x + y) : matMul(acc, v.value);
      }
      return ok(acc as Matrix);
    }
  }
}

/** 두 값이 (부동소수 오차를 감안해) 같은가. */
export function matricesClose(a: Matrix, b: Matrix, tolerance = 1e-9): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (row, i) =>
      row.length === b[i].length &&
      row.every((x, j) => Math.abs(x - b[i][j]) <= tolerance * Math.max(1, Math.abs(x))),
  );
}

/** 스칼라 결과를 꺼낸다 (테스트 편의). */
export const asScalar = (m: Matrix): number | null => scalarValue(m);

/** 이 식이 스칼라 모양인가 — 대조 전 확인용. */
export const isScalarExpr = (e: TypedExpr): boolean => isScalar(e.shape);
