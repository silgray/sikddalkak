import { render, shape, type Env, parse, expand, simplify, factor, type TypedExpr } from '../index';
import { elaborate } from '../parse/elaborate';
import { normalize } from '../normalize/normalize';
import { ComputeEngine } from '@cortex-js/compute-engine';
import { translateToTree } from '../parse/translate';

import { evaluate, substituteDeep } from '../transform/evaluate';
import { group, show } from './view';
import { prettify } from '../transform/prettify';

import { sort_keys } from './sort_add';

// const dump = (value: unknown): string => JSON.stringify(value, null, 2);

// `w=Av` 처럼 다른 이름을 참조하는 바인딩은 **그 이름들의 모양이 이미 있는 shapes로**
// 파싱해야 한다 — 빈 shapes로 파싱하면 A/v가 스칼라로 기본 가정돼 버려서(elaborate.ts의
// "정의되지 않은 자유 심볼은 스칼라로 가정한다") w의 바인딩이 실제로는 `scalarMul(A,v)`
// (모양 스칼라)로 굳고, 아래 env.shapes.w=(3,1) 선언과 어긋난다. 이 어긋남이
// substituteDeep에서 "3x1 by 3x1" shape-mismatch로 터진다(w가 dot 안에서 치환되며
// dotTyped가 잘못된 스칼라 모양을 보고 juxt 경로로 새서 mul→matMul 재해석 때 충돌).
const shapes = {
  // A: shape(3, 3),
  // B: shape(3, 3),
  // C: shape(3, 2),
  // x: shape(1, 1),
  // y: shape(1, 1),
  // z: shape(1, 1),
  // u: shape(3, 1),
  // v: shape(3, 1),
  // w: shape(3, 1),
};

const expr_v = parse("\\begin{pmatrix} 1\\\\ 2\\\\ 3 \\end{pmatrix}", {shapes});
const expr_w = parse("Av", {shapes});
// const expr_w = parse("\\begin{pmatrix} 3\\\\ 2\\\\ 3 \\end{pmatrix}", {shapes});
const expr_A = parse("\\begin{pmatrix}1 & x & 0\\\\ 3 & y & -1\\\\ 0 & 0 & 1\\end{pmatrix}", {shapes});
const expr_B = parse("\\begin{pmatrix}y & z & 0\\\\ -1 & x & 1\\\\ 1 & 0 & 0\\end{pmatrix}", {shapes});

if(!expr_v.ok || !expr_w.ok || !expr_A.ok || !expr_B.ok) throw new Error('setup expr parse failed');

const env: Env = {
  shapes,
  bindings: {
    // A: expr_A.value,
    // B: expr_B.value,
    // v: expr_v.value,
    // w: expr_w.value,
  }
};

interface TestValues {
  normalized?: string,
  simplified?: string,
  evaluated?: string,
}

