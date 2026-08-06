import type { TypedExpr } from './types-TypedExpr';
import { formatShape } from './types-shape';
import type { SyntaxNode } from './types-SyntaxNode';
import { literalKey } from './types-Literal';

/**
 * 사람이 읽는 트리 출력.
 *
 * 테스트 기대값과 랩 UI 진단 패널이 **같은 표현**을 쓰도록 여기 하나로 둔다.
 * 이 모듈에서 눈으로 봐야 할 건 결국 두 가지다: 어떤 구조로 묶였는가(syntax),
 * 각 노드가 **어떤 연산으로 해석됐고 모양이 무엇인가**(typed).
 */

/** Syntax IR → s-식. 어느 곱 기호였고 어떻게 묶였는지가 보인다. */
export function sexpSyntax(node: SyntaxNode): string {
  switch (node.kind) {
    case 'num':
      return literalKey(node.value);
    case 'sym':
      return node.name;
    case 'matrix':
      return `[${node.rows.map((r) => r.map(sexpSyntax).join(',')).join(';')}]`;
    case 'juxt':
      return `(juxt ${sexpSyntax(node.left)} ${sexpSyntax(node.right)})`;
    case 'cdot':
      return `(dot ${sexpSyntax(node.left)} ${sexpSyntax(node.right)})`;
    case 'times':
      return `(cross ${sexpSyntax(node.left)} ${sexpSyntax(node.right)})`;
    case 'add':
      return `(+ ${node.terms.map(sexpSyntax).join(' ')})`;
    case 'neg':
      return `(- ${sexpSyntax(node.operand)})`;
    case 'pow':
      return `(^ ${sexpSyntax(node.base)} ${sexpSyntax(node.exponent)})`;
    case 'frac':
      return `(/ ${sexpSyntax(node.numerator)} ${sexpSyntax(node.denominator)})`;
    case 'call':
      return `(${node.name} ${node.args.map(sexpSyntax).join(' ')})`;
    case 'diff':
      return `(diff ${sexpSyntax(node.body)} [${node.vars.join(',')}] ${node.order})`;
    case 'sum':
    case 'prod':
    case 'int': {
      const lo = node.lower === null ? '_' : sexpSyntax(node.lower);
      const hi = node.upper === null ? '_' : sexpSyntax(node.upper);
      return `(${node.kind} ${sexpSyntax(node.body)} ${node.variable} ${lo} ${hi})`;
    }
  }
}

/** Typed IR → s-식. **해석된 연산 이름**이 그대로 드러난다. */
export function sexpTyped(e: TypedExpr): string {
  switch (e.op) {
    case 'num':
      return literalKey(e.value);

    case 'sym':
      return e.name;
    case 'matrix':
      return `[${e.rows.map((r) => r.map(sexpTyped).join(',')).join(';')}]`;
    case 'add':
      return `(add ${e.terms.map(sexpTyped).join(' ')})`;
    case 'neg':
      return `(neg ${sexpTyped(e.operand)})`;
    case 'scalarMul':
      return `(scalarMul ${e.factors.map(sexpTyped).join(' ')})`;
    case 'matMul':
      return `(matMul ${e.factors.map(sexpTyped).join(' ')})`;
    case 'mul':
      return `(mul ${sexpTyped(e.scalar)} ${sexpTyped(e.matrix)})`;
    case 'dot':
      return `(dot ${sexpTyped(e.left)} ${sexpTyped(e.right)})`;
    case 'cross':
      return `(cross ${sexpTyped(e.left)} ${sexpTyped(e.right)})`;
    case 'transpose':
      return `(transpose ${sexpTyped(e.operand)})`;
    case 'matPow':
      return `(matPow ${sexpTyped(e.base)} ${sexpTyped(e.exponent)})`;
    case 'scalarPow':
      return `(scalarPow ${sexpTyped(e.base)} ${sexpTyped(e.exponent)})`;
    case 'call':
      return `(${e.name} ${e.args.map(sexpTyped).join(' ')})`;
    case 'frac':
      return `(frac ${sexpTyped(e.numerator)} ${sexpTyped(e.denominator)})`;
    case 'matIdentity':
      return 'I';
    case 'deriv':
      return `(deriv ${sexpTyped(e.body)} [${e.vars.join(',')}] ${e.order})`;
    case 'sum':
    case 'prod':
    case 'integral': {
      const lo = e.lower === null ? '_' : sexpTyped(e.lower);
      const hi = e.upper === null ? '_' : sexpTyped(e.upper);
      return `(${e.op} ${sexpTyped(e.body)} ${e.variable} ${lo} ${hi})`;
    }
  }
}

/** Typed IR → 모양이 함께 붙은 s-식. 랩 진단 패널용. */
export function sexpTypedWithShapes(e: TypedExpr): string {
  const inner = (() => {
    switch (e.op) {
      case 'num':
        return String(e.value);
      case 'sym':
        return e.name;
      case 'matrix':
        return `[${e.rows.map((r) => r.map(sexpTypedWithShapes).join(',')).join(';')}]`;
      case 'add':
        return `(add ${e.terms.map(sexpTypedWithShapes).join(' ')})`;
      case 'neg':
        return `(neg ${sexpTypedWithShapes(e.operand)})`;
      case 'scalarMul':
        return `(scalarMul ${e.factors.map(sexpTypedWithShapes).join(' ')})`;
      case 'matMul':
        return `(matMul ${e.factors.map(sexpTypedWithShapes).join(' ')})`;
      case 'mul':
        return `(mul ${sexpTypedWithShapes(e.scalar)} ${sexpTypedWithShapes(e.matrix)})`;
      case 'dot':
        return `(dot ${sexpTypedWithShapes(e.left)} ${sexpTypedWithShapes(e.right)})`;
      case 'cross':
        return `(cross ${sexpTypedWithShapes(e.left)} ${sexpTypedWithShapes(e.right)})`;
      case 'transpose':
        return `(transpose ${sexpTypedWithShapes(e.operand)})`;
      case 'matPow':
        return `(matPow ${sexpTypedWithShapes(e.base)} ${sexpTypedWithShapes(e.exponent)})`;
      case 'scalarPow':
        return `(scalarPow ${sexpTypedWithShapes(e.base)} ${sexpTypedWithShapes(e.exponent)})`;
      case 'call':
        return `(${e.name} ${e.args.map(sexpTypedWithShapes).join(' ')})`;
      case 'frac':
        return `(frac ${sexpTypedWithShapes(e.numerator)} ${sexpTypedWithShapes(e.denominator)})`;
      case 'matIdentity':
        return 'I';
      case 'deriv':
        return `(deriv ${sexpTypedWithShapes(e.body)} [${e.vars.join(',')}] ${e.order})`;
      case 'sum':
      case 'prod':
      case 'integral': {
        const lo = e.lower === null ? '_' : sexpTypedWithShapes(e.lower);
        const hi = e.upper === null ? '_' : sexpTypedWithShapes(e.upper);
        return `(${e.op} ${sexpTypedWithShapes(e.body)} ${e.variable} ${lo} ${hi})`;
      }
    }
  })();
  return `${inner}:${formatShape(e.shape)}`;
}
