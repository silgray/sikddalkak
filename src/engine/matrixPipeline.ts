import type { Expression, MathJsonExpression } from '@cortex-js/compute-engine';
import { ce } from './ce';

/**
 * 행렬이 관여하는 식을 다루는 공용 파이프라인.
 * 그래프 평가(evaluate.ts)와 선택 변환(transform.ts)이 같은 원칙을 공유한다:
 * CE 0.90은 곱셈을 교환법칙 가정으로 재배열하므로, 행렬이 섞인 식은
 * 축소 정규화 형식으로 파싱하고 fold를 거친 뒤 evaluate만 한다 (simplify 금지).
 */

export function isMatrixLike(expr: Expression): boolean {
  return expr.operator === 'Matrix' || String(expr.type).startsWith('matrix');
}

/**
 * 곱셈 순서를 보존하는 축소 정규화 형식. Multiply/Order 정규화를 빼서
 * `b^Tb` 같은 곱이 재배열되지 않게 한다 — CE는 `Transpose(b)`처럼 함수로
 * 감싼 인자를 (b가 matrix로 declare돼 있어도) 행렬로 인정하지 않고
 * 교환법칙 가정으로 정렬해버린다.
 */
export const ORDER_PRESERVING_FORMS = [
  'InvisibleOperator',
  'Number',
  'Add',
  'Power',
  'Divide',
  'Flatten',
] as const;

/** JSON 어딘가에 행렬 리터럴이 있는지 (행렬 파이프라인 선택용). */
export function jsonHasMatrix(json: unknown): boolean {
  if (json === 'Matrix') return true;
  if (Array.isArray(json)) return json.some(jsonHasMatrix);
  return false;
}

/**
 * `\cdot`/`\times`는 CE 파싱에서 전부 Multiply로 뭉개져 의미가 사라진다.
 * 행렬 경로에서만, 파싱 전에 마커 심볼로 바꿔 어느 연산자였는지 살려둔다.
 * (`\cdots` 같은 다른 커맨드를 건드리지 않게 토큰 경계를 확인한다.)
 */
const DOT_MARKER = 'vecDotMarker';
const CROSS_MARKER = 'vecCrossMarker';
export function preprocessVectorOps(latex: string): string {
  return latex
    .replace(/\\cdot(?![a-zA-Z])/g, ` \\mathrm{${DOT_MARKER}} `)
    .replace(/\\times(?![a-zA-Z])/g, ` \\mathrm{${CROSS_MARKER}} `);
}

/** JSON이 2D 행렬 구조인지 (`['Matrix', …]` 또는 List-of-List). 심볼 원소 허용. */
function is2DMatrixJson(json: unknown): boolean {
  if (!Array.isArray(json)) return false;
  if (json[0] === 'Matrix') return true;
  if (json[0] !== 'List' || json.length < 2) return false;
  return json.slice(1).every((row) => Array.isArray(row) && row[0] === 'List');
}

/**
 * Nx1/1xN 행렬 또는 평평한 List를 평평한 벡터 JSON으로. 벡터가 아니면 null.
 *
 * 원소가 리터럴인지는 따지지 않는다 — CE의 Dot/Cross는 심볼 원소도 정확히
 * 계산하므로(실측), 구조가 벡터이기만 하면 통과시킨다. 리터럴 게이트를 두면
 * `\begin{pmatrix}x_1\\y_1\\z_1\end{pmatrix}` 같은 심볼 벡터의 내적/외적이
 * 마커만 벗겨진 채 일반 곱으로 되돌아가 쓰레기가 나온다.
 */
function asFlatVector(json: unknown): MathJsonExpression | null {
  if (!Array.isArray(json)) return null;
  if (json[0] === 'List' && json.slice(1).every((v) => !Array.isArray(v))) {
    return json as unknown as MathJsonExpression; // 이미 평평한 벡터
  }
  const rows: unknown = json[0] === 'Matrix' ? json[1] : json;
  if (!Array.isArray(rows) || rows[0] !== 'List') return null;
  const rowArr = rows.slice(1);
  if (rowArr.every((r) => Array.isArray(r) && r[0] === 'List' && r.length === 2)) {
    // Nx1 열벡터
    return ['List', ...rowArr.map((r) => (r as unknown[])[1])] as unknown as MathJsonExpression;
  }
  if (rowArr.length === 1 && Array.isArray(rowArr[0]) && (rowArr[0] as unknown[])[0] === 'List') {
    // 1xN 행벡터
    return rowArr[0] as unknown as MathJsonExpression;
  }
  return null;
}