const latex_strs: Record<string, TestValues | null> = {
  // "\\frac{2}{10}aba+\\frac{3}{15}aab": null,
  // "\\left(x+2\\right)\\left(x+1\\right)^2\\left(x+1\\right)^2\\left(x+2\\right)^2": null,
  // "c+b+(b+a)^2": null,
  // "\\frac{x^2+2x+1}{x+1}": null,
  // "\\frac{(v\\cdot w)^2+2(v\\cdot w)}{(v\\cdot w)}": null,
  // "xAxx\\cos(x)x+xe^{x}A\\cos x": null,
  // "(v\\cdot w)": null,
  // "\\frac{\\sin^2(x) + a\\sin x}{\\sin x}": null,
  // "v\\times (ku+kw)": null,
  // "(aA(w^Tw)ABb)c+abdd(v^Tv)ABA": null,
  // "(x+2)(2(x+1))": null,
  // "xxx^{-1}yy+xxyyy": null,
  // "A+A/2": null,
  // "(A+A^0)(2(AA+2A+I))": null,
  // "v\\cdot w - w\\cdot v": null,
  // "v\\times (w\\times Iw)": null,
  // "ae^{x}\\cos x+ae^{x}\\cos x": {normalized: "2\\cos\\left(x\\right)\\mathrm{e}^{x}a"},
  // "\\sin(\\pi)": null,
  // "\\sin^{-1}(1)": null,
  // "\\arcsin(1)": null,
  // "(2x+ix+3)^2": null,
  // "1+3I": {'normalized': "3I+1"},
  // "A^{0.5+2.5}": null,
  // "A^{0}": null,
  // "A^{-1}": null,
  // "x^{0}": null,
  // "1+2": null,
  // "19/1": null,
  // "1*2": null,
  // "-(-1)": {normalized: "1", simplified: "1"},
  // "\\frac{13}{1}": null,
  // "Av": null,
  // "\\sin(e^x)3\\sin(e^x)": {normalized: "3\\sin\\left(\\mathrm{e}^{x}\\right)^2"},
  // "(A+I)3x(A+I)": null,
  // "x^{a}yx^{2a}": {normalized: "x^{2a}x^{a}y", simplified: "x^{2a}x^{a}y"},
  // "x^{a}yx^{-a}": {normalized: "x^{-a}x^{a}y", simplified: "x^{-a}x^{a}y"},
  // "(1/x)x": null,
  // "e^{\\ln x}": null,
  // "x(y+z)+(z+y)x": null,
  // "(A+I)(B(A+vv^T)+I)": null,
  // "x^4+4x^3+6x^2+4x+1": null,
  // "a_{a}+a_{max}": null,
  // "(A+II)(A1A(v\\cdot w)3x1A)": null,
  // "e^{\\frac{3}{2}i\\pi}": {evaluated: "-i"},
  // "e^{2i\\pi}": {evaluated: "1"},
  // "AAAA+AA^{-1}A^{3}": null,
  // "xxxx+xx^{-1}x^{3}": null,
  // "v\\cdot (((1+x)x+3x)Aw) + 7": null,
  // "\\begin{pmatrix}1 & x\\\\ 1 & y\\\\ 1 & z\\end{pmatrix}\\begin{pmatrix}1 & x & x^2\\\\ 1 & y & y^2\\end{pmatrix}": null,
  // "\\dfrac{\\mathrm{d}}{\\mathrm{d}x}x^2+x": null,
  // "\\frac{\\mathrm{d}}{\\mathrm{d}x}x": null,
  // "\\frac{\\mathrm{d}}{\\mathrm{d}x}x^2+x": null,
  // "\\frac{\\mathrm{d}}{dx}x^2+x": null,
  // "\\frac{\\mathrm{d}}{dx}ex": null,
  // "ex": null,
  // "\\frac{\\differentialD}{\\mathrm{d}x}x^2+x": null,
  // "\\frac{d}{dx}x^2+x": null,
  // "\\frac{\\mathrm{d}}{\\mathrm{d}\\left(x,y\\right)}x": null,
  // "\\frac{\\mathrm{d}x}{\\mathrm{d}\\left(x,y\\right)}": null,
  // "\\frac{d}{d\\left(x,y\\right)}x": null,
  // "\\frac{\\mathrm{d}}{\\mathrm{d}(x,y)}x": null,
  // "1-2x^2+x+x^3+x^6+x": null,
  // "1+y+xy+2x^2+x+x^3+x^6+e^{x^2}": null,
  // "-3 + x^5 + x^3y + xy^3z^3 + x^3z^3u + y^3z^5u + \\sin(x) + \\frac{1}{x} + \\sum_{k=1}^{4}k^2 + \\left(\\sum_{k=1}^{4}a^kx\\right)^{\\left(\\sum_{k=1}^{4}a^kx\\right)} + a^{\\sum_{k=1}^{4}a^kx} + \\left(\\sum_{k=1}^{4}a^kx\\right)^a + 2x^3y": null,
  // "x^3+y^3+3xy^2+3x^2y": null,
  // "ba+ab^4": null,
  // "\\Re": null,
  // "\\Re(1+2i)": null,
  // "\\overline{1+2i}": null,
  // "\\mathrm{tr}A": null,
  // "\\mathrm{tr}(A)": null,
  "\\mu_0": null,
  "\\mu_1": null,
  "a_{xyzdf}": null,
};

const ce = new ComputeEngine();


