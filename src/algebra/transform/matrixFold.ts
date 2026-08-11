import { ComputeEngine } from '@cortex-js/compute-engine';
import type { MathJsonExpression } from '@cortex-js/compute-engine';
import { addTyped, elaborate, mulTyped } from '../parse/elaborate';
import { parseCeJson } from '../parse/parseSymbol';
import { render } from '../render';
import { toCeJson } from '../literalMath';
import { constantInteger } from '../parse/normal';
import { guardCe } from '../ceLimit';
import { ok, type Result } from '../result/result';
import { SCALAR } from '../shape/shape';
import type { TypedExpr, Env } from '../types-TypedExpr';

/**
 * 구체 행렬 산술 — 리터럴 행렬끼리의 덧셈·곱셈·거듭제곱·전치·내적·외적을 값으로 접는다.
 *
 * `simplify`가 CE로 위임하는 건 **순수 스칼라뿐**이다(`isPureScalar`, [rewrite.ts:49]).
 * 행렬은 우리 도메인이라 CE에 통째로 안 넘기기로 했으니, 리터럴끼리의 산술은 직접 한다.
 * 셀은 TypedExpr 그대로 다뤄 정확한 유리수를 보존한다 — 부동소수로 안 뭉갠다. 각 셀의
 * 실제 계산(예: `1+2`)은 여기서 안 하고 **뒤따르는 `simplify`에 맡긴다** — `matrix` 노드를
 * 다시 훑으며 순수 스칼라 셀을 CE로 접어주므로, 여기서 중복으로 할 이유가 없다.
 *
 * 예외: **역행렬**은 CE에 위임한다(`invertLiteral`) — 정확한 유리수 가우스-조던 +
 * 특이행렬 판정을 다시 만들 이유가 없다. `A^{-1}` 을 LaTeX으로 만들어 다시 파싱하면
 * `Inverse` 머리가 되는데, **`Inverse` 는 `.evaluate()`로 안 풀린다**(CE 0.90 실측).
 * `Power(M,-1)` MathJSON을 직접 박싱해야 실제로 계산된다.
 */

type MatrixLiteral = Extract<TypedExpr, { op: 'matrix' }>;

const isMatrixLiteral = (e: TypedExpr): e is MatrixLiteral => e.op === 'matrix';

/** 행/열 벡터든 상관없이 성분을 한 줄로 편다 (`numeric.ts`의 `components`와 같은 규약). */
const components = (m: MatrixLiteral): readonly TypedExpr[] => m.rows.flatMap((row) => row);

const negScalar = (e: TypedExpr): TypedExpr => ({ op: 'neg', shape: SCALAR, operand: e });

function addMatrixLiterals(a: MatrixLiteral, b: MatrixLiteral): Result<MatrixLiteral> {
  const rows: TypedExpr[][] = [];
  for (let i = 0; i < a.rows.length; i += 1) {
    const row: TypedExpr[] = [];
    for (let j = 0; j < a.rows[i].length; j += 1) {
      const sum = addTyped([a.rows[i][j], b.rows[i][j]]);
      if (!sum.ok) return sum;
      row.push(sum.value);
    }
    rows.push(row);
  }
  return ok({ op: 'matrix', shape: a.shape, rows });
}

function mulMatrixLiterals(a: MatrixLiteral, b: MatrixLiteral): Result<MatrixLiteral> {
  const inner = a.rows[0].length;
  const rows: TypedExpr[][] = [];
  for (let i = 0; i < a.rows.length; i += 1) {
    const row: TypedExpr[] = [];
    for (let j = 0; j < b.rows[0].length; j += 1) {
      const terms: TypedExpr[] = [];
      for (let k = 0; k < inner; k += 1) {
        const prod = mulTyped(a.rows[i][k], b.rows[k][j]);
        if (!prod.ok) return prod;
        terms.push(prod.value);
      }
      const sum = addTyped(terms);
      if (!sum.ok) return sum;
      row.push(sum.value);
    }
    rows.push(row);
  }
  return ok({ op: 'matrix', shape: { rows: a.shape.rows, cols: b.shape.cols }, rows });
}

