import { ComputeEngine } from '@cortex-js/compute-engine';
import type { TypedExpr } from './types-TypedExpr';
import { isOne, isZero, splitSign, type Literal } from './types-Literal';

/**
 * Typed IR → string(LaTeX).
 *
 * **왕복(round-trip)이 이 렌더러의 계약이다**: `render(e)` 를 다시 파싱·elaborate하면
 * 같은 연산 트리가 나와야 한다. 재작성 결과를 다시 읽어들이는 게 이 모듈의 일상이라,
 * 왕복이 깨지면 조용한 오답이 된다. (render.test.ts가 이걸 자동으로 확인한다.)
 *
 * 그래서 **구조 렌더를 CE에 맡기지 않는다.** CE는 `["Power","A",-1]` 을 `\frac{1}{A}` 로
 * 되돌려 역행렬을 행렬 나눗셈으로 바꿔버린다(실측). CE에 맡기는 건 **잎 심볼 이름**뿐 —
 * `Pi`→`\pi`, `A_bold`→`\mathbf{A}` 같은 이름 사전은 CE가 정확히 알고 있다.
 */

const ce = new ComputeEngine();

/** 심볼 이름 → LaTeX. CE에 위임하고 결과를 캐시한다. */
const symbolLatexCache = new Map<string, string>();
function symbolLatex(name: string): string {
  const cached = symbolLatexCache.get(name);
  if (cached !== undefined) return cached;
  let latex = name;
  try {
    const boxed = ce.box(name, { canonical: false }).latex;
    if (typeof boxed === 'string' && boxed.length > 0) latex = boxed;
  } catch {
    // 이름을 그대로 쓴다 — 렌더가 죽는 것보다 낫다.
  }
  symbolLatexCache.set(name, latex);
  return latex;
}

/**
 * 괄호 판단용 결합 세기. **파서의 우선순위(§3)와 같은 순서여야** 왕복이 성립한다.
 * 후위(`^`) > 병치 > `·`/`×` > `+`/`-`
 */
const ADD = 1;
const DOTX = 2;
const MUL = 3;
const POW = 4;
const ATOM = 5;

/**
 * 리터럴 → LaTeX.
 *
 * 부호는 **분수 앞으로** 낸다 (`-\frac{1}{3}`, `\frac{-1}{3}` 아님) — 모듈 전체가
 * "부호는 바깥으로" 관례를 쓰고, CE도 `-\frac{1}{3}` 과 `\frac{-1}{3}` 을 똑같이
 * `Rational(-1,3)` 으로 읽으므로(실측) 둘 중 하나로 모아야 렌더가 멱등이다.
 *
 * `decimal` 은 `text` 를 그대로 낸다 — 사용자가 쓴 글자를 보존한다.
 */
export function renderLiteral(l: Literal): string {
  switch (l.kind) {
    case 'int':
      return String(l.value);
    case 'rational':
      return l.n < 0 ? `-\\frac{${-l.n}}{${l.d}}` : `\\frac{${l.n}}{${l.d}}`;
    case 'decimal':
      return l.text;
    case 'complex': {
      // `1i`/`-1i` 가 아니라 `i`/`-i` 로 낸다 — 계수 1은 쓰지 않는 표기 관례이고,
      // `-1i` 를 다시 읽으면 `Multiply(-1, i)` 라 트리 모양도 달라진다.
      const { negative, magnitude } = splitSign(l.im);
      const digits = isOne(magnitude) ? '' : renderLiteral(magnitude);
      const im = `${negative ? '-' : ''}${digits}i`;
      if (isZero(l.re)) return im;
      return negative ? `${renderLiteral(l.re)}${im}` : `${renderLiteral(l.re)}+${im}`;
    }
  }
}

/**
 * 리터럴의 결합 세기.
 *  - 음수는 앞에 `-` 가 붙으므로 덧셈처럼 약하게 (`A^{-2}` 는 중괄호가 감싼다)
 *  - 실수부·허수부가 둘 다 있는 복소수(`3+4i`)는 그 자체가 덧셈이다
 *  - 순허수 양수(`4i`)는 곱이다
 *  - 나머지(`3`, `\frac{3}{7}`, `i`)는 원자
 */
function literalPrecedence(l: Literal): number {
  const { negative, magnitude } = splitSign(l);
  if (negative) return ADD;
  if (magnitude.kind === 'complex') {
    if (!isZero(magnitude.re)) return ADD;
    return isOne(magnitude.im) ? ATOM : MUL;
  }
  return ATOM;
}