function test(latexs: Record<string, TestValues | null>) {

  for(const [latex, /* value */] of Object.entries(latexs)) {
    group("", () => {
      show("raw:", latex);

      // 1. parsing to SyntaxNode tree
      const preprocessed_latex = latex;
      // const preprocessed_latex = preprocess(latex);
      // 1-a) preprocess: \cdot, \times 토큰 치환
      console.log("preprocessed:", preprocessed_latex);

      // 1-b) parse: 큼지막한 파싱은 일단 ce에 위임
      const parsed_expr = ce.parse(preprocessed_latex, {
        form: ['Number'],
      });
      show("parsed:", parsed_expr.latex, (parsed_expr.json));

      // 1-c) translate: 파싱 결과를 SyntaxNode 트리로 변환
      const translated_tree = translateToTree(parsed_expr.json);
      // console.log("translated:", dump(translated_tree));
      if(!translated_tree.ok) {
        console.log("translated error:", translated_tree.errors);
        return;
      }

      // 1-d) elaborate: 연사 확정, 모양 확정
      const elaborated_expr = elaborate(translated_tree.value, env);
      // console.log("elaborated:", dump(elaborated_expr));
      if(!elaborated_expr.ok) {
        console.log("elaborated error:", elaborated_expr.errors);
        return;
      }
      show("elaborated:", render(elaborated_expr.value), elaborated_expr.value);

      // 2. normalize
      sort_keys.forEach(({termKey, mulKey}) => {

        const normalized_expr = normalize(elaborated_expr.value, true);
        if(!normalized_expr.ok) {
          console.log("normalized error:", normalized_expr.errors);
          return;
        }
        const prettified_expr = prettify(normalized_expr.value, {
          compareTerms: termKey,
          compareFactors: mulKey,
        });
        show("normalized:", render(prettified_expr), prettified_expr);

      });

      // ===========================================
{
      // // 3. expression conversion

      // // 3-a) simplify
      // const simplified_expr = simplify(normalized_expr.value, env);
      // // console.log("simplified:", dump(simplified_expr));
      // if(!simplified_expr.ok) {
      //   console.log("simplified error:", simplified_expr.errors);
      //   return;
      // }
      // show("simplified:", render(simplified_expr.value), simplified_expr.value);

      // // 3-b) expand
      // const expanded_expr = expand(normalized_expr.value, env);
      // // console.log("expanded:", dump(expanded_expr));
      // if(!expanded_expr.ok) {
      //   console.log("expanded error:", expanded_expr.errors);
      //   return;
      // }
      // show("expanded:", render(expanded_expr.value), expanded_expr.value);
      // const simplified_expanded_expr = simplify(expanded_expr.value, env);
      // if(!simplified_expanded_expr.ok) {
      //   console.log("simplified error:", simplified_expanded_expr.errors);
      //   return;
      // }
      // show("simpl(expand):", render(simplified_expanded_expr.value), simplified_expanded_expr.value);
      
      // // 3-c) factor
      // const factored_expr = factor(normalized_expr.value, env);
      // if(!factored_expr.ok) {
      //   console.log("factored error:", factored_expr.errors);
      //   return;
      // }
      // const simplified_factored_expr = simplify(factored_expr.value, env);
      // show("factored:", render(factored_expr.value), factored_expr.value);
      // if(!simplified_factored_expr.ok) {
      //   console.log("simplified error:", simplified_factored_expr.errors);
      //   return;
      // }
      // show("simpl(factor):", render(simplified_factored_expr.value), simplified_factored_expr.value);
      
      // // 3-d) evaluate
      // const substituted_expr = substituteDeep(normalized_expr.value, env);
      // // console.log("substituted:", dump(substituted_expr));
      // if(!substituted_expr.ok) {
      //   console.log("substituted error:", substituted_expr.errors);
      //   return;
      // }
      // show("substituted:", render(substituted_expr.value), substituted_expr.value);
      // const evaluated_expr = evaluate(substituted_expr.value, env);
      // // console.log("evaluated:", dump(evaluated_expr));
      // if(!evaluated_expr.ok) {
      //   console.log("evaluated error:", evaluated_expr.errors);
      //   return;
      // }
      // show("evaluated:", render(evaluated_expr.value), evaluated_expr.value);
}
      
    });
  }

}

test(latex_strs);