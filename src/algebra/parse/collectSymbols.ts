import type { SyntaxNode } from './node';

/**
 * Syntax IR에서 이름을 전부 긁는다.
 *
 * `transform/evaluate.ts` 의 `collectFreeSymbols`(Typed IR 버전)와 목적이 같지만
 * **elaborate 이전**에, `env` 없이 돈다 — `cellGraph.ts` 의 `dependencyNames` 가
 * `parse` 실패(예: 미정의 함수를 가리키는 `f'(x)`, `env.functions` 없이는 elaborate가
 * 정직하게 오류를 낸다)를 만났을 때 그래도 의존 간선을 뽑기 위한 폴백이다. `parse` 가
 * 성공하는 흔한 경우는 지금처럼 `collectFreeSymbols` 를 그대로 쓴다.
 *
 * `collectFreeSymbols` 와 같은 규율로 **바운드 이름도 포함시킨다** — 캐시 지문이
 * 이 간선 위에 걸려 있어서다(그 파일의 `deriv` 케이스 문서 참고: 바운드 이름을 빼면
 * 나중에 그 이름의 셀이 추가돼도 무효화가 안 된다).
 */
export function collectSyntaxSymbols(node: SyntaxNode): readonly string[] {
  const names = new Set<string>();
  const walk = (n: SyntaxNode): void => {
    switch (n.kind) {
      case 'num':
        return;
      case 'sym':
        names.add(n.name);
        return;
      case 'matrix':
        n.rows.forEach((row) => row.forEach(walk));
        return;
      case 'juxt':
      case 'cdot':
      case 'times':
        walk(n.left);
        walk(n.right);
        return;
      case 'add':
        n.terms.forEach(walk);
        return;
      case 'neg':
        walk(n.operand);
        return;
      case 'pow':
        walk(n.base);
        walk(n.exponent);
        return;
      case 'frac':
        walk(n.numerator);
        walk(n.denominator);
        return;
      case 'call':
        n.args.forEach(walk);
        return;
      // `apply` 는 이름도 넣는다 — 정의된 함수든 아니든(둘 다 몰라도 되는 층이다) 이
      // 이름의 셀이 바뀌면 무효화돼야 한다(`collectFreeSymbols` 의 `apply` 케이스와 같은 이유).
      case 'apply':
        names.add(n.name);
        n.args.forEach(walk);
        return;
      case 'deriv':
        walk(n.body);
        // `vars: null` 은 프라임 — 미분 변수가 표기에 안 적혀 있다(f의 매개변수로
        // 나중에 정해진다). 여기선 알 도리가 없으니 그냥 둔다; `body` 를 이미 걸었으므로
        // f가 바뀌면 어차피 무효화된다.
        if (n.vars !== null) n.vars.forEach((v) => names.add(v));
        if (n.args !== null) n.args.forEach(walk);
        return;
      case 'sum':
      case 'prod':
      case 'integral':
        walk(n.body);
        names.add(n.variable);
        if (n.lower !== null) walk(n.lower);
        if (n.upper !== null) walk(n.upper);
        return;
    }
  };
  walk(node);
  return [...names];
}