function precedence(e: TypedExpr): number {
  switch (e.op) {
    case 'num':
      return literalPrecedence(e.value);
    case 'sym':
    case 'matrix':
    case 'call':
    case 'matIdentity':
    case 'frac':
      return ATOM;
    case 'transpose':
    case 'matPow':
    case 'scalarPow':
      return POW;
    case 'scalarMul':
    case 'matMul':
    case 'mul':
      return MUL;
    case 'dot':
    case 'cross':
      return DOTX;
    case 'add':
    case 'neg':
      return ADD;
    // 넷 다 결합 범위가 넓다(실측: `\sum_{k=1}^n A+B` 는 합에서 끊기지만
    // `\frac{\mathrm{d}}{\mathrm{d}x}f+g`/`\int f+g\,dx` 는 합을 삼키고, 넷 다 뒤따르는
    // 병치 인수까지 삼킨다). 렌더가 본문을 항상 `\left(\right)` 로 감싸는 것과 짝을 맞춰
    // 가장 약한 결합 세기로 둬야, 곱·합 안에 낀 자리에서 `at()` 이 자동으로 바깥 괄호를
    // 씌워 왕복이 성립한다.
    case 'deriv':
    case 'sum':
    case 'prod':
    case 'integral':
      return ADD;
  }
}

const paren = (latex: string): string => `\\left(${latex}\\right)`;

/** 필요한 세기에 못 미치면 괄호를 씌운다. */
function at(e: TypedExpr, minPrecedence: number): string {
  const latex = render(e);
  return precedence(e) < minPrecedence ? paren(latex) : latex;
}

/** 우리 `call` 이름 → LaTeX. */
const CALL_LATEX: Record<string, string> = {
  sin: '\\sin', cos: '\\cos', tan: '\\tan',
  arcsin: '\\arcsin', arccos: '\\arccos', arctan: '\\arctan',
  sinh: '\\sinh', cosh: '\\cosh', tanh: '\\tanh',
  exp: '\\exp', ln: '\\ln', log: '\\log',
};

/**
 * 병치로 n개의 인수를 잇는다.
 *
 * 뒤따르는 인수마다 `POW` 세기를 요구하는 이유: 병치는 좌결합이라 `A(BC)` 의 괄호가
 * 사라지면 `(AB)C` 로 다시 읽혀 **비가환 순서가 바뀐다**.
 */
function renderProduct(factors: readonly TypedExpr[]): string {
  // 맨 앞에 붙은 음수는 곱 **밖으로** 빼낸다.
  //
  // LaTeX에는 `-(rC)` 와 `(-r)C` 를 구분할 표기가 없다 (둘 다 `-rC` 로 읽힌다). 값은
  // 같으니 문제는 아니지만, 괄호를 씌워 구분하려 들면 `\left(-r\right)C` 같은 게 나오고
  // 렌더가 멱등이 아니게 된다. 두 트리를 같은 LaTeX으로 수렴시키는 쪽이 낫다.
  const [head, ...rest] = factors;
  if (head.op === 'neg') return `-${renderProduct([head.operand, ...rest])}`;
  if (head.op === 'num') {
    const { negative, magnitude } = splitSign(head.value);
    if (negative) return `-${renderProduct([{ ...head, value: magnitude }, ...rest])}`;
  }
  return factors.reduce((acc, factor, i) => {
    if (i === 0) return at(factor, MUL);
    const r = at(factor, POW);
    // `2`·`3` 을 그냥 붙이면 `23` 이 된다. 그렇다고 `\cdot` 를 끼우면 **묶음이 달라진다** —
    // `\cdot` 는 병치보다 느슨해서 `2\cdot 3x` 가 `2·(3x)` 로 읽힌다. 괄호로 떼어놓는 게
    // 유일하게 안전한 방법이다. (매 접합마다 확인해야 한다 — n-항이라 중간에도 숫자끼리
    // 만날 수 있다.)
    //
    // 분수도 같다 — 숫자 뒤에 분수가 그냥 붙으면 **대분수로 읽힌다**. CE 자유 함수
    // (`viaCe` 가 쓰는 `simplify`)는 `2\frac{1}{3}` 을 `Rational(7,3)` 으로 준다(실측:
    // `2·1/3 = 2/3` 이 아니라 `2+1/3 = 7/3`). 값이 달라지는 자리라 반드시 떼어놓는다.
    const collides = /\d$/.test(acc) && (/^\d/.test(r) || r.startsWith('\\frac'));
    return collides ? `${acc}${paren(r)}` : `${acc}${r}`;
  }, '');
}

