import { exprKey, sortScalars } from '../expression/key';
import { buildNum } from '../expression/builders';
import { isScalar } from '../shape/shape';
import type { TypedExpr } from '../expression/node';
import { negLit, ONE as ONE_LIT, type Literal } from '../literal/literal';
import { mulLit } from '../literal/arith';

/**
 * 정규형 — **단항식 = (수치 계수, 스칼라 인수 집합, 비스칼라 인수 열)**.
 *
 * 이 표현 하나가 expand/simplify/factor를 동시에 건전하게 만든다:
 *  - 스칼라 인수는 교환 가능하므로 **집합처럼** 다뤄 정렬한다 (동류항 판정이 쉬워진다)
 *  - 비스칼라 인수는 교환 불가이므로 **열의 순서를 그대로** 유지한다
 *    → `ABA` 와 `A²B` 는 다른 키를 갖는다. 여기가 교환법칙 오적용을 막는 지점이다.
 *  - 동류항 ⇔ (스칼라 인수 집합, 비스칼라 인수 열)이 **완전히 같음**
 *
 * 인수 열로 평탄화해도 되는 근거는 `opers.ts` 의 결합법칙 항목이다. 결합법칙이 없는
 * 외적은 평탄화하지 않고 **통째로 인수 하나**로 남긴다 (`(u×v)×w ≠ u×(v×w)`).
 *
 * **`rewrite/` 의 곱 정규화도 같은 타입을 쓴다.** 곱 하나를 (계수, 스칼라들, 비스칼라들)로
 * 가르는 일이 다항식의 단항식과 정확히 같은 모양이라, 예전엔 `Collected` 라는 쌍둥이 타입이
 * 따로 있었다.
 */

export type Monomial = {
  /**
   * 수치 계수. **`number` 가 아니라 `Literal` 인 이유**: 동류항을 합칠 때 계수를 더하는데
   * (`combineLikeTerms`), float면 `\frac{3}{7}+\frac{1}{5}` 가 `0.6285714…` 가 된다.
   * 정확한 유리수여야 `\frac{22}{35}` 가 나온다.
   */
  readonly numeric: Literal;
  /**
   * 스칼라 인수 — 교환 가능하므로 키 기준으로 정렬해 정규화한다.
   *
   * ⚠ **정렬 여부는 생성자 책임이다.** 타입이 강제하지 않는다. `monomialKey` 가 동류항
   * 판정에 이 순서를 쓰므로, 정렬 안 된 채로 키를 뽑으면 같은 항이 다른 항으로 잡힌다.
   * `rewrite/product.ts` 의 `collect` 는 **일부러 정렬하지 않은 채** 돌려주고
   * (`buildProduct` 가 마지막에 한 번 정렬한다), 다항식 경로는 만들 때마다 정렬한다.
   */
  readonly scalars: readonly TypedExpr[];
  /** 비스칼라 인수 — **순서가 의미다.** 절대 정렬하지 않는다. */
  readonly factors: readonly TypedExpr[];
};

export type Polynomial = readonly Monomial[];

/** `(A+B)^n` 을 풀어쓸 상한. 이보다 크면 접은 채로 둔다 (항이 폭발한다). */
export const MAX_POWER_EXPANSION = 6;

/** 동류항 키 — 수치 계수는 뺀다 (그게 합쳐질 대상이므로). */
export const monomialKey = (m: Monomial): string =>
  `${m.scalars.map(exprKey).join('*')}|${m.factors.map(exprKey).join('*')}`;

export const ONE: Monomial = { numeric: ONE_LIT, scalars: [], factors: [] };

/** 잎 하나를 단항식으로. 모양이 결정한다: 스칼라면 계수 쪽, 아니면 인수 열 쪽. */
export const atom = (e: TypedExpr): Monomial =>
  isScalar(e.shape)
    ? { numeric: ONE_LIT, scalars: [e], factors: [] }
    : { numeric: ONE_LIT, scalars: [], factors: [e] };

export const negate = (m: Monomial): Monomial => ({ ...m, numeric: negLit(m.numeric) });

/**
 * 두 다항식의 곱. **인수 열을 이어붙이기만 하고 재배열하지 않는다** —
 * 행렬곱은 결합법칙은 있지만(그래서 이어붙일 수 있고) 교환법칙은 없다(그래서 순서를 지킨다).
 */
export function polyMul(left: Polynomial, right: Polynomial): Polynomial {
  const out: Monomial[] = [];
  for (const p of left) {
    for (const q of right) {
      // 계수를 못 곱하면(안전 정수 밖 등) 접지 않고 인수로 되돌린다 — 값을 뭉개지 않는다.
      const product = mulLit(p.numeric, q.numeric);
      out.push(
        product !== null
          ? {
              numeric: product,
              scalars: sortScalars([...p.scalars, ...q.scalars]),
              factors: [...p.factors, ...q.factors],
            }
          : {
              numeric: ONE_LIT,
              scalars: sortScalars([
                ...p.scalars,
                ...q.scalars,
                buildNum(p.numeric),
                buildNum(q.numeric),
              ]),
              factors: [...p.factors, ...q.factors],
            },
      );
    }
  }
  return out;
}