function scaleMatrixLiteral(scalar: TypedExpr, m: MatrixLiteral): Result<MatrixLiteral> {
  const rows: TypedExpr[][] = [];
  for (const row of m.rows) {
    const newRow: TypedExpr[] = [];
    for (const cell of row) {
      const prod = mulTyped(scalar, cell);
      if (!prod.ok) return prod;
      newRow.push(prod.value);
    }
    rows.push(newRow);
  }
  return ok({ op: 'matrix', shape: m.shape, rows });
}

function transposeLiteral(m: MatrixLiteral): MatrixLiteral {
  const rows: TypedExpr[][] = [];
  for (let j = 0; j < m.rows[0].length; j += 1) {
    rows.push(m.rows.map((row) => row[j]));
  }
  return { op: 'matrix', shape: { rows: m.shape.cols, cols: m.shape.rows }, rows };
}

function dotLiteral(a: MatrixLiteral, b: MatrixLiteral): Result<TypedExpr> {
  const av = components(a);
  const bv = components(b);
  const terms: TypedExpr[] = [];
  for (let i = 0; i < av.length; i += 1) {
    const prod = mulTyped(av[i], bv[i]);
    if (!prod.ok) return prod;
    terms.push(prod.value);
  }
  return addTyped(terms);
}

/** `numeric.ts`의 `cross`와 같은 공식 — 방향(행/열)은 왼쪽 피연산자를 따른다. */
function crossLiteral(a: MatrixLiteral, b: MatrixLiteral): Result<MatrixLiteral> {
  const av = components(a);
  const bv = components(b);
  const term = (i: number, j: number, k: number, l: number): Result<TypedExpr> => {
    const p1 = mulTyped(av[i], bv[j]);
    if (!p1.ok) return p1;
    const p2 = mulTyped(av[k], bv[l]);
    if (!p2.ok) return p2;
    return addTyped([p1.value, negScalar(p2.value)]);
  };
  const c0 = term(1, 2, 2, 1);
  if (!c0.ok) return c0;
  const c1 = term(2, 0, 0, 2);
  if (!c1.ok) return c1;
  const c2 = term(0, 1, 1, 0);
  if (!c2.ok) return c2;
  const cells = [c0.value, c1.value, c2.value];
  const rows = a.shape.rows === 1 ? [cells] : cells.map((c) => [c]);
  return ok({ op: 'matrix', shape: a.shape, rows });
}

// ---------------------------------------------------------------------------
// 역행렬 — CE 위임
// ---------------------------------------------------------------------------

/** 이 파일 전용 CE 인스턴스 — 모듈이 자립하도록 (버전 격리 규칙, `parseSymbol.ts`와 같은 관례). */
const ce = new ComputeEngine();

/**
 * 되돌아온 결과를 다시 읽을 때 쓰는 env. 행렬 셀은 `elaborate` 규칙상 반드시
 * 스칼라이므로, "미지 심볼은 스칼라" 라는 기본 가정이 여기선 정확하다.
 */
const EMPTY_ENV: Env = { shapes: {} };

/**
 * 역행렬을 시도할 최대 크기. 정확한 상한이 있는 게 아니라 **폭주 방지용**이다 —
 * 심볼 원소 행렬의 여인수 전개는 `n!` 로 커져서, 상한이 없으면 큰 행렬 하나가
 * 셀 평가를 통째로 멈춰 세운다. 항이 많아 보이는 것 자체는 문제가 아니다:
 * 뒤따르는 `simplify` 가 각 셀의 순수 스칼라 부분식을 CE로 접는다.
 */
const MAX_SYMBOLIC_INVERSE_SIZE = 8;

/**
 * 행렬 셀 하나를 MathJSON으로. 못 바꾸면 `null`.
 *
 * 숫자 셀은 `toCeJson` 으로 직접 옮긴다 — 정확한 유리수가 보존된다. 심볼이 섞인
 * 셀은 `render` 로 LaTeX을 만들어 CE에 다시 파싱시킨다. 여기서는 **캐노니컬 파싱**을
 * 쓴다(`form:['Number']` 를 안 준다) — 축소 정규화 폼이 막으려던 건 곱셈 인자의
 * 비가환 재배열인데, 행렬 셀은 반드시 스칼라라 그 위험이 애초에 없다.
 */
