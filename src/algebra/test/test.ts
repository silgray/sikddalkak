import { inspect } from 'node:util';
import { render, shape, type Env, parse } from '../index';
import { preprocess } from '../preprocess';
import { elaborate } from '../elaborate';
import { normalize } from '../normalize';
import { ComputeEngine } from '@cortex-js/compute-engine';
import { translateToTree } from '../translateToTree';

import { evaluate, substituteDeep } from '../evaluate';
import { exit } from 'node:process';


const dump = (value: unknown): string => inspect(value, { depth: null, colors: true });

const expr_v = parse("\\begin{pmatrix} 1\\\\ 2\\\\ 3 \\end{pmatrix}", {shapes: {}});
const expr_w = parse("\\begin{pmatrix} 3\\\\ 2\\\\ 3 \\end{pmatrix}", {shapes: {}});
const expr_A = parse("\\begin{pmatrix}1 & 2 & x\\\\ 3 & y & -1\\\\ 0 & 0 & x\\end{pmatrix}", {shapes: {}});

if(!expr_v.ok || !expr_w.ok || !expr_A.ok) exit();

const env: Env = {
  shapes: {
    A: shape(3, 3),
    B: shape(3, 3),
    C: shape(3, 3),
    x: shape(1, 1),
    y: shape(1, 1),
    z: shape(1, 1),
    u: shape(3, 1),
    v: shape(3, 1),
    w: shape(3, 1),
  },
  bindings: {
    v: expr_v.value,
    w: expr_w.value,
    A: expr_A.value,
  }
};

const latex_strs = [
  // "\\frac{2}{10}aba+\\frac{3}{15}aaa",
  // "\\frac{x^2+2x+1}{x+1}",
  // "\\frac{(v\\cdot w)^2+2(v\\cdot w)}{(v\\cdot w)}",
  // "xxx\\cos(x)x+xe^{x}\\cos x",
  // "(v\\cdot w)^2+2v\\cdot w+1"
  // "\\frac{\\sin^2(x) + a\\sin x}{\\sin x}",
  // "v\\times (ku+kw)",
  // "(aA(w^Tw)ABb)c+abdd(v^Tv)ABA",
  // "(x+2)(2(x+1))",
  // "(A+I)(2(AA+2A+I))",
  // "1+I",
  // "A^{-1}",
  // "Av",
  // "(A+I)(B(A+vv^T)+I)",
  // "(A+II)(AAA)",
  // "AAAA+AA^{-1}A^{3}",
  "v\\cdot (((1+x)x+3x)Aw) + 7"
  // "\\begin{pmatrix}1 & x\\\\ 1 & y\\\\ 1 & z\\end{pmatrix}\\begin{pmatrix}1 & x & x^2\\\\ 1 & y & y^2\\end{pmatrix}"
];

const ce = new ComputeEngine();


export function test(latexs: string[]) {

  console.log("\n\n=================================");
  latexs.forEach((latex) => {
    console.log("raw:", latex);
    // 1. parsing to SyntaxNode tree
    const preprocessed_latex = preprocess(latex);
    // 1-a) preprocess: \cdot, \times 토큰 치환
    console.log("preprocessed:", preprocessed_latex);

    // 1-b) parse: 큼지막한 파싱은 일단 ce에 위임
    const parsed_json = ce.parse(preprocessed_latex, {
      form: ['Number'],
    }).json;
    console.log("parsed:", dump(parsed_json));

    // 1-c) translate: 파싱 결과를 SyntaxNode 트리로 변환
    const translated_tree = translateToTree(parsed_json);
    console.log("translated:", dump(translated_tree));
    if(!translated_tree.ok) return;

    // 1-d) elaborate: 연사 확정, 모양 확정
    const elaborated_expr = elaborate(translated_tree.value, env);
    console.log("elaborated:", dump(elaborated_expr));
    if(!elaborated_expr.ok) return;
    console.log("elaborated:", render(elaborated_expr.value));

    // 2. normalize
    const normalized_expr = normalize(elaborated_expr.value);
    console.log("normalized:", dump(normalized_expr));
    if(!normalized_expr.ok) return;
    console.log("normalized:", render(normalized_expr.value));


    // 3. expression conversion

    // // 3-a) expand
    // const expanded_expr = expand(normalized_expr.value, env);
    // console.log("expanded:", dump(expanded_expr));
    // if(!expanded_expr.ok) return;
    // console.log("expanded:", render(expanded_expr.value));

    // // 3-b) simplify
    // const simplified_expr = simplify(normalized_expr.value, env);
    // // console.log("simplified:", dump(simplified_expr));
    // if(!simplified_expr.ok) return;
    // console.log("simplified:", render(simplified_expr.value));
    
    // // 3-c) factor
    // const factored_expr = factor(normalized_expr.value, env);
    // if(!factored_expr.ok) return;
    // const simplified_factored_expr = simplify(factored_expr.value, env);
    // console.log("factored:", render(factored_expr.value));
    // if(!simplified_factored_expr.ok) return;
    // console.log("simplified_factored:", render(simplified_factored_expr.value));
    
    // 3-d) evaluate
    const substituted_expr = substituteDeep(normalized_expr.value, env);
    console.log("substituted:", dump(substituted_expr));
    if(!substituted_expr.ok) return;
    console.log("substituted:", render(substituted_expr.value));
    const evaluated_expr = evaluate(substituted_expr.value, env);
    console.log("evaluated:", dump(evaluated_expr));
    if(!evaluated_expr.ok) return;
    console.log("evaluated:", render(evaluated_expr.value));

    console.log("\n=================================");
  });

}

test(latex_strs);