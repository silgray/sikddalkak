import { inspect } from 'node:util';
import { shape, type Env } from './index';
import { preprocess } from './preprocess';
import { elaborate } from './elaborate';
import { normalize } from './normalize';
import { ComputeEngine } from '@cortex-js/compute-engine';
import { translateToTree } from './translateToTree';


const dump = (value: unknown): string => inspect(value, { depth: null, colors: true });

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
};

const latex_strs = [
  // "\\frac{2}{10}aba+\\frac{3}{15}aaa",
  // "xxx\\cos(x)x+xe^{x}\\cos x",
  // "\\frac{x^2+2x+1}{x+1}",  // fix: elaborate단계에서 frac을 pow(-1)로 바꿔버림. 수정 필요.
  // "\\frac{\\sin^2 x + a\\sin x}{b\\sin x}",
  // "v\\times (km+kw)",
  "(aA(w^Tw)ABb)c+abdd(v^Tv)ABA",
  // "\\mathrm{concat}(a^2,b,c)d",
  // "\\mathrm{ovl}{abc}",
  // "\\begin{pmatrix}1 & x\\\\ 1 & y\\\\ 1 & z\\end{pmatrix}\\begin{pmatrix}1 & x & x^2\\\\ 1 & y & y^2\\end{pmatrix}"
];

const ce = new ComputeEngine();


export function test(latexs: string[]) {

  const align = 15;

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

    // 1-d) elaborate: 연사 확정, 모양 확정
    if(!translated_tree.ok) return;
    const elaborated_expr = elaborate(translated_tree.value, env);
    console.log("elaborated:", dump(elaborated_expr));

    // 2. normalize
    if(!elaborated_expr.ok) return;
    const normalized_expr = normalize(elaborated_expr.value);
    console.log("normalized:", dump(normalized_expr));


    console.log("\n=================================");
  });

  
  // return;

}
// console.log(evaluate("\\operatorname{PartialFraction}(\\frac{1}{x^2+3x+2}, x)").latex);

test(latex_strs);