/** 평평한 벡터를 열벡터 Matrix로 (Cross 결과 표시용). */
function asColumnMatrix(flat: MathJsonExpression): MathJsonExpression {
  const values = (flat as unknown as unknown[]).slice(1);
  return ['Matrix', ['List', ...values.map((v) => ['List', v])]] as unknown as MathJsonExpression;
}

/**
 * Multiply 인자 속 벡터 연산 마커를 해석한다.
 * 양옆이 벡터 리터럴이면 Dot/Cross로 계산해 결과 리터럴로 치환하고,
 * 아니면(스칼라 곱 등) 마커만 지워 일반 곱셈으로 되돌린다.
 */
function resolveVectorMarkers(args: unknown[]): unknown[] {
  const out = [...args];
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] !== DOT_MARKER && out[i] !== CROSS_MARKER) continue;
    const left = asFlatVector(out[i - 1]);
    const right = asFlatVector(out[i + 1]);
    if (left !== null && right !== null) {
      const op = out[i] === DOT_MARKER ? 'Dot' : 'Cross';
      const result = ce.box([op, left, right] as unknown as MathJsonExpression).evaluate();
      const json: unknown = result.json;
      const replacement =
        op === 'Cross' && Array.isArray(json) && json[0] === 'List'
          ? asColumnMatrix(json as unknown as MathJsonExpression)
          : json;
      out.splice(i - 1, 3, replacement);
      i -= 2; // 치환 지점부터 재검사 (연쇄 a·b·c)
    } else {
      out.splice(i, 1); // 벡터가 아니다 — 일반 곱셈
      i -= 1;
    }
  }
  return out;
}

/**
 * subs를 마친 JSON에서 `Transpose(리터럴)` 같은 행렬 함수를 바닥부터 미리
 * 평가해 리터럴 행렬로 접고, `\cdot`/`\times` 마커를 Dot/Cross로 해석한다.
 * 이걸 안 하면 rebox(재정규화)가 incompatible-type 에러를 내거나 곱을
 * 계산하지 못한다.
 */
export function foldMatrixFns(json: MathJsonExpression): MathJsonExpression {
  if (!Array.isArray(json)) return json;
  let walked = json.map((item) => foldMatrixFns(item as MathJsonExpression)) as unknown[];
  const [head] = walked;
  if (head === 'Multiply' && walked.some((a) => a === DOT_MARKER || a === CROSS_MARKER)) {
    walked = ['Multiply', ...resolveVectorMarkers(walked.slice(1))];
    // 인자가 하나만 남으면 곱을 벗긴다: Multiply(x) -> x
    if (walked.length === 2) return walked[1] as MathJsonExpression;
  }
  // 전치는 순수 구조 연산이라 심볼 원소여도 안전하게 접힌다(실측). 리터럴만
  // 접으면 `v^Tv` 처럼 심볼 벡터의 전치가 안 접혀 CE가 에러 박스를 낸다.
  if (head === 'Transpose' && is2DMatrixJson(walked[1])) {
    return prefold(walked);
  }
  // Multiply 안에 미평가 Power(행렬, n)가 남아 있으면 CE가 행렬곱 대신
  // 원소별 브로드캐스트를 해버린다 (실측: A·B^2 → A 원소마다 B^2 블록).
  // Transpose처럼 Power도 바닥에서 미리 접는다. 원소가 심볼이어도 거듭제곱
  // 자체는 올바르게 평가된다(실측).
  if (
    head === 'Power' &&
    Array.isArray(walked[1]) &&
    (walked[1] as unknown[])[0] === 'Matrix' &&
    typeof walked[2] === 'number' &&
    Number.isInteger(walked[2])
  ) {
    return prefold(walked);
  }
  return walked as unknown as MathJsonExpression;
}

/** 서브트리를 즉시 평가하고, List-of-List면 Matrix로 감싸 곱셈에 참여시킨다. */
function prefold(walked: unknown[]): MathJsonExpression {
  const evaluated = ce.box(walked as unknown as MathJsonExpression).evaluate();
  const out: unknown = evaluated.json;
  if (Array.isArray(out) && out[0] === 'List') {
    return ['Matrix', out] as unknown as MathJsonExpression;
  }
  return out as MathJsonExpression;
}

/**
 * 1×1 행렬 결과를 스칼라로 접는다: `b^Tb` = `[[14]]` → `14`.
 * 표시뿐 아니라 바인딩 값도 스칼라가 되므로 이후 스칼라 연산에 쓸 수 있다.
 */
