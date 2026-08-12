import type { TypedExpr } from '../expression/node';
import { PRETTY_ORDER, type SortKey } from './prettifyOrder';

/**
 * 사람이 읽기 좋게 `add`/`scalarMul` 항을 재정렬하는 별도 패스.
 *
 * `normalize`(`normalize/normalize.ts`)가 항을 정렬하는 건 **노드 동일성**(같은 값 ⇒
 * 같은 트리) 때문이지 사람이 읽기 좋으라고가 아니다 — 그건 동류항 판정·캐시 지문에
 * 걸린 계약이라 뺄 수 없다. 하지만 그 계약이 요구하는 순서와 사람이 읽기 좋은 순서는
 * 다르고(`상수는 맨 뒤로`·`무거운 항 먼저` 같은 규칙은 출력 한 번에만 필요한데
 * 정규화가 도는 내내 모든 부분식마다 값을 치른다), 그래서 이 패스를 따로 뗐다.
 *
 * **아직 아무 데도 안 불린다.** `expand`/`simplify`/`factor`/`evaluate` 뒤에 붙이는 건
 * 다음 판. 지금은 자리만 마련해 둔 것 — 정렬 기준(`prettifyOrder.ts`)도 실험 중이다.
 *
 * ⚠ **`expression/traversal.ts` 의 `mapChildren` 을 쓰지 않는다.** 그건 빌더로 다시
 * 조립하며 `Result` 와 모양 검사를 낸다 — prettify는 순서만 바꿀 뿐 실패할 수 없고,
 * 안 바뀐 노드는 **참조를 그대로 유지**해야 한다(`===` 비교로 "바뀐 게 없다"를 알아채는
 * 자리가 여럿이다). 그래서 여기 전용의 가벼운 순회를 따로 둔다.
 */

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
  const sorted = [...next].sort(key);
  return sorted.every((x, i) => x === next[i]) ? next : sorted;
}

export type PrettyOrder = { readonly compareTerms: SortKey; readonly compareFactors: SortKey };

function prettifyOptional(
  e: TypedExpr | null,
  order: PrettyOrder,
): TypedExpr | null {
  return e === null ? null : prettify(e, order);
}

export function prettify(e: TypedExpr, order: PrettyOrder = PRETTY_ORDER): TypedExpr {
  const go = (x: TypedExpr) => prettify(x, order);

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

    // 비가환 — 인수 순서를 절대 정렬하지 않는다. 자식만 재귀한다.
    case 'matMul': {
      const factors = mapAll(e.factors, go);
      return factors === e.factors ? e : { ...e, factors };
    }

    case 'mul': {
      const scalar = go(e.scalar);
      const nonScalar = go(e.nonScalar);
      return scalar === e.scalar && nonScalar === e.nonScalar ? e : { ...e, scalar, nonScalar };
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
      const lower = prettifyOptional(e.lower, order);
      const upper = prettifyOptional(e.upper, order);
      return body === e.body && lower === e.lower && upper === e.upper
        ? e
        : { ...e, body, lower, upper };
    }

    case 'add': {
      const terms = mapAndSort(e.terms, go, order.compareTerms);
      return terms === e.terms ? e : { ...e, terms };
    }

    case 'scalarMul': {
      const factors = mapAndSort(e.factors, go, order.compareFactors);
      return factors === e.factors ? e : { ...e, factors };
    }
  }
}
