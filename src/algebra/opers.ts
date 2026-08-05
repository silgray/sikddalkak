/**
 * 연산의 대수적 성질 — **코드 분기가 아니라 데이터**로 둔다.
 *
 * 재작성 규칙(expand/simplify/factor)은 `if (op === 'cross')` 같은 분기 대신 이 표를
 * 조회한다. 연산을 하나 추가하면 표에 한 줄 늘어날 뿐 규칙들은 그대로다.
 * (이 저장소의 `rules.ts`·`keyOps.ts` 레지스트리 관례와 같은 결.)
 */

export type BinaryOp = 'scalarMul' | 'matMul' | 'dot' | 'cross';

export type Commutativity =
  /** `xy = yx` */
  | 'commutative'
  /** `x×y = -(y×x)` — 순서를 바꾸려면 부호가 따라온다 */
  | 'anticommutative'
  /** 순서를 바꿀 수 없다 */
  | 'noncommutative';

export type OpProperties = {
  readonly commutativity: Commutativity;
  /** `(xy)z = x(yz)` — 참일 때만 인수 열로 평탄화할 수 있다 */
  readonly associative: boolean;
  /** 덧셈 위로 분배되는가 (좌·우 양쪽) */
  readonly distributesOverAdd: boolean;
  /** 결과가 항상 스칼라인가 (내적처럼 모양을 떨어뜨리는 연산) */
  readonly yieldsScalar: boolean;
};

export const OP_PROPERTIES: Record<BinaryOp, OpProperties> = {
  scalarMul: {
    commutativity: 'commutative',
    associative: true,
    distributesOverAdd: true,
    yieldsScalar: false,
  },
  matMul: {
    // 여기가 `ABA → A²B` 를 막는 지점이다.
    commutativity: 'noncommutative',
    associative: true,
    distributesOverAdd: true,
    yieldsScalar: false,
  },
  dot: {
    commutativity: 'commutative',
    // `(u·v)·w` 는 애초에 성립하지 않는다 — 내적 결과가 스칼라라서 다음 곱은 스칼라곱이 된다.
    associative: false,
    distributesOverAdd: true,
    yieldsScalar: true,
  },
  cross: {
    commutativity: 'anticommutative',
    // `(u×v)×w ≠ u×(v×w)` — 그래서 인수 열로 평탄화하면 안 되고 트리로 남겨야 한다.
    associative: false,
    distributesOverAdd: true,
    yieldsScalar: false,
  },
};

export const isBinaryOp = (op: string): op is BinaryOp => op in OP_PROPERTIES;

/** 인수 열로 평탄화해도 되는가 (결합법칙). */
export const canFlatten = (op: BinaryOp): boolean => OP_PROPERTIES[op].associative;

/** 부호 없이 순서를 바꿔도 되는가. */
export const canReorderFreely = (op: BinaryOp): boolean =>
  OP_PROPERTIES[op].commutativity === 'commutative';
