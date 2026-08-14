import {
  buildAdd,
  buildCross,
  buildDeriv,
  buildDot,
  buildFrac,
  buildIntegral,
  buildMul,
  buildMulAll,
  buildNeg,
  buildProd,
  buildSum,
  buildTranspose,
} from './builders';
import { fail, ok, type Result } from '../result/result';
import { SCALAR, isScalar, isSquare } from '../shape/shape';
import type { TypedExpr } from './node';

/**
 * Typed IR 순회.
 *
 * 조립에 `builders.ts` 의 **같은 생성자**를 쓰는 게 요점이다 — 재작성이 모양을 깨뜨리면
 * 조립 단계에서 오류가 나므로 잘못된 트리가 조용히 빠져나가지 못한다. 그래서 이 파일이
 * `transform/` 이 아니라 빌더 옆에 있다.
 */

/** 자식들에 `f` 를 적용하고 다시 조립한다. */
export function mapChildren(
  e: TypedExpr,
  f: (child: TypedExpr) => Result<TypedExpr>,
): Result<TypedExpr> {
  switch (e.op) {
    case 'num':
    case 'sym':
    case 'matIdentity':
      return ok(e);

    case 'matrix': {
      const rows: TypedExpr[][] = [];
      for (const row of e.rows) {
        const cells: TypedExpr[] = [];
        for (const cell of row) {
          const mapped = f(cell);
          if (!mapped.ok) return mapped;
          if (!isScalar(mapped.value.shape)) {
            return fail('shape-mismatch', 'A matrix entry must be a scalar');
          }
          cells.push(mapped.value);
        }
        rows.push(cells);
      }
      return ok({ op: 'matrix', shape: e.shape, rows });
    }

    case 'add': {
      const terms: TypedExpr[] = [];
      for (const term of e.terms) {
        const mapped = f(term);
        if (!mapped.ok) return mapped;
        terms.push(mapped.value);
      }
      return buildAdd(terms);
    }

    case 'neg': {
      const inner = f(e.operand);
      return inner.ok ? ok(buildNeg(inner.value)) : inner;
    }

    case 'scalarMul':
    case 'matMul': {
      const mapped: TypedExpr[] = [];
      for (const factor of e.factors) {
        const result = f(factor);
        if (!result.ok) return result;
        mapped.push(result.value);
      }
      return buildMulAll(mapped);
    }

    case 'mul': {
      const scalar = f(e.scalar);
      if (!scalar.ok) return scalar;
      const matrix = f(e.nonScalar);
      if (!matrix.ok) return matrix;
      return buildMul(scalar.value, matrix.value);
    }

    case 'dot':
    case 'cross': {
      const left = f(e.left);
      if (!left.ok) return left;
      const right = f(e.right);
      if (!right.ok) return right;
      const combine = e.op === 'dot' ? buildDot : buildCross;
      return combine(left.value, right.value);
    }

    case 'transpose': {
      const inner = f(e.operand);
      return inner.ok ? buildTranspose(inner.value) : inner;
    }

    case 'matPow': {
      const base = f(e.base);
      if (!base.ok) return base;
      if (!isSquare(base.value.shape)) {
        return fail('shape-mismatch', 'A matrix power needs a square base');
      }
      // 지수도 재작성을 태운다 — 이걸 해야 `simplify` 가 `A^{1+2}` 의 지수를 접는다.
      const exponent = f(e.exponent);
      if (!exponent.ok) return exponent;
      if (!isScalar(exponent.value.shape)) {
        return fail('shape-mismatch', 'An exponent must be a scalar');
      }
      return ok({
        op: 'matPow',
        shape: base.value.shape,
        base: base.value,
        exponent: exponent.value,
      });
    }

    case 'scalarPow': {
      const base = f(e.base);
      if (!base.ok) return base;
      const exponent = f(e.exponent);
      if (!exponent.ok) return exponent;
      if (!isScalar(base.value.shape) || !isScalar(exponent.value.shape)) {
        return fail('shape-mismatch', 'A scalar power needs scalar operands');
      }
      return ok({ op: 'scalarPow', shape: SCALAR, base: base.value, exponent: exponent.value });
    }

    // `det`/`tr` 은 정사각 행렬 인수를 받는다 — 그래서 `apply` 와 같은 이유로 인수
    // 모양을 강제하지 않는다: 재작성(`substitute` 등)은 심볼을 같은 모양의 값으로만
    // 바꾸므로(`buildEnv` 가 심볼마다 모양을 하나로 고정한다) 인수 모양이 바뀔 일이
    // 없다 — 애초의 모양 검사는 `elaborate.ts` 의 `MATRIX_ARG_FUNCTIONS` 분기가 끝냈다.
    case 'call': {
      const args: TypedExpr[] = [];
      for (const arg of e.args) {
        const mapped = f(arg);
        if (!mapped.ok) return mapped;
        args.push(mapped.value);
      }
      return ok({ op: 'call', shape: SCALAR, name: e.name, args });
    }

    // `call` 과 다르다 — 사용자 함수는 인수가 스칼라가 아닐 수 있고(모양은 함수 정의에
    // 달렸다), 모양을 다시 정하려면 `env`(와 함수 정의)가 있어야 하는데 `mapChildren`
    // 은 그걸 모른다. 그래서 **모양은 원래 값을 그대로 지킨다** — 안전한 이유는 이
    // 함수를 부르는 재작성(`substitute` 등)이 심볼을 그 심볼과 **같은 모양의** 값으로만
    // 바꾸기 때문이다(`buildEnv` 가 심볼마다 모양을 하나로 고정한다) — 인수 모양이
    // 바뀔 일이 없다.
    case 'apply': {
      const args: TypedExpr[] = [];
      for (const arg of e.args) {
        const mapped = f(arg);
        if (!mapped.ok) return mapped;
        args.push(mapped.value);
      }
      return ok({ op: 'apply', shape: e.shape, name: e.name, args });
    }

    case 'frac': {
      const numerator = f(e.numerator);
      if (!numerator.ok) return numerator;
      const denominator = f(e.denominator);
      if (!denominator.ok) return denominator;
      return buildFrac(numerator.value, denominator.value);
    }

    case 'deriv': {
      const body = f(e.body);
      if (!body.ok) return body;
      return buildDeriv(body.value, e.vars, e.order);
    }

    case 'sum':
    case 'prod':
    case 'integral': {
      const body = f(e.body);
      if (!body.ok) return body;
      const lower = e.lower !== null ? f(e.lower) : null;
      if (lower !== null && !lower.ok) return lower;
      const upper = e.upper !== null ? f(e.upper) : null;
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