function cellToJson(cell: TypedExpr): MathJsonExpression | null {
  if (cell.op === 'num') return toCeJson(cell.value);
  const parsed = ce.parse(render(cell));
  return parsed.isValid ? parsed.json : null;
}

function matrixLiteralToJson(m: MatrixLiteral): MathJsonExpression | null {
  const rows: MathJsonExpression[] = [];
  for (const row of m.rows) {
    const cells: MathJsonExpression[] = [];
    for (const cell of row) {
      const json = cellToJson(cell);
      if (json === null) return null;
      cells.push(json);
    }
    rows.push(['List', ...cells] as unknown as MathJsonExpression);
  }
  return ['Matrix', ['List', ...rows] as unknown as MathJsonExpression] as unknown as MathJsonExpression;
}

/**
 * 리터럴 행렬의 정수 거듭제곱(음수 포함)을 CE로 계산한다. **`Power` 머리를 직접
 * 구성**한다 — LaTeX 왕복을 타면 `Inverse` 머리가 되어 안 풀린다(위 파일 설명 참고).
 *
 * **원소가 심볼이어도 된다** — CE는 `\begin{pmatrix}a&b\\c&d\end{pmatrix}^{-1}` 을
 * 여인수 전개로 잘 푼다(실측). 예전엔 여기서 "모든 셀이 숫자" 를 요구해 심볼 원소
 * 행렬이 입구에서 막혀 있었다.
 *
 * 특이행렬이거나 우리가 못 읽는 결과가 오면 `null` — 호출자가 원래 `matPow` 를
 * 그대로 돌려준다 (`transform.ts`의 `viaCe`와 같은 방어 규약: 실패하면 안 바뀜).
 */
