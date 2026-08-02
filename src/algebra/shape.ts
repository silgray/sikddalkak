/**
 * 모양(shape) 도메인.
 *
 * **모든 것이 행렬이고 스칼라는 `(1,1)` 인 특수 경우다.** 벡터를 별도 종류로 두지 않고
 * `(n,1)`/`(1,n)` 의 파생 술어로 본다. 이 한 가지 선택으로 여러 규칙이 공짜가 된다:
 *
 *   `v^T v` = `(1,n)(n,1)` = `(1,1)` = **스칼라**  ← 내적을 하드코딩하지 않아도 나온다
 *   `A v`   = `(m,n)(n,1)` = `(m,1)` = **벡터**
 *   `(v^T v) A` = 스칼라 × 행렬 = **스칼라곱**
 *
 * 차원이 `'unknown'` 인 경우는 "증명 가능하게 불일치할 때만 오류"로 다룬다. 다만
 * 연산자를 **고르는** 판정(내적이냐 행렬곱이냐)은 확정된 차원을 요구한다 —
 * 모르면 찍지 않고 오류를 내는 게 이 모듈의 원칙이다.
 */

export type Dim = number | 'unknown';
export type Shape = { readonly rows: Dim; readonly cols: Dim };

export const SCALAR: Shape = { rows: 1, cols: 1 };

export const shape = (rows: Dim, cols: Dim): Shape => ({ rows, cols });

/** 차원이 확정된 수인지. */
export const isKnownDim = (d: Dim): d is number => typeof d === 'number';

/** 모양의 두 차원이 모두 확정됐는지. 연산자 선택은 이걸 요구한다. */
export const isKnownShape = (s: Shape): boolean => isKnownDim(s.rows) && isKnownDim(s.cols);

/**
 * 두 차원이 **확실히 다른가**. 하나라도 unknown이면 불일치를 증명할 수 없으므로 false.
 * (차원 검사는 "증명 가능한 불일치만 오류"를 쓴다)
 */
export const dimsConflict = (a: Dim, b: Dim): boolean =>
  isKnownDim(a) && isKnownDim(b) && a !== b;

/** 두 모양이 **확실히 다른가**. */
export const shapesConflict = (a: Shape, b: Shape): boolean =>
  dimsConflict(a.rows, b.rows) || dimsConflict(a.cols, b.cols);

/** 확정적으로 스칼라인가 = `(1,1)`. */
export const isScalar = (s: Shape): boolean => s.rows === 1 && s.cols === 1;

/** 확정적으로 열벡터인가 = `(n,1)`, n>1. */
export const isColumnVector = (s: Shape): boolean =>
  s.cols === 1 && isKnownDim(s.rows) && s.rows > 1;

/** 확정적으로 행벡터인가 = `(1,n)`, n>1. */
export const isRowVector = (s: Shape): boolean =>
  s.rows === 1 && isKnownDim(s.cols) && s.cols > 1;

export const isVector = (s: Shape): boolean => isColumnVector(s) || isRowVector(s);

/** 벡터의 길이. 벡터가 아니면 null. */
export const vectorLength = (s: Shape): number | null => {
  if (isColumnVector(s)) return s.rows as number;
  if (isRowVector(s)) return s.cols as number;
  return null;
};

/** 두 벡터의 방향(열/행)이 같은가. 내적은 같은 방향끼리만 받는다. */
export const sameOrientation = (a: Shape, b: Shape): boolean =>
  (isColumnVector(a) && isColumnVector(b)) || (isRowVector(a) && isRowVector(b));

export const isSquare = (s: Shape): boolean =>
  isKnownDim(s.rows) && isKnownDim(s.cols) && s.rows === s.cols;

/** 사람이 읽는 표기 — 오류 메시지에 쓴다. */
export const formatShape = (s: Shape): string =>
  isScalar(s) ? 'scalar' : `${String(s.rows)}x${String(s.cols)}`;

/**
 * 모양 분류. 오류 메시지와 랩 UI 진단 패널에서 쓴다.
 * 계산 규칙 자체는 위 술어들을 직접 쓴다 — 분류 문자열로 분기하지 않는다.
 */
export type ShapeKind = 'scalar' | 'column' | 'row' | 'matrix' | 'unknown';

export const classify = (s: Shape): ShapeKind => {
  if (isScalar(s)) return 'scalar';
  if (isColumnVector(s)) return 'column';
  if (isRowVector(s)) return 'row';
  if (isKnownShape(s)) return 'matrix';
  return 'unknown';
};
