import {
  buildCross,
  buildDeriv,
  buildDot,
  buildIntegral,
  buildNum,
  buildProd,
  buildSum,
  buildTranspose,
} from '../expr/builders';
import { constantInteger, literalOf } from '../expr/key';
import { ok, type Result } from '../result/result';
import { SCALAR, isKnownShape } from '../shape/shape';
import type { TypedExpr } from '../expr/node';
import { asInteger, intLit, ONE as ONE_LIT } from '../literal/literal';
import { mulLit, powLit } from '../literal/arith';
import { asSingleMatrix, buildProduct, collect, normalizeNeg, normalizeProduct } from './product';
import { normalizeAdd } from './add';
import { normalizeFrac } from './frac';

/**
 * Normalize — elaborate가 둘씩만 담아둔 곱을 대수적으로 정리하는 별도 패스.
 *
 * elaborate는 **모양을 알아야만 할 수 있는 판정**(연산 해석·차원 검사)만 하고, 곱을
 * 정규화 없이 그대로 중첩해 둔다 (`A(BC)` → `matMul(A, matMul(B,C))`). 이 패스는 그
 * 결과를 받아 **모양을 몰라도 되는 순수 대수 규칙**을 적용한다:
 *
 *  1. 평탄화 — 중첩된 `scalarMul`/`matMul` 을 하나의 n-항 목록으로 편다 (`product.ts`)
 *  2. 스칼라 끌어올리기 — `dot`/`cross`/`transpose`/곱을 뚫고 스칼라를 최상단으로
 *  3. `neg` 흡수 — 부호를 스칼라 계수의 부호로
 *  4. 숫자 접기 + 정렬 — 숫자 리터럴을 하나로 묶어 맨 앞에, 나머지 스칼라는 `exprKey` 순
 *  5. 항등원 제거 — 인수 열에서 `I` 를 걷어낸다
 *  6. 축약 — 1원소 `scalarMul`/`matMul` 은 그 원소 자체로
 *  7. **덧셈 항 합치기 + 정렬** — 동류항을 합치고(`2A+3A` → `5A`) 항 순서를 고정 (`add.ts`)
 *
 * ⚠ **7 때문에 `parse()` 는 순수한 구조 정규화가 아니다.** `parse("A+A")` 는 `2A` 를,
 * `parse("1+2")` 는 `3` 을 돌려준다 — 의미를 보존하는 재작성이지만 사용자가 쓴 글자
 * 그대로는 아니다. 대신 **분배는 절대 하지 않는다**: `(A+B)C + (A+B)C` 는 `2(A+B)C` 이지
 * `2AC+2BC` 가 아니다.
 *
 * **거듭제곱 접기는 항상 켜져 있다** (`foldPowers` 기본값이 `true`, 호출부 전부 그대로 쓴다).
 *  - 행렬: **이웃한** 같은 밑만 접는다 — `AAABBA` → `A³B²A` (비가환이라 떨어진 건 못 모은다),
 *    지수 합이 0이면 소거 (`AA^{-1}` → `I`)
 *  - 스칼라: 교환 가능하므로 **떨어져 있어도 모아서** 접는다 — `xxxyyx` → `x⁴y²`
 *
 * 둘 다 **상수 정수 지수만** 합산한다. `x^a x^b` 처럼 지수가 심볼이면 건드리지 않는다.
 *
 * ## 파일 구성
 *
 * 케이스가 16개지만 성격은 여섯이다. 덩치 큰 셋을 따로 뒀다:
 * `product.ts`(곱) · `add.ts`(덧셈) · `frac.ts`(분수). 여기 남은 건 디스패처와, 짧아서
 * 나눌 이유가 없는 셋 — 모양 연산(`dot`/`cross`/`transpose`), 거듭제곱, 잎·불투명 노드다.
 *
 * **핸들러는 `normalize` 를 import 하지 않는다.** 자식 재귀가 필요하면 `recur` 를 인자로
 * 받는다 — 그래야 `normalize ↔ product` 순환이 안 생긴다.
 */

/**
 * Typed IR을 받아 평탄화·스칼라 호이스팅·정렬·항등원 제거를 적용한 Typed IR을 낸다.
 *
 * `foldPowers` 는 이웃한 같은 인수를 `matPow` 로 접을지 정한다. **기본값 `true` 이고
 * 지금 호출부 7곳이 전부 그대로 쓴다** — 접는 게 정규화 단계에서 맞는 동작이다.
 * (인자는 "안 접는 모드"가 다시 필요해질 때를 위해 남겨뒀다.)
 *
 * `key` 는 덧셈 항 정렬 키를 갈아끼우는 실험용 훅이다. **자식 재귀에는 전달되지 않는다** —
 * 최상위 `add` 한 번에만 걸린다.
 */
