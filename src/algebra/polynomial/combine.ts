import { addLit, mulLit } from '../literal/arith';
import type { TypedExpr } from '../expression/node';
import { monomialKey, type Monomial, type Polynomial } from './polynomial';

/**
 * 다항식 안에서 항·계수를 합치는 두 가지.
 *
 * 둘 다 **실패하면 합치지 않고 그대로 남긴다** — 값을 뭉개느니 항이 둘로 남는 게 낫다
 * (`literal/arith.ts` 의 "실패 = 무변경" 관례).
 */

/**
 * 스칼라 인수로 섞여 들어온 순수 숫자를 수치 계수로 흡수한다.
 *
 * CE가 `3^2` 를 `9` 로 정리해 돌려주면 그 `9` 는 스칼라 인수 자리에 앉는다. 그대로 두면
 * 계수 `3` 과 인수 `9` 가 나란히 렌더돼 `3\cdot 9…` 같은 게 나오고, `\cdot` 는 병치보다
 * 느슨해서 다시 읽을 때 묶음이 달라진다. 애초에 하나로 합치는 게 맞다.
 */
export function foldNumericScalars(p: Polynomial): Polynomial {
  return p.map((m) => {
    let coefficient = m.coefficient;
    const scalars: TypedExpr[] = [];
    for (const s of m.scalars) {
      // 곱이 실패하면(안전 정수 밖 등) 흡수하지 않고 인수로 남긴다.
      const folded = s.op === 'num' ? mulLit(coefficient, s.value) : null;
      if (folded !== null) coefficient = folded;
      else scalars.push(s);
    }
    return { coefficient, scalars, nonScalars: m.nonScalars };
  });
}

/**
 * 같은 인수 열을 가진 항들을 합친다. 순서는 처음 나온 순서를 유지한다.
 *
 * 계수 덧셈이 실패하면(안전 정수 밖 등) **합치지 않고 따로 남긴다**.
 */
export function combineLikeTerms(p: Polynomial): Polynomial {
  const slots: Monomial[] = [];
  /** 동류항 키 -> 합칠 수 있는 칸의 위치. */
  const openSlot = new Map<string, number>();
  for (const m of p) {
    const key = monomialKey(m);
    const at = openSlot.get(key);
    if (at === undefined) {
      openSlot.set(key, slots.length);
      slots.push(m);
      continue;
    }
    const sum = addLit(slots[at].coefficient, m.coefficient);
    if (sum !== null) {
      slots[at] = { ...slots[at], coefficient: sum };
    } else {
      // 이 칸은 더 이상 합칠 대상이 아니다 — 뒤에 같은 키가 또 오면 새 칸에 쌓는다.
      openSlot.set(key, slots.length);
      slots.push(m);
    }
  }
  return slots;
}
