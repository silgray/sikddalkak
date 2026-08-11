import { type Shape } from "../shape/shape";
import { type Literal } from "../literal/literal";
import { type SyntaxNode } from "../syntax/node";

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
  /**
   * 행렬의 거듭제곱. **지수는 `scalarPow` 와 같이 `TypedExpr`** — `A^{1+2}` 처럼 지수가
   * 식일 수 있어야 한다. elaborate는 지수가 **스칼라 모양인지만** 보고, "정수인가·양수인가"
   * 판정은 `constantInteger` 로 값이 확정된 뒤에 한다 (치환 후에도 다시 걸리도록
   * `normalize` 가 그 자리다).
   */
  | { readonly op: 'matPow'; readonly shape: Shape; readonly base: TypedExpr; readonly exponent: TypedExpr }
  | { readonly op: 'scalarPow'; readonly shape: Shape; readonly base: TypedExpr; readonly exponent: TypedExpr }
  | { readonly op: 'call'; readonly shape: Shape; readonly name: string; readonly args: readonly TypedExpr[] }
  /**
   * 사용자 정의 함수 호출 (`f(x)=x^2` 를 정의한 뒤 `f(3)`). `call`(내장 스칼라 함수
   * 전용, `SCALAR` 로 못박혀 있다)과 다른 op — 사용자 함수는 본문에 따라 **어떤
   * 모양이든** 돌려줄 수 있다(`f(x)=\begin{pmatrix}x\\1\end{pmatrix}`).
   *
   * **모양은 호출부마다 다시 정해진다** — `f` 는 고정 시그니처가 없는 모양 다형이다
   * (`elaborate.ts` 의 `instantiateFunction` 참고). `f(3)` 과 `f(A)` 가 같은 정의에서
   * 서로 다른 모양(또는 한쪽만 오류)이 나올 수 있다.
   *
   * **전개는 `evaluate` 에서만 한다** — `deriv`/`integral`/`sum` 과 같은 규율이다.
   * 그 전까지 이 노드는 `f(x)` 그대로 남고, `render` 도 `f\left(x\right)` 를 낸다.
   */
  | { readonly op: 'apply'; readonly shape: Shape; readonly name: string; readonly args: readonly TypedExpr[] }
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
  | { readonly op: 'matIdentity'; readonly shape: Shape }
  /**
   * `\dfrac{\mathrm{d}}{\mathrm{d}x}(...)` 계열. `evaluate` 시점에만 실제로 계산되고
   * 그 전까지는 `matPow` 처럼 모양만 유지한 채 미평가로 남는다.
   *
   * `vars.length === 1` 이면 원소별 미분(결과 모양 = 본문 모양). `vars.length > 1` 이면
   * numerator layout 이다 — 스칼라 본문은 `(1,n)` 행벡터(그래디언트), 열벡터 본문은
   * `(m,n)` 야코비안. 그 밖(행벡터·일반 행렬 본문)은 3-텐서가 되어 표현할 수 없으므로
   * elaborate가 오류로 막는다.
   */
  | {
      readonly op: 'deriv';
      readonly shape: Shape;
      readonly body: TypedExpr;
      readonly vars: readonly string[];
      readonly order: number;
    }
  /**
   * `\sum_{k=lo}^{hi}(...)`. 본문은 임의 모양 — 결과 모양은 본문과 같다(원소별 합).
   * `lower`/`upper` 가 둘 다 상수 정수면 `evaluate` 가 전개한다. 인덱스 `variable` 은
   * 바운드 변수라 `freeSymbols`/`substitute` 의 취급이 `sym` 과 다르다(§바운드 변수).
   */
  | {
      readonly op: 'sum';
      readonly shape: Shape;
      readonly body: TypedExpr;
      readonly variable: string;
      readonly lower: TypedExpr | null;
      readonly upper: TypedExpr | null;
    }
  /**
   * `\prod_{k=lo}^{hi}(...)`. `sum` 과 같은 바운드 변수 규약이지만 본문은 **정사각**이어야
   * 한다(행렬곱이 되므로) — 스칼라(1,1)도 정사각이라 통과한다. 인덱스 증가 순서대로
   * 왼쪽부터 곱한다(비가환).
   */
  | {
      readonly op: 'prod';
      readonly shape: Shape;
      readonly body: TypedExpr;
      readonly variable: string;
      readonly lower: TypedExpr | null;
      readonly upper: TypedExpr | null;
    }
  /** `\int_{lo}^{hi}(...)\mathrm{d}x`. `sum` 과 모양 규약이 같다(원소별). */
  | {
      readonly op: 'integral';
      readonly shape: Shape;
      readonly body: TypedExpr;
      readonly variable: string;
      readonly lower: TypedExpr | null;
      readonly upper: TypedExpr | null;
    };

/**
 * 사용자 정의 함수 하나 (`f(x,y) = ...`).
 *
 * 본문을 **`SyntaxNode`(elaborate 이전)로** 들고 있다 — `bindings` 가 `TypedExpr`(이미
 * elaborate된 값)인 것과 다르다. 이유는 결과 모양이 **호출부 인수 모양에 따라
 * 달라지기 때문**이다(`f(x)=\begin{pmatrix}x\\1\end{pmatrix}` 는 인수가 스칼라일 때만
 * 뜻이 있다) — 미리 한 번 elaborate해서 굳혀둘 수가 없다. 호출마다 `elaborate.ts` 의
 * `instantiateFunction` 이 매개변수에 그 호출의 실제 모양을 걸고 다시 elaborate한다.
 */
export type FunctionDef = {
  readonly params: readonly string[];
  readonly body: SyntaxNode;
};

/**
 * 심볼 환경.
 *
 * elaborate 자신은 `shapes` 만 본다. `bindings` 는 치환이, `functions` 는 `apply` 노드의
 * 모양 계산·전개가 쓴다.
 *
 * 값이 `TypedExpr` 인 건 이 모듈의 내부 통화가 그것이기 때문이다. LaTeX을 받는 건
 * 바깥 경계(`index.ts`)의 몫이다.
 */
export type Env = {
  readonly shapes: Readonly<Record<string, Shape>>;
  /** 심볼 → 그 심볼이 정의된 식. 치환이 쓴다. */
  readonly bindings?: Readonly<Record<string, TypedExpr>>;
  /** 이름 → 사용자 정의 함수. 변수(`bindings`)와 **한 이름 공간을 공유**한다 — 같은
   * 이름을 변수와 함수로 동시에 정의할 수 없다(셀 층, `cellGraph.ts` 가 검사한다). */
  readonly functions?: Readonly<Record<string, FunctionDef>>;
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
