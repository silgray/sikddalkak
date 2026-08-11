import { buildAdd, buildNum } from '../expr/builders';
import { exprKey } from '../expr/key';
import { type Result } from '../result/result';
import { isScalar, type Shape } from '../shape/shape';
import type { TypedExpr } from '../expr/node';
import { splitSign, ONE as ONE_LIT } from '../literal/literal';
import { combineLikeTerms } from '../polynomial/combine';
import { fromPolynomial, toPolynomial } from '../polynomial/convert';
import type { Monomial } from '../polynomial/polynomial';

/**
 * 덧셈 정규화 — 동류항 합치기와 항 정렬.
 *
 * 이 파일은 `normalize.ts` 를 import 하지 않는다. 자식 재귀는 `recur` 로 받는다.
 */

/** 정렬 키 실험용 훅의 타입 (`sortTerms` 가 만드는 중간 표현). */
type TermKey = {
  term: TypedExpr;
  constant: number;
  sign: number;
  key: string;
};

/**
 * 항 하나에서 부호를 벗겨낸다. 정렬 키가 부호를 1순위로 보기 위해서다.
 *
 * `renderProduct`/`buildProduct` 와 같은 "부호는 바깥" 관례를 읽는 쪽이다.
 */
function stripTermSign(t: TypedExpr): { negative: boolean; core: TypedExpr } {
  if (t.op === 'neg') return { negative: true, core: t.operand };
  if (t.op === 'num') {
    const { negative, magnitude } = splitSign(t.value);
    if (negative) return { negative: true, core: buildNum(magnitude) };
  }
  return { negative: false, core: t };
}

/**
 * 덧셈 항 정렬. 덧셈은 교환 가능하므로 순서를 고정해도 되고, 고정해야 `parse` 와
 * `expand` 가 같은 값에 같은 LaTeX 을 낸다 (퍼즈 ③).
 *
 * 키는 세 겹이다. **순수 `exprKey` 하나로는 사람이 읽기 나쁜 순서가 나온다:**
 *  1. **상수항은 맨 뒤로** — `n`(0x6E) < `s`(0x73) 라 `exprKey` 만 쓰면 `a+1` 이 `1+a` 가 된다
 *  2. **양수 먼저** — `-`(0x2D)가 모든 글자보다 앞서서 `A-B` 가 `-B+A` 로 뒤집힌다.
 *     렌더가 첫 항의 `-` 를 그대로 내보내므로 사용자에게 보이는 문자열이 나빠진다
 *  3. 나머지는 `exprKey` 순 — 안정적이기만 하면 되므로 임의로 정한다
 */
function sortTerms(terms: readonly TypedExpr[]): TypedExpr[] {
  const keyed: TermKey[] = terms.map((t) => {
    const { negative, core } = stripTermSign(t);
    return {
      term: t,
      constant: core.op === 'num' ? 1 : 0,
      sign: negative ? 1 : 0,
      key: exprKey(core),
    };
  });
  keyed.sort(
    (a, b) =>
      a.constant - b.constant ||
      a.sign - b.sign ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return keyed.map((k) => k.term);
}

/**
 * 동류항을 합친다 (`AcB + cAB` → `2cAB`, `\frac{3}{7}A + \frac{1}{5}A` → `\frac{22}{35}A`).
 *
 * ❗ **분배는 하지 않는다.** `toPolynomial` 은 곱을 합 위로 완전히 분배하므로, 단항식이
 * 여럿 나오는 항(= 괄호가 풀리는 항)은 펼치지 않고 통째로 원자 하나로 둔다. 이 가드가
 * 없으면 `(A+B)C + (A+B)C` 가 `2AC+2BC` 가 된다 — `parse` 가 사용자 괄호를 푸는 셈이다.
 * (`simplifyRaw` 가 쓰는 것과 같은 가드다 — 같은 15줄이 두 곳에 있다.)
 *
 * ❗ **실패를 새로 만들지 않는다.** 어느 단계든 실패하면 원래 항을 그대로 돌려준다.
 * 여기서 실패를 전파하면 `parse()` 가 지금까지 받던 식을 거부하기 시작하고, 그건
 * 퍼즈가 아니라 주 앱에서 터진다 (`viaCe`/`invertLiteral` 과 같은 방어 관례).
 *
 * 아무것도 안 합쳐졌으면 **원래 항을 그대로 유지한다** — `toPolynomial` 왕복은 합칠 게
 * 없어도 트리를 바꾸므로(정렬·좌결합 재조립), 굳이 통과시키면 렌더 멱등만 위태로워진다.
 */
function combineTerms(
  terms: readonly TypedExpr[],
  target: Shape,
  recur: (child: TypedExpr) => Result<TypedExpr>,
): readonly TypedExpr[] {
  if (terms.length < 2) return terms;

  const monomials: Monomial[] = [];
  for (const term of terms) {
    const p = toPolynomial(term);
    if (p.ok && p.value.length === 1) {
      monomials.push(p.value[0]);
    } else {
      monomials.push(
        isScalar(term.shape)
          ? { numeric: ONE_LIT, scalars: [term], factors: [] }
          : { numeric: ONE_LIT, scalars: [], factors: [term] },
      );
    }
  }

  const combined = combineLikeTerms(monomials);
  // 개수가 그대로면 합쳐진 게 없다 — 원본을 건드리지 않는다.
  if (combined.length === monomials.length) return terms;

  const rebuilt = fromPolynomial(combined, target);
  if (!rebuilt.ok) return terms;
  // 재조립된 트리는 `buildMul` 좌결합이라 정규화 모양이 아니다. 항 단위로만 다시 다진다
  // (`add` 로 재귀하면 여기로 되돌아와 무한 재귀가 된다).
  const out = rebuilt.value.op === 'add' ? rebuilt.value.terms : [rebuilt.value];
  const normalized: TypedExpr[] = [];
  for (const t of out) {
    const r = recur(t);
    if (!r.ok) return terms;
    normalized.push(r.value);
  }
  return normalized;
}

/** `add` — 자식을 정규화하고, 동류항을 합친 뒤, 항 순서를 고정한다. */
export function normalizeAdd(
  e: Extract<TypedExpr, { op: 'add' }>,
  recur: (child: TypedExpr) => Result<TypedExpr>,
): Result<TypedExpr> {
  const terms: TypedExpr[] = [];
  for (const term of e.terms) {
    const r = recur(term);
    if (!r.ok) return r;
    terms.push(r.value);
  }
  return buildAdd(sortTerms(combineTerms(terms, e.shape, recur)));
}