export function collapseOneByOne(expr: Expression): Expression {
  const json: unknown = expr.json;
  if (Array.isArray(json) && json[0] === 'List' && json.length === 2) {
    const row: unknown = json[1];
    if (Array.isArray(row) && row[0] === 'List' && row.length === 2) {
      const cell = row[1];
      // 셀이 스칼라면(숫자·심볼·심볼식) 접는다. 심볼 내적 `u^Tv`의 셀은
      // `Add(...)`라 예전 리터럴 게이트가 거부해 1×1로 남았다. 셀이 다시
      // 행렬/리스트 구조일 때만(중첩) 접지 않는다.
      if (!(Array.isArray(cell) && (cell[0] === 'List' || cell[0] === 'Matrix'))) {
        return ce.box(cell as MathJsonExpression);
      }
    }
  }
  return expr;
}

/**
 * 행렬 연산의 결과는 `Matrix`가 아니라 `List`의 `List`로 나온다.
 * 그대로 두면 `[[4, 4], [4, 4]]` 처럼 렌더되므로 다시 Matrix로 감싼다.
 * 진짜 리스트(`[1, 2, 3]`)는 원소가 List가 아니므로 건드리지 않는다.
 */
export function asMatrixIfRows(expr: Expression): Expression {
  if (expr.operator !== 'List') return expr;
  const json: unknown = expr.json;
  if (!Array.isArray(json) || json.length < 2) return expr;
  const rows: unknown[] = json.slice(1);
  if (!rows.every((row) => Array.isArray(row) && row[0] === 'List')) return expr;
  return ce.box(['Matrix', expr.json]);
}

/** 미평가 곱(2D 행렬 피연산자 ≥2)을 트리 어디서든 재귀로 찾는다. */
function hasUnevaluatedMatrixProduct(json: unknown): boolean {
  if (!Array.isArray(json)) return false;
  if (json[0] === 'Multiply' && json.slice(1).filter(is2DMatrixJson).length >= 2) {
    return true;
  }
  return json.some(hasUnevaluatedMatrixProduct);
}

/**
 * 행렬 연산의 차원 불일치를 감지한다. 두 실패 모드가 있다(실측):
 *  ① CE가 Error를 낸 경우 — 덧셈/뺄셈/내적/외적 불일치는 `incompatible-dimensions`
 *     Error로 나온다. CE는 중첩된 Error도 최상위 `isValid`에 반영한다(곱 안에 묻혀도 잡힘).
 *  ② 곱이 미평가로 남은 경우 — 차원 안 맞는 행렬곱은 CE가 에러 없이 곱을 그냥 안 편다
 *     (`isValid: true`). **트리 전체를 재귀로** 봐야 한다: `(2×3)(2×2)+(2×2)` 처럼
 *     불일치 곱이 Add 안에 묻히면 CE가 그 곱을 스칼라 취급해 2×2 위로 broadcast하고,
 *     최상위는 valid한 List가 돼서 각 셀에 미평가 곱이 박힌 쓰레기가 나온다.
 * 정상 결과(행렬곱→List, 스칼라×행렬→List 브로드캐스트, symbolic 곱 AB)는 걸리지 않는다.
 */
function matrixDimError(expr: Expression): boolean {
  if (!expr.isValid) return true;
  return hasUnevaluatedMatrixProduct(expr.json);
}

/**
 * 행렬이 관여하는 표현식의 평가 경로. `expr`는 축소 정규화 형식으로 파싱돼
 * 곱셈 순서가 보존된 상태여야 한다.
 *
 * subs로 심볼이 리터럴 행렬이 된 뒤 → Transpose 등을 미리 접고 →
 * rebox(재정규화)한다. 리터럴 행렬은 정규화가 재배열하지 않으므로(기존 검증)
 * 이 시점의 canonical화는 안전하고, evaluate가 올바른 순서로 곱을 계산한다.
 *
 * 차원이 안 맞으면 throw한다 — 호출자(computeNode/transformMatrixSelection)가
 * try/catch로 받아 에러 결과 또는 null로 만든다. 이걸 안 던지면 미평가 곱이나
 * CE Error LaTeX이 결과 셀에 쓰레기로 렌더된다.
 */
export function reduceMatrixExpr(subbed: Expression): Expression {
  const folded = foldMatrixFns(subbed.json);
  const evaluated = ce.box(folded).evaluate();
  if (matrixDimError(evaluated)) throw new Error('dimension mismatch');
  return asMatrixIfRows(collapseOneByOne(evaluated));
}
