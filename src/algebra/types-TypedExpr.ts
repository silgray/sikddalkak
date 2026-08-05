import { type Shape } from "./types-shape";
import { type Literal } from "./types-Literal";

export type TypedExpr =
  | { readonly op: 'num'; readonly shape: Shape; readonly value: Literal }
  | { readonly op: 'sym'; readonly shape: Shape; readonly name: string }
  | { readonly op: 'matrix'; readonly shape: Shape; readonly rows: readonly (readonly TypedExpr[])[] }
  | { readonly op: 'add'; readonly shape: Shape; readonly terms: readonly TypedExpr[] }
  | { readonly op: 'neg'; readonly shape: Shape; readonly operand: TypedExpr }
  /**
   * 스칼라끼리의 곱. **n-항** — 이항 트리로 두면 `AABBAAAu` 같은 식이 7겹으로 중첩돼
   * 구조를 알아볼 수 없다. `elaborate` 는 정규화 없이 둘씩만 담고(중첩된 채로 둔다),
   * `normalize` 가 평탄화·정렬·숫자 접기를 한다. 정규화가 끝난 뒤의 불변식: 길이 ≥ 2,
   * 전부 스칼라 모양, 숫자 리터럴은 최대 1개(있다면 맨 앞), 나머지는 `exprKey` 순 정렬.
   */
  | { readonly op: 'scalarMul'; readonly shape: Shape; readonly factors: readonly TypedExpr[] }
  /**
   * 행렬끼리의 곱. **n-항**, 이유는 `scalarMul` 과 같다. 정규화 후 불변식: 길이 ≥ 2,
   * 전부 비스칼라 모양. **순서는 절대 정렬하지 않는다** — 인수 순서가 비가환을 지키는
   * 지점이다 (`ABA` 와 `A²B` 는 같은 인수 열이 될 수 없다).
   */
  | { readonly op: 'matMul'; readonly shape: Shape; readonly factors: readonly TypedExpr[] }
  /**
   * 스칼라 부분과 행렬 부분이 섞인 곱. `scalar` 는 스칼라 모양(단일 심볼이거나
   * `scalarMul` 일 수 있다), `matrix` 는 비스칼라 모양(단일 심볼이거나 `matMul`일 수
   * 있다). 한쪽만 있으면 이 노드를 만들지 않고 `scalarMul`/`matMul` 을 그대로 쓴다.
   */
  | { readonly op: 'mul'; readonly shape: Shape; readonly scalar: TypedExpr; readonly matrix: TypedExpr }
  | { readonly op: 'dot'; readonly shape: Shape; readonly left: TypedExpr; readonly right: TypedExpr }
  | { readonly op: 'cross'; readonly shape: Shape; readonly left: TypedExpr; readonly right: TypedExpr }
  | { readonly op: 'transpose'; readonly shape: Shape; readonly operand: TypedExpr }
  | { readonly op: 'matPow'; readonly shape: Shape; readonly base: TypedExpr; readonly exponent: number }
  | { readonly op: 'scalarPow'; readonly shape: Shape; readonly base: TypedExpr; readonly exponent: TypedExpr }
  | { readonly op: 'call'; readonly shape: Shape; readonly name: string; readonly args: readonly TypedExpr[] }
  /**
   * `\frac{p}{q}` — **나눗셈 표기 자체를 보존**한다. `p·q^{-1}` 로 바꿔버리면
   * `\frac{x^2+2x+1}{x+1}` 이 `\left(x^2+2x+1\right)\left(x+1\right)^{-1}` 로 렌더돼
   * 원문 형태를 잃는다(렌더 멱등성 위반). `denominator` 는 스칼라여야 한다 — 행렬
   * 나눗셈은 정의하지 않고 역행렬을 명시적으로 쓰게 한다. `shape` 는 분자를 따른다
   * (`\frac{A}{2}` 처럼 분자가 행렬이어도 통과한다).
   */
  | { readonly op: 'frac'; readonly shape: Shape; readonly numerator: TypedExpr; readonly denominator: TypedExpr }
  /**
   * 항등행렬 `I`. 모양은 미정(`{rows:'unknown',cols:'unknown'}`)일 수 있다 — elaborate가
   * 바닥에서 위로 훑는 동안은 `I` 혼자서 크기를 알 길이 없고, 곱하거나 더하는 **상대**가
   * 알려줘야 한다(`resolveIdentities`). 끝까지 아무도 안 알려주면 normalize가 `(1,1)`
   * (스칼라 1과 같음)로 굳힌다. 전용 노드로 두는 이유는 `sym` 이름 `'I'` 로 흘려보내면
   * TypeScript가 switch 처리를 강제해주지 않아 numeric.ts 같은 곳에서 조용히
   * "값이 없다" 로 새어나가기 때문이다.
   */
  | { readonly op: 'matIdentity'; readonly shape: Shape };

/**
 * 심볼 환경.
 *
 * elaborate 자신은 `shapes` 만 본다. `bindings` 는 치환이, `functions` 는 나중에 들어올
 * 심볼릭 함수 전개 패스가 쓴다 — **레코드 형태를 미리 잡아두는** 이유는 나중에 시그니처를
 * 전부 고치지 않기 위해서다 (설계 §11).
 *
 * 값이 `TypedExpr` 인 건 이 모듈의 내부 통화가 그것이기 때문이다. LaTeX을 받는 건
 * 바깥 경계(`index.ts`)의 몫이다.
 */
export type Env = {
  readonly shapes: Readonly<Record<string, Shape>>;
  /** 심볼 → 그 심볼이 정의된 식. 치환이 쓴다. */
  readonly bindings?: Readonly<Record<string, TypedExpr>>;
  /** 심볼릭 함수 정의 자리 — 지금은 비어 있다 (설계 §11). */
  readonly functions?: Readonly<Record<string, unknown>>;
  /**
   * 모르는 심볼을 스칼라로 볼 것인가 (기본 `true`).
   *
   * 사용자 식에는 참이어야 한다 — 처음 쓰는 문자마다 오류를 낼 수는 없다. 하지만
   * **정의들끼리 모양을 풀어나갈 때는 거짓이어야** 한다. `B = A^T` 를 `A` 보다 먼저
   * 만나면 스칼라 가정이 곧바로 `B = 스칼라` 로 굳어버려, 나중에 `A` 가 행렬로 밝혀져도
   * 되돌릴 수 없다 (`buildEnv` 참고).
   */
  readonly assumeScalarForUnknown?: boolean;
};