export function normalize(
  e: TypedExpr,
  foldPowers = true,
): Result<TypedExpr> {
  const recur = (child: TypedExpr): Result<TypedExpr> => normalize(child, foldPowers);

  switch (e.op) {
    // --- 잎 ---
    case 'num':
    case 'sym':
      return ok(e);

    // 끝까지 아무도 크기를 알려주지 않은 항등원은 (1,1)로 굳힌다 — I 혼자 쓰면 스칼라
    // 1과 같다는 뜻.
    case 'matIdentity':
      return ok(isKnownShape(e.shape) ? e : { op: 'matIdentity', shape: SCALAR });

    // --- 덩치 큰 셋은 따로 ---
    case 'add':
      return normalizeAdd(e, recur);

    case 'neg':
      return normalizeNeg(e, foldPowers, recur);

    case 'scalarMul':
    case 'matMul':
    case 'mul':
      return normalizeProduct(e, foldPowers, recur);

    case 'frac':
      return normalizeFrac(e, foldPowers, recur);

    // --- 모양 연산 — 스칼라를 빼내고 비스칼라만 다시 결합한다 ---
    case 'dot':
    case 'cross': {
      const leftR = recur(e.left);
      if (!leftR.ok) return leftR;
      const rightR = recur(e.right);
      if (!rightR.ok) return rightR;
      const cl = collect(leftR.value);
      const cr = collect(rightR.value);

      const leftCore = asSingleMatrix(cl.factors);
      if (!leftCore.ok) return leftCore;
      const rightCore = asSingleMatrix(cr.factors);
      if (!rightCore.ok) return rightCore;
      const combine = e.op === 'dot' ? buildDot : buildCross;
      const core = combine(leftCore.value, rightCore.value);
      if (!core.ok) return core;
      const merged = collect(core.value);

      // 세 계수를 한 번에 곱한다. 하나라도 실패하면 접지 않고 인수로 남긴다.
      const pair = mulLit(cl.numeric, cr.numeric);
      const all = pair === null ? null : mulLit(pair, merged.numeric);
      const carried =
        all !== null
          ? []
          : [buildNum(cl.numeric), buildNum(cr.numeric), buildNum(merged.numeric)];
      return ok(
        buildProduct(
          all ?? ONE_LIT,
          [...cl.scalars, ...cr.scalars, ...merged.scalars, ...carried],
          merged.factors,
          foldPowers,
        ),
      );
    }

    case 'transpose': {
      const inner = recur(e.operand);
      if (!inner.ok) return inner;
      const c = collect(inner.value);
      const operand = asSingleMatrix(c.factors);
      if (!operand.ok) return operand;
      const t = buildTranspose(operand.value);
      if (!t.ok) return t;
      return ok(buildProduct(c.numeric, c.scalars, [t.value], foldPowers));
    }

    // --- 거듭제곱 ---
    // `matPow`의 밑은 일부러 뚫지 않는다 — `(kA)^n` 을 `k^n A^n` 으로 바꾸려면 지수가
    // 스칼라 거듭제곱까지 새로 만들어야 해서 이번 범위 밖이다.
    case 'matPow': {
      const base = recur(e.base);
      if (!base.ok) return base;
      // I^n = I.
      if (base.value.op === 'matIdentity') return ok(base.value);
      const exponent = recur(e.exponent);
      if (!exponent.ok) return exponent;
      // 정수로 확정되면 **단일 리터럴로 되돌려 담는다.** 일반 정규화를 거친 `-1` 은
      // `buildProduct` 의 부호 호이스팅 때문에 `neg(num 1)` 이 되는데, 그러면 s-식이
      // `(matPow A (neg 1))` 이 되어 기존 기대값(`(matPow A -1)`)과 어긋난다.
      const n = constantInteger(exponent.value);
      const folded = n === null ? exponent.value : buildNum(intLit(n));
      // A^0 은 항등원 — elaborate 가 이미 걸렀지만, 정리 뒤에 0이 될 수도 있다.
      if (n === 0) return ok({ op: 'matIdentity', shape: e.shape });
      if (n === 1) return ok(base.value);
      return ok({ op: 'matPow', shape: e.shape, base: base.value, exponent: folded });
    }

    case 'scalarPow': {
      const base = recur(e.base);
      if (!base.ok) return base;
      const exponent = recur(e.exponent);
      if (!exponent.ok) return exponent;
      // 리터럴^정수리터럴 은 값으로 접는다. 곱에서 숫자를 접는 것(`collect`)과 같은
      // "숫자 접기" 이고, **복소수는 여기서만 접힌다** — `ceSimplify` 는 `i^{2}` 를
      // 안 풀어준다(실측: `["Power",["Complex",0,1],2]` 그대로). `literal/arith.ts` 는
      // `ce.box(...).evaluate()` 를 쓰므로 `-1` 이 나온다.
      //
      // `literalOf` 로 밑·지수 둘 다 **`neg(num)` 도** 받는다 — `num` 만 보면
      // `\left(-2\right)^3` (트리로는 `scalarPow(neg(2),3)`) 이 여기서 안 접힌 채로
      // 렌더 `-2^{3}` 을 냈다가, **재파싱할 때는** CE가 델리미터 없는 `-2` 를 음수
      // 리터럴 `num(-2)` 하나로 읽어(실측) 그제서야 접혀 `-8` 이 되는 왕복 불일치가
      // 있었다(`\sum`/`\prod` 처럼 본문을 CE에 안 넘기는 불투명 노드 안에서 fuzz가 잡음).
      // `neg(scalarPow(...))`(바깥 단항 마이너스)는 이 case가 아니라 `neg` case를 타므로
      // 안 섞인다 — `(-2)^3` 과 `-(2^3)` 은 계속 다른 트리다.
      const baseLit = literalOf(base.value);
      const expLit = literalOf(exponent.value);
      if (baseLit !== null && expLit !== null) {
        const n = asInteger(expLit);
        const folded = n === null ? null : powLit(baseLit, n);
        if (folded !== null) return ok(buildNum(folded));
      }
      return ok({ op: 'scalarPow', shape: SCALAR, base: base.value, exponent: exponent.value });
    }

    // --- 불투명 노드 — 자식만 재귀하고 그대로 다시 조립한다 ---
    case 'matrix': {
      const rows: TypedExpr[][] = [];
      for (const row of e.rows) {
        const newRow: TypedExpr[] = [];
        for (const cell of row) {
          const r = recur(cell);
          if (!r.ok) return r;
          newRow.push(r.value);
        }
        rows.push(newRow);
      }
      return ok({ op: 'matrix', shape: e.shape, rows });
    }

    case 'call': {
      const args: TypedExpr[] = [];
      for (const a of e.args) {
        const r = recur(a);
        if (!r.ok) return r;
        args.push(r.value);
      }
      return ok({ op: 'call', shape: SCALAR, name: e.name, args });
    }

    // `call` 과 같은 취급 — 원자 하나로 두고 인수만 재귀한다. 모양은 정규화로
    // 안 바뀐다(호출부 모양은 elaborate가 이미 확정했다).
    case 'apply': {
      const args: TypedExpr[] = [];
      for (const a of e.args) {
        const r = recur(a);
        if (!r.ok) return r;
        args.push(r.value);
      }
      return ok({ op: 'apply', shape: e.shape, name: e.name, args });
    }

    // 본문(그리고 상하한)을 재귀 정규화만 하고 재조립한다. **바운드 경계를 넘는 스칼라
    // 호이스팅은 없다** — `collect`/`buildProduct` 는 이 네 op를 몰라서(default 분기가
    // 불투명 원자로 취급) 애초에 안까지 파고들지 않는다. `\sum_k(kA)` 의 `k` 가 상수처럼
    // 밖으로 끌려나오지 않는 이유가 그거다.
    case 'deriv': {
      const body = recur(e.body);
      if (!body.ok) return body;
      return buildDeriv(body.value, e.vars, e.order);
    }

    case 'sum':
    case 'prod':
    case 'integral': {
      const body = recur(e.body);
      if (!body.ok) return body;
      const lower = e.lower !== null ? recur(e.lower) : null;
      if (lower !== null && !lower.ok) return lower;
      const upper = e.upper !== null ? recur(e.upper) : null;
      if (upper !== null && !upper.ok) return upper;
      const build = e.op === 'sum' ? buildSum : e.op === 'prod' ? buildProd : buildIntegral;
      return build(
        body.value,
        e.variable,
        lower === null ? null : lower.value,
        upper === null ? null : upper.value,
      );
    }
  }
}
