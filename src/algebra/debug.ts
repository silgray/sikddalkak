import type { TypedExpr } from './expression/node';
import { formatShape } from './shape/shape';
import type { SyntaxNode } from './parse/node';
import { literalKey } from './literal/literal';

/**
 * 사람이 읽는 트리 출력.
 *
 * 테스트 기대값과 랩 UI 진단 패널이 **같은 표현**을 쓰도록 여기 하나로 둔다.
 * 이 모듈에서 눈으로 봐야 할 건 결국 두 가지다: 어떤 구조로 묶였는가(syntax),
 * 각 노드가 **어떤 연산으로 해석됐고 모양이 무엇인가**(typed).
 */

/** Syntax IR → s-식. 어느 곱 기호였고 어떻게 묶였는지가 보인다. */
export function formatSyntax(node: SyntaxNode): string {
  switch (node.kind) {
    case 'num':
      return literalKey(node.value);
    case 'sym':
      return node.name;
    case 'matrix':
      return `[${node.rows.map((r) => r.map(formatSyntax).join(',')).join(';')}]`;
    case 'juxt':
      return `(juxt ${formatSyntax(node.left)} ${formatSyntax(node.right)})`;
    case 'cdot':
      return `(dot ${formatSyntax(node.left)} ${formatSyntax(node.right)})`;
    case 'times':
      return `(cross ${formatSyntax(node.left)} ${formatSyntax(node.right)})`;
    case 'add':
      return `(+ ${node.terms.map(formatSyntax).join(' ')})`;
    case 'neg':
      return `(- ${formatSyntax(node.operand)})`;
    case 'pow':
      return `(^ ${formatSyntax(node.base)} ${formatSyntax(node.exponent)})`;
    case 'frac':
      return `(/ ${formatSyntax(node.numerator)} ${formatSyntax(node.denominator)})`;
    case 'call':
      return `(${node.name} ${node.args.map(formatSyntax).join(' ')})`;
    case 'apply':
      return `(apply ${node.name} ${node.args.map(formatSyntax).join(' ')})`;
    case 'deriv':
      return `(deriv ${formatSyntax(node.body)} [${node.vars.join(',')}] ${node.order})`;
    case 'sum':
    case 'prod':
    case 'integral': {
      const lo = node.lower === null ? '_' : formatSyntax(node.lower);
      const hi = node.upper === null ? '_' : formatSyntax(node.upper);
      return `(${node.kind} ${formatSyntax(node.body)} ${node.variable} ${lo} ${hi})`;
    }
  }
}

/** Typed IR → s-식. **해석된 연산 이름**이 그대로 드러난다. */
export function formatTyped(e: TypedExpr): string {
  switch (e.op) {
    case 'num':
      return literalKey(e.value);

    case 'sym':
      return e.name;
    case 'matrix':
      return `[${e.rows.map((r) => r.map(formatTyped).join(',')).join(';')}]`;
    case 'add':
      return `(add ${e.terms.map(formatTyped).join(' ')})`;
    case 'neg':
      return `(neg ${formatTyped(e.operand)})`;
    case 'scalarMul':
      return `(scalarMul ${e.factors.map(formatTyped).join(' ')})`;
    case 'matMul':
      return `(matMul ${e.factors.map(formatTyped).join(' ')})`;
    case 'mul':
      return `(mul ${formatTyped(e.scalar)} ${formatTyped(e.nonScalar)})`;
    case 'dot':
      return `(dot ${formatTyped(e.left)} ${formatTyped(e.right)})`;
    case 'cross':
      return `(cross ${formatTyped(e.left)} ${formatTyped(e.right)})`;
    case 'transpose':
      return `(transpose ${formatTyped(e.operand)})`;
    case 'matPow':
      return `(matPow ${formatTyped(e.base)} ${formatTyped(e.exponent)})`;
    case 'scalarPow':
      return `(scalarPow ${formatTyped(e.base)} ${formatTyped(e.exponent)})`;
    case 'call':
      return `(${e.name} ${e.args.map(formatTyped).join(' ')})`;
    case 'apply':
      return `(apply ${e.name} ${e.args.map(formatTyped).join(' ')})`;
    case 'frac':
      return `(frac ${formatTyped(e.numerator)} ${formatTyped(e.denominator)})`;
    case 'matIdentity':
      return 'I';
    case 'deriv':
      return `(deriv ${formatTyped(e.body)} [${e.vars.join(',')}] ${e.order})`;
    case 'sum':
    case 'prod':
    case 'integral': {
      const lo = e.lower === null ? '_' : formatTyped(e.lower);
      const hi = e.upper === null ? '_' : formatTyped(e.upper);
      return `(${e.op} ${formatTyped(e.body)} ${e.variable} ${lo} ${hi})`;
    }
  }
}

/** Typed IR → 모양이 함께 붙은 s-식. 랩 진단 패널용. */
export function formatTypedWithShapes(e: TypedExpr): string {
  const inner = (() => {
    switch (e.op) {
      case 'num':
        return String(e.value);
      case 'sym':
        return e.name;
      case 'matrix':
        return `[${e.rows.map((r) => r.map(formatTypedWithShapes).join(',')).join(';')}]`;
      case 'add':
        return `(add ${e.terms.map(formatTypedWithShapes).join(' ')})`;
      case 'neg':
        return `(neg ${formatTypedWithShapes(e.operand)})`;
      case 'scalarMul':
        return `(scalarMul ${e.factors.map(formatTypedWithShapes).join(' ')})`;
      case 'matMul':
        return `(matMul ${e.factors.map(formatTypedWithShapes).join(' ')})`;
      case 'mul':
        return `(mul ${formatTypedWithShapes(e.scalar)} ${formatTypedWithShapes(e.nonScalar)})`;
      case 'dot':
        return `(dot ${formatTypedWithShapes(e.left)} ${formatTypedWithShapes(e.right)})`;
      case 'cross':
        return `(cross ${formatTypedWithShapes(e.left)} ${formatTypedWithShapes(e.right)})`;
      case 'transpose':
        return `(transpose ${formatTypedWithShapes(e.operand)})`;
      case 'matPow':
        return `(matPow ${formatTypedWithShapes(e.base)} ${formatTypedWithShapes(e.exponent)})`;
      case 'scalarPow':
        return `(scalarPow ${formatTypedWithShapes(e.base)} ${formatTypedWithShapes(e.exponent)})`;
      case 'call':
        return `(${e.name} ${e.args.map(formatTypedWithShapes).join(' ')})`;
      case 'apply':
        return `(apply ${e.name} ${e.args.map(formatTypedWithShapes).join(' ')})`;
      case 'frac':
        return `(frac ${formatTypedWithShapes(e.numerator)} ${formatTypedWithShapes(e.denominator)})`;
      case 'matIdentity':
        return 'I';
      case 'deriv':
        return `(deriv ${formatTypedWithShapes(e.body)} [${e.vars.join(',')}] ${e.order})`;
      case 'sum':
      case 'prod':
      case 'integral': {
        const lo = e.lower === null ? '_' : formatTypedWithShapes(e.lower);
        const hi = e.upper === null ? '_' : formatTypedWithShapes(e.upper);
        return `(${e.op} ${formatTypedWithShapes(e.body)} ${e.variable} ${lo} ${hi})`;
      }
    }
  })();
  return `${inner}:${formatShape(e.shape)}`;
}
