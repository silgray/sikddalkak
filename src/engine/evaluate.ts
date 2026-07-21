import { isFunction, isSymbol } from '@cortex-js/compute-engine';
import type { Expression } from '@cortex-js/compute-engine';
import { ce } from './ce';
import type { Cell, EvalResult } from '../types';

type Bindings = Record<string, Expression>;

/**
 * `a = 3` 처럼 좌변이 단일 심볼인 Equal 식이면 정의로 본다.
 * `x^2 = 4` 처럼 좌변이 식이면 정의가 아니라 그냥 방정식.
 */
function asDefinition(expr: Expression): { name: string; value: Expression } | null {
  if (expr.operator !== 'Equal' || !isFunction(expr) || expr.nops !== 2) return null;
  const [lhs, rhs] = expr.ops;
  if (!isSymbol(lhs)) return null;
  return { name: lhs.symbol, value: rhs };
}

function isMatrixLike(expr: Expression): boolean {
  return expr.operator === 'Matrix' || String(expr.type).startsWith('matrix');
}

/**
 * 행렬 연산의 결과는 `Matrix`가 아니라 `List`의 `List`로 나온다.
 * 그대로 두면 `[[4, 4], [4, 4]]` 처럼 렌더되므로 다시 Matrix로 감싼다.
 * 진짜 리스트(`[1, 2, 3]`)는 원소가 List가 아니므로 건드리지 않는다.
 */
function asMatrixIfRows(expr: Expression): Expression {
  if (expr.operator !== 'List') return expr;
  const json: unknown = expr.json;
  if (!Array.isArray(json) || json.length < 2) return expr;
  const rows: unknown[] = json.slice(1);
  if (!rows.every((row) => Array.isArray(row) && row[0] === 'List')) return expr;
  return ce.box(['Matrix', expr.json]);
}

/**
 * simplify는 심볼릭 정리(약분, 삼각 항등식)를, evaluate는 실제 연산(행렬 곱/거듭제곱,
 * 유리수 계산)을 한다. 둘 다 필요하다. 순서가 중요한데, evaluate를 먼저 돌리면
 * `\frac{x^2-1}{x-1}` 이 약분되지 않고 `\sin^2+\cos^2` 도 1이 되지 않는다.
 */
function reduce(expr: Expression): Expression {
  return asMatrixIfRows(expr.simplify().evaluate());
}

/** `["Error", "'unexpected-operator'", …]` 에서 코드만 뽑아 읽을 만한 문자열로. */
function errorMessage(expr: Expression): string {
  const codes = expr.errors.map((e) => {
    const json = e.json as unknown;
    if (Array.isArray(json) && typeof json[1] === 'string') {
      return json[1].replace(/^'|'$/g, '');
    }
    return 'invalid-expression';
  });
  return codes.length > 0 ? [...new Set(codes)].join(', ') : 'invalid-expression';
}

function evaluateCell(cell: Cell, bindings: Bindings): EvalResult {
  const latex = cell.input.trim();
  if (latex === '') return { kind: 'empty' };

  let expr: Expression;
  try {
    expr = ce.parse(latex);
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
  if (!expr.isValid) return { kind: 'error', message: errorMessage(expr) };

  try {
    const def = asDefinition(expr);
    if (def !== null) {
      // 정의 셀은 mode와 무관하게 항상 바인딩을 만든다.
      // 이미 쌓인 바인딩을 먼저 치환해서 전이 참조(a=3, b=a+1)를 해소한다.
      // 뒤쪽 셀만 참조하므로 순환은 구조적으로 불가능하다.
      const value = reduce(def.value.subs(bindings));
      bindings[def.name] = value;
      // 아래 셀들이 이 심볼을 파싱할 때 행렬로 알아보게 한다. 이걸 안 하면
      // CE가 `a`를 스칼라로 보고 곱셈 피연산자를 정렬해버려서
      // `(2x2) a` 가 `a (2x2)` 로 뒤집힌다 — 행렬곱은 교환법칙이 없으므로 오답이다.
      if (isMatrixLike(value)) ce.declare(def.name, 'matrix');
      return {
        kind: 'ok',
        latex: `${def.name} = ${value.latex}`,
        json: value.json,
        definitionName: def.name,
      };
    }

    const base = cell.mode === 'scoped' ? expr.subs(bindings) : expr;
    const result = reduce(base);
    return { kind: 'ok', latex: result.latex, json: result.json, definitionName: null };
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 셀 스택 전체를 위에서 아래로 평가한다.
 *
 * 재계산은 항상 전체를 다시 돌린다. 셀 수십 개 규모에서는 즉시 끝나므로
 * 의존성 그래프를 만들지 않는다. 위 셀이 바뀌면 아래가 따라 바뀌는 동작이
 * 이 단순 전략에서 공짜로 나온다.
 */
export function evaluateCells(cells: readonly Cell[]): EvalResult[] {
  // 정의 셀은 심볼 타입을 엔진에 declare해야 해서 (isMatrixLike 참고) 전역 스코프가
  // 오염된다. 매 평가를 스코프로 감싸 declare가 이 패스 안에서만 살아있게 한다.
  // ce.forget()은 선언 자체를 되돌리지 못하므로 스코프여야 한다.
  ce.pushScope();
  try {
    const bindings: Bindings = {};
    return cells.map((cell) =>
      cell.committed ? evaluateCell(cell, bindings) : { kind: 'empty' as const },
    );
  } finally {
    ce.popScope();
  }
}