function invertLiteral(base: MatrixLiteral, exponent: number): TypedExpr | null {
  if (base.rows.length > MAX_SYMBOLIC_INVERSE_SIZE) return null;
  try {
    const baseJson = matrixLiteralToJson(base);
    if (baseJson === null) return null;
    const json = ['Power', baseJson, exponent] as unknown as MathJsonExpression;
    // 심볼 원소 여인수 전개는 `n!` 로 커진다 — 크기 상한만으로는 부족해 시간도 막는다.
    const evaluated = guardCe(ce, 'matInverse', () => ce.box(json).evaluate());
    // 성공하면 `List`의 `List`로 온다(행렬 결과의 CE 관례). 특이행렬이면 `Power`/
    // `Inverse`/`Error` 머리가 그대로 남는다.
    if (!Array.isArray(evaluated.json) || evaluated.json[0] !== 'List') return null;
    const syntax = parseCeJson(evaluated.json);
    if (!syntax.ok) return null;
    const typed = elaborate(syntax.value, EMPTY_ENV);
    if (!typed.ok) return null;
    return typed.value;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

/** 인접한 리터럴 행렬 인수를 순서대로 곱해 합친다. 비가환이라 인접한 것만 합친다. */
function foldAdjacentProducts(factors: readonly TypedExpr[]): Result<TypedExpr[]> {
  const out: TypedExpr[] = [];
  for (const factor of factors) {
    const prev = out[out.length - 1];
    if (prev !== undefined && isMatrixLiteral(prev) && isMatrixLiteral(factor)) {
      const merged = mulMatrixLiterals(prev, factor);
      if (!merged.ok) return merged;
      out[out.length - 1] = merged.value;
    } else {
      out.push(factor);
    }
  }
  return ok(out);
}

/**
 * Typed IR을 받아 리터럴 행렬끼리의 산술을 전부 값으로 접는다.
 *
 * `simplify` 앞에서 한 번 도는 패스다(`evaluate.ts`) — `simplify` 는 순수 스칼라만
 * CE로 보내므로, 행렬 산술은 여기서 끝내둬야 뒤에서 셀 값이 마저 정리된다.
 */
export function foldMatrices(e: TypedExpr): Result<TypedExpr> {
  switch (e.op) {
    case 'num':
    case 'sym':
    case 'matIdentity':
      return ok(e);

    case 'matrix': {
      const rows: TypedExpr[][] = [];
      for (const row of e.rows) {
        const newRow: TypedExpr[] = [];
        for (const cell of row) {
          const r = foldMatrices(cell);
          if (!r.ok) return r;
          newRow.push(r.value);
        }
        rows.push(newRow);
      }
      return ok({ op: 'matrix', shape: e.shape, rows });
    }

    case 'add': {
      const terms: TypedExpr[] = [];
      for (const term of e.terms) {
        const r = foldMatrices(term);
        if (!r.ok) return r;
        terms.push(r.value);
      }
      // 덧셈은 교환·결합법칙이 있으니 순서 걱정 없이 리터럴 항끼리 누적 병합한다.
      const out: TypedExpr[] = [];
      for (const term of terms) {
        const prev = out[out.length - 1];
        if (prev !== undefined && isMatrixLiteral(prev) && isMatrixLiteral(term)) {
          const merged = addMatrixLiterals(prev, term);
          if (!merged.ok) return merged;
          out[out.length - 1] = merged.value;
        } else {
          out.push(term);
        }
      }
      return addTyped(out);
    }

    case 'neg': {
      const inner = foldMatrices(e.operand);
      if (!inner.ok) return inner;
      return ok({ op: 'neg', shape: e.shape, operand: inner.value });
    }

    case 'scalarMul': {
      const factors: TypedExpr[] = [];
      for (const f of e.factors) {
        const r = foldMatrices(f);
        if (!r.ok) return r;
        factors.push(r.value);
      }
      // 1x1 리터럴 행렬은 **모양이 스칼라**라 `mul` 이 아니라 여기로 온다
      // (`2\begin{pmatrix}\frac{1}{3}\end{pmatrix}`). 그대로 두면 셀 안으로 안 들어가
      // `2[1/3]` 로 남으므로, 아래 `mul` 케이스와 같이 셀에 곱해 넣는다.
      const literalAt = factors.findIndex(isMatrixLiteral);
      if (literalAt !== -1) {
        const rest = factors.filter((_, i) => i !== literalAt);
        if (rest.length > 0) {
          const scalar =
            rest.length === 1 ? rest[0] : { op: 'scalarMul' as const, shape: SCALAR, factors: rest };
          return scaleMatrixLiteral(scalar, factors[literalAt] as MatrixLiteral);
        }
      }
      return ok({ op: 'scalarMul', shape: SCALAR, factors });
    }

    case 'matMul': {
      const factors: TypedExpr[] = [];
      for (const f of e.factors) {
        const r = foldMatrices(f);
        if (!r.ok) return r;
        factors.push(r.value);
      }
      const merged = foldAdjacentProducts(factors);
      if (!merged.ok) return merged;
      return ok(merged.value.length === 1 ? merged.value[0] : { op: 'matMul', shape: e.shape, factors: merged.value });
    }

    case 'mul': {
      const scalar = foldMatrices(e.scalar);
      if (!scalar.ok) return scalar;
      const matrix = foldMatrices(e.matrix);
      if (!matrix.ok) return matrix;
      if (isMatrixLiteral(matrix.value)) return scaleMatrixLiteral(scalar.value, matrix.value);
      return ok({ op: 'mul', shape: matrix.value.shape, scalar: scalar.value, matrix: matrix.value });
    }

    case 'dot':
    case 'cross': {
      const left = foldMatrices(e.left);
      if (!left.ok) return left;
      const right = foldMatrices(e.right);
      if (!right.ok) return right;
      if (isMatrixLiteral(left.value) && isMatrixLiteral(right.value)) {
        return e.op === 'dot' ? dotLiteral(left.value, right.value) : crossLiteral(left.value, right.value);
      }
      return ok({ op: e.op, shape: e.shape, left: left.value, right: right.value });
    }

    case 'transpose': {
      const inner = foldMatrices(e.operand);
      if (!inner.ok) return inner;
      return ok(isMatrixLiteral(inner.value) ? transposeLiteral(inner.value) : { op: 'transpose', shape: e.shape, operand: inner.value });
    }

    case 'matPow': {
      const base = foldMatrices(e.base);
      if (!base.ok) return base;
      if (!isMatrixLiteral(base.value)) {
        return ok({ op: 'matPow', shape: e.shape, base: base.value, exponent: e.exponent });
      }
      // 지수가 상수 정수가 아니면(`A^n`) 접을 수 없다 — 그대로 둔다.
      const power = constantInteger(e.exponent);
      if (power === null) {
        return ok({ op: 'matPow', shape: e.shape, base: base.value, exponent: e.exponent });
      }
      if (power < 0) {
        const inverted = invertLiteral(base.value, power);
        return ok(inverted ?? { op: 'matPow', shape: e.shape, base: base.value, exponent: e.exponent });
      }
      // exponent === 0은 elaboratePow가 이미 matIdentity로 내보내 여기 오지 않는다
      // (정상 입력이라면). 방어적으로만 남겨둔다.
      if (power === 0) return ok({ op: 'matIdentity', shape: e.shape });
      let acc: MatrixLiteral = base.value;
      for (let i = 1; i < power; i += 1) {
        const next = mulMatrixLiterals(acc, base.value);
        if (!next.ok) return next;
        acc = next.value;
      }
      return ok(acc);
    }

    case 'scalarPow': {
      const base = foldMatrices(e.base);
      if (!base.ok) return base;
      const exponent = foldMatrices(e.exponent);
      if (!exponent.ok) return exponent;
      return ok({ op: 'scalarPow', shape: SCALAR, base: base.value, exponent: exponent.value });
    }

    case 'call': {
      const args: TypedExpr[] = [];
      for (const a of e.args) {
        const r = foldMatrices(a);
        if (!r.ok) return r;
        args.push(r.value);
      }
      return ok({ op: 'call', shape: SCALAR, name: e.name, args });
    }

    // 사용자 정의 함수 자체는 여기서 전개하지 않는다 — 그건 `foldCalculus` 뒤에 오는
    // `foldFunctions`(`transform/functions.ts`)의 몫이다. 여기서는 인수 안의 리터럴
    // 행렬 산술만 먼저 접는다. `call` 과 달리 모양은 그대로 지킨다 — 인수가 스칼라란
    // 보장이 없다.
    case 'apply': {
      const args: TypedExpr[] = [];
      for (const a of e.args) {
        const r = foldMatrices(a);
        if (!r.ok) return r;
        args.push(r.value);
      }
      return ok({ op: 'apply', shape: e.shape, name: e.name, args });
    }

    case 'frac': {
      const numerator = foldMatrices(e.numerator);
      if (!numerator.ok) return numerator;
      const denominator = foldMatrices(e.denominator);
      if (!denominator.ok) return denominator;
      return ok({ op: 'frac', shape: numerator.value.shape, numerator: numerator.value, denominator: denominator.value });
    }

    // 미분/적분/합/곱 자체는 여기서 계산하지 않는다 — 그건 이 패스 뒤에 오는 별도
    // 단계(`foldCalculus`)의 몫이다. 여기서는 자식만 재귀해 리터럴 행렬 산술이 안쪽에서
    // 먼저 끝나 있게 한다.
    case 'deriv': {
      const body = foldMatrices(e.body);
      if (!body.ok) return body;
      return ok({ op: 'deriv', shape: e.shape, body: body.value, vars: e.vars, order: e.order });
    }

    case 'sum':
    case 'prod':
    case 'integral': {
      const body = foldMatrices(e.body);
      if (!body.ok) return body;
      const lower = e.lower !== null ? foldMatrices(e.lower) : null;
      if (lower !== null && !lower.ok) return lower;
      const upper = e.upper !== null ? foldMatrices(e.upper) : null;
      if (upper !== null && !upper.ok) return upper;
      return ok({
        op: e.op,
        shape: e.shape,
        body: body.value,
        variable: e.variable,
        lower: lower === null ? null : lower.value,
        upper: upper === null ? null : upper.value,
      });
    }
  }
}