export function render(e: TypedExpr): string {
  switch (e.op) {
    case 'num':
      return renderLiteral(e.value);

    case 'sym':
      return symbolLatex(e.name);

    case 'matIdentity':
      return 'I';

    case 'matrix':
      return `\\begin{pmatrix}${e.rows
        .map((row) => row.map((cell) => render(cell)).join('&'))
        .join('\\\\')}\\end{pmatrix}`;

    case 'add': {
      // 음수 항은 `+ (-x)` 가 아니라 `- x` 로 낸다. 항 자체가 `-` 로 시작하는 경우
      // (곱 밖으로 빠져나온 부호)도 같이 받아야 `A+-BC` 같은 게 안 나온다.
      const renderTerm = (term: TypedExpr): string => {
        if (term.op === 'neg') return `-${at(term.operand, DOTX)}`;
        // 음수 리터럴도 `\left(-3\right)` 가 아니라 `-3` 으로 낸다. 이걸 빼먹으면
        // `-3-rv` 를 다시 읽었을 때 `\left(-3\right)-rv` 가 되어 렌더가 멱등이 아니다
        // (CE가 `-3` 을 음수 리터럴 하나로 접어주기 때문).
        if (term.op === 'num' && splitSign(term.value).negative) return renderLiteral(term.value);
        return at(term, DOTX);
      };
      return e.terms
        .map((term, i) => {
          const rendered = renderTerm(term);
          if (i === 0) return rendered;
          return rendered.startsWith('-') ? rendered : `+${rendered}`;
        })
        .join('');
    }

    case 'neg': {
      // 피연산자가 이미 `-` 로 시작하면 괄호로 감싼다. 그냥 붙이면 `--1x` 가 되어
      // 다시 읽을 때 부호 두 개가 하나로 접혀버린다.
      const inner = at(e.operand, DOTX);
      return inner.startsWith('-') ? `-${paren(inner)}` : `-${inner}`;
    }

    case 'scalarMul':
    case 'matMul':
      return renderProduct(e.factors);

    case 'mul':
      return renderProduct([e.scalar, e.matrix]);

    // 내적/외적은 양쪽 피연산자에 병치 세기를 요구한다.
    // 내적이 내적의 피연산자가 되는 일은 애초에 없다 — 내적 결과는 스칼라라서 그 다음 곱은
    // 스칼라곱으로 해석된다 (`u·v·w` = `scalarMul(factors:[dot(u,v), w])`).
    // 외적은 결합법칙이 없어 파서가 `u×v×w` 를 아예 거부하므로 괄호가 반드시 필요하다.
    // 곱과 같은 이유로 앞선 음수는 밖으로 뺀다. 내적·외적은 각 자리에 선형이라
    // `(-x)·y = -(x·y)` 이고, LaTeX에는 둘을 구분할 표기가 없다.
    case 'dot':
      return e.left.op === 'neg'
        ? `-${render({ ...e, left: e.left.operand })}`
        : `${at(e.left, MUL)}\\cdot ${at(e.right, MUL)}`;

    case 'cross':
      return e.left.op === 'neg'
        ? `-${render({ ...e, left: e.left.operand })}`
        : `${at(e.left, MUL)}\\times ${at(e.right, MUL)}`;

    case 'transpose':
      return `${at(e.operand, ATOM)}^T`;

    case 'matPow':
      return `${at(e.base, ATOM)}^{${render(e.exponent)}}`;

    case 'scalarPow':
      return `${at(e.base, ATOM)}^{${render(e.exponent)}}`;

    case 'call': {
      const arg = e.args.map((a) => render(a)).join(',');
      if (e.name === 'sqrt') return `\\sqrt{${arg}}`;
      if (e.name === 'abs') return `\\left|${arg}\\right|`;
      const command = CALL_LATEX[e.name] ?? `\\operatorname{${e.name}}`;
      return `${command}${paren(arg)}`;
    }

    case 'frac':
      return `\\frac{${render(e.numerator)}}{${render(e.denominator)}}`;

    // 본문을 항상 `\left(\right)` 로 감싼다 — 안 그러면 CE가 다시 읽을 때 뒤따르는
    // 병치·덧셈 항을 본문 안으로 삼켜버린다(실측, 파일 서두 precedence 주석 참고).
    case 'deriv': {
      const [v] = e.vars;
      const op =
        e.vars.length === 1
          ? e.order === 1
            ? `\\frac{\\mathrm{d}}{\\mathrm{d}${symbolLatex(v)}}`
            : `\\frac{\\mathrm{d}^{${e.order}}}{\\mathrm{d}${symbolLatex(v)}^{${e.order}}}`
          : `\\frac{\\mathrm{d}}{\\mathrm{d}(${e.vars.map(symbolLatex).join(',')})}`;
      return `${op}${paren(render(e.body))}`;
    }

    case 'sum':
    case 'prod': {
      const cmd = e.op === 'sum' ? '\\sum' : '\\prod';
      const sub = e.lower !== null ? `${symbolLatex(e.variable)}=${render(e.lower)}` : symbolLatex(e.variable);
      const sup = e.upper !== null ? `^{${render(e.upper)}}` : '';
      return `${cmd}_{${sub}}${sup}${paren(render(e.body))}`;
    }

    case 'integral': {
      const lo = e.lower !== null ? `_{${render(e.lower)}}` : '';
      const hi = e.upper !== null ? `^{${render(e.upper)}}` : '';
      return `\\int${lo}${hi}${paren(render(e.body))}\\mathrm{d}${symbolLatex(e.variable)}`;
    }
  }
}
