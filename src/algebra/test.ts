import { inspect } from 'node:util';
import { analyze, formatShape, sexpSyntax, sexpTyped, sexpTypedWithShapes, shape, transform, type Env } from './index';
import { parseSyntax } from './syntax';
import { elaborate } from './elaborate';
import { normalize } from './normalize';



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
  // "x^{2}x\\cos x+xe^{x}\\cos x",
  // "\\frac{x^2+2x+1}{x+1}",
  // "\\frac{\\sin^2 x + a\\sin x}{b\\sin x}",
  "v\\times (kmkw)",
  "(a+b)",
  // "\\mathrm{concat}(a^2,b,c)d",
  // "\\mathrm{ovl}{abc}",
  // "\\begin{pmatrix}1 & x\\\\ 1 & y\\\\ 1 & z\\end{pmatrix}\\begin{pmatrix}1 & x & x^2\\\\ 1 & y & y^2\\end{pmatrix}"
];


export function test(latexs: string[]) {

  const align = 15;

  console.log("\n\n=================================")
  latexs.forEach((latex) => {
    // // 1. parsing to SyntaxNode tree
    // const preprocessed_latex = preprocess(latex);
    // // 1-a) preprocess: \cdot, \times 토큰 치환
    // console.log("preprocessed:", preprocessed_latex);

    // // 1-b) parse: 큼지막한 파싱은 일단 ce에 위임
    // const parsed_json = ce.parse(preprocessed_latex, {
    //   form: ['Number'],
    // }).json;
    // console.log("parsed:", parsed_json);

    // // 1-c) translate: 파싱 결과를 SyntaxNode 트리로 변환
    // const translated_tree = translate(parsed_json);

    
  });

  
  // return;

}
// console.log(evaluate("\\operatorname{PartialFraction}(\\frac{1}{x^2+3x+2}, x)").latex);

test(latex_strs);