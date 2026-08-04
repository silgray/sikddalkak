import type { Env, TypedExpr } from './elaborate';
import { exprKey } from './normal';
import { normalize } from './normalize';
import { foldMatrices } from './matrixFold';
import { simplify, substitute } from './rewrite';
import { ok, type Result } from './types-result';

/**
 * 셀 하나를 값으로 접는다. **치환은 안 한다** — 어떤 이름을 무엇으로 바꿀지는 호출자
 * (그래프 층) 몫이다. 이 함수가 아는 건 식 하나와 그 모양 환경뿐이다.
 *
 * 파이프라인: `normalize` (입력 형태 불문 항상 평탄화된 상태로) → `foldMatrices`
 * (리터럴 행렬 산술) → `simplify` (순수 스칼라는 CE로, 마지막에 거듭제곱 접기까지).
 * 맨 앞의 `normalize` 는 `foldMatrices` 가 n-항 `matMul`/`scalarMul` 이 평탄화돼
 * 있다고 가정하기 때문이다 — `substituteDeep` 처럼 트리를 다시 조립하는 경로를 거친
 * 입력도 안전하게 받으려면 여기서 한 번 더 다져야 한다.
 */
export function evaluate(e: TypedExpr, env: Env): Result<TypedExpr> {
  const normalized = normalize(e);
  if (!normalized.ok) return normalized;
  const folded = foldMatrices(normalized.value);
  if (!folded.ok) return folded;
  return simplify(folded.value, env);
}

/** 무한 루프 방어용 상한. 진짜 순환 검출(`a=b`, `b=a`)은 그래프 층이 이름 단위로 한다. */
const MAX_SUBSTITUTION_DEPTH = 64;

/**
 * 정의된 심볼을 그 정의로 **끝까지** 바꾼다.
 *
 * [`substitute`](./rewrite.ts) 는 한 단계만 한다 — `bindings` 가 전이적으로 안 풀려
 * 있어서(`B = A^T` 는 `transpose(sym A)` 로 저장된다) `Bv` 같은 식은 한 번 치환으로
 * `A^Tv` 가 안 되고 그대로 남을 수 있다. 고정점(더 바뀌지 않을 때)까지 반복한다.
 *
 * `exprKey` 로 구조가 안 바뀌었는지 본다 — 값을 비교하는 게 아니라 **더 치환할 게
 * 없다**는 뜻이라 정확하다.
 */
export function substituteDeep(e: TypedExpr, env: Env): Result<TypedExpr> {
  let current = e;
  for (let i = 0; i < MAX_SUBSTITUTION_DEPTH; i += 1) {
    const next = substitute(current, env);
    if (!next.ok) return next;
    if (exprKey(next.value) === exprKey(current)) return ok(next.value);
    current = next.value;
  }
  // 상한에 닿았다 — 순환일 가능성이 높지만, 순환 판정은 이름 단위 그래프의 몫이라
  // 여기서는 지금까지 치환된 상태를 조용히 돌려준다 (무한 루프만 막으면 된다).
  return ok(current);
}

/** `sym` 노드 이름을 전부 모은다. 그래프 층의 의존 간선이 될 값이다. */
export function freeSymbols(e: TypedExpr): readonly string[] {
  const names = new Set<string>();
  const walk = (node: TypedExpr): void => {
    switch (node.op) {
      case 'num':
      case 'matIdentity':
        return;
      case 'sym':
        names.add(node.name);
        return;
      case 'matrix':
        node.rows.forEach((row) => row.forEach(walk));
        return;
      case 'add':
        node.terms.forEach(walk);
        return;
      case 'neg':
        walk(node.operand);
        return;
      case 'scalarMul':
      case 'matMul':
        node.factors.forEach(walk);
        return;
      case 'mul':
        walk(node.scalar);
        walk(node.matrix);
        return;
      case 'dot':
      case 'cross':
        walk(node.left);
        walk(node.right);
        return;
      case 'transpose':
        walk(node.operand);
        return;
      case 'matPow':
        walk(node.base);
        return;
      case 'scalarPow':
        walk(node.base);
        walk(node.exponent);
        return;
      case 'call':
        node.args.forEach(walk);
        return;
      case 'frac':
        walk(node.numerator);
        walk(node.denominator);
        return;
    }
  };
  walk(e);
  return [...names].sort();
}
