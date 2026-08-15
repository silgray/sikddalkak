
// 마커 전처리

export const DOT_MARKER = 'algDotMarker';
export const CROSS_MARKER = 'algCrossMarker';

/**
 * `\cdot`/`\times` 는 CE 파싱에서 전부 `Multiply` 로 뭉개져 어느 쪽이었는지 사라진다.
 * 파싱 전에 마커 심볼로 바꿔 살려둔다. (`\cdots` 같은 다른 커맨드를 건드리지 않게
 * 토큰 경계를 확인한다.)
 */
/**
 * `\left(\dfrac{\mathrm{d}}{\mathrm{d}x}\right)^{3}` → `\dfrac{\mathrm{d}^{3}}{\mathrm{d}x^{3}}`.
 *
 * "미분 연산자 자체의 거듭제곱"(N번 미분)을 CE는 못 읽는다(실측: `isValid=false`,
 * `\left(\right)`/맨괄호·`\frac`/`\dfrac` 어느 조합이든 똑같이 막힌다). 반면
 * `\dfrac{\mathrm{d}^N}{\mathrm{d}x^N}` 형태는 CE가 중첩 `D` 로 그대로 읽어준다(실측) —
 * 그래서 파싱 전에 앞의 표기를 뒤의 표기로 고쳐 쓴다. ("미분한 결과를 거듭제곱"하는
 * `\left(\dfrac{\mathrm{d}}{\mathrm{d}x}f\right)^3` 은 본문이 괄호 **안**에 있어 이 패턴에
 * 안 걸린다 — CE가 이미 잘 읽는다.)
 */
const DIFF_POWER_RE =
  /(?:\\left)?\(\s*\\d?frac\{(?:d|\\mathrm\{d\})\}\{(?:d|\\mathrm\{d\})([a-zA-Z])\}\s*(?:\\right)?\)\^\{?(\d+)\}?/g;
const DIFFD_SYMBOL = 
  /(\\differentialD)/g;

const REAL_RE = 
  /(\\operatorname\{\\mathrm\{Re\}\})/g;
const IMAG_RE = 
  /(\\operatorname\{\\mathrm\{Im\}\})/g;

/**
 * 그리스 문자 커맨드 → **심볼 이름**. 기본은 커맨드 이름 그대로(`\mu` → `mu`)고,
 * 그걸로 렌더가 왕복하지 않는 일곱 개만 CE의 다른 이름을 쓴다.
 *
 * 고른 기준은 하나다: `symbolToLatex(<이름>_1)` 이 `\<커맨드>_1` 로 되돌아올 것.
 * (`ce/symbolName.ts` 가 이름 렌더를 CE 사전에 맡기므로, CE가 아는 이름이어야 한다.
 * 실측: `varepsilon_1` → `\mathrm{varepsilon_1}` 이지만 `epsilonSymbol_1` → `\varepsilon_1`.)
 * `greek.test.ts` 가 이 표 전체의 왕복을 자동으로 확인한다 — 항목을 추가하면 거기서 걸린다.
 *
 * ⚠ `\gamma` 는 CE가 `EulerGamma`(상수)로 읽지만 우리는 커맨드 이름 `gamma` 를 쓴다 —
 * 첨자 붙은 `\gamma_1` 은 오일러 상수가 아니라 그냥 변수라서다.
 */
const GREEK_SYMBOL_NAME: Readonly<Record<string, string>> = {
  varepsilon: 'epsilonSymbol',
  vartheta: 'thetaSymbol',
  varpi: 'piSymbol',
  varrho: 'rhoSymbol',
  varsigma: 'finalSigma',
  varphi: 'phiLetter',
  Pi: 'CapitalPi',
};

/** 첨자를 붙일 수 있는 그리스 문자 커맨드 전부. `greek.test.ts` 가 전부 훑는다. */
export const GREEK_COMMANDS: readonly string[] = [
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta',
  'theta', 'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'varpi',
  'rho', 'varrho', 'sigma', 'varsigma', 'tau', 'upsilon', 'phi', 'varphi',
  'chi', 'psi', 'omega',
  'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega',
];

/** 그리스 문자 이름(심볼 이름 기준). `translate.ts` 가 오류 메시지에서 쓴다. */
export const greekSymbolName = (command: string): string =>
  GREEK_SYMBOL_NAME[command] ?? command;

/**
 * `\mu_1` / `\mu_{xyi}` → `\mathrm{mu_1}` / `\mathrm{mu_xyi}`.
 *
 * **CE는 그리스 문자 + 첨자를 심볼 하나로 안 읽는다.** 라틴 문자는 통째로 이름을 주는데
 * (`a_{xyi}` → `"a_xyi"`, 실측) 그리스 문자만 `["Subscript","mu",…]` 로 쪼개고, 첨자
 * 안의 글자들도 곱으로 읽어버린다(`\mu_{xyi}` → `Subscript(mu, x·y·i)`, `i` 는 아예
 * 허수로). 유니코드 `μ`·`\operatorname{mu}` 로 줘도 똑같이 쪼개져서(실측) **파싱
 * 옵션으로는 못 막는다.**
 *
 * 그래서 파싱 전에 이름을 통째로 `\mathrm{...}` 에 넣는다 — `\cdot` 마커와 같은 수법이고,
 * CE는 `\mathrm{}` 안을 심볼 이름 하나로 읽는다(실측). 그 결과 이름이 `mu_xyi` 가 되어
 * 라틴 `a_xyi` 와 **완전히 같은 모양**이 된다: 곱셈·거듭제곱·분수 어디에 놓여도 잎
 * 심볼이고, 렌더는 `ce/symbolName.ts` 가 `\mu_{xyi}` 로 되돌린다(실측).
 *
 * 첨자로는 **글자·숫자만** 받는다. `\mu_{a+b}` 처럼 식이 오면 손대지 않고 넘겨,
 * `translate.ts` 의 `Subscript` 갈래가 이름이 될 수 없다고 알려주게 둔다.
 */
const GREEK_SUBSCRIPT_RE = new RegExp(
  String.raw`\\(${GREEK_COMMANDS.join('|')})(?![a-zA-Z])_(?:\{([A-Za-z0-9]+)\}|([A-Za-z0-9]))`,
  'g',
);

export function preprocess(latex: string): string {
  return latex
    .replace(GREEK_SUBSCRIPT_RE, (_m, cmd: string, braced?: string, bare?: string) =>
      `\\mathrm{${greekSymbolName(cmd)}_${braced ?? bare}}`,
    )
    .replace(REAL_RE, () => '\\Re')
    .replace(IMAG_RE, () => '\\Im')
    .replace(DIFFD_SYMBOL, () => '\\mathrm{d}')  // 실측 기반. \differentialD가 포함되어 있으면 뒤의 모든 파싱이 꼬임
    .replace(DIFF_POWER_RE, (_, v: string, n: string) => `\\frac{\\mathrm{d}^{${n}}}{\\mathrm{d}${v}^{${n}}}`)
    .replace(/\\cdot(?![a-zA-Z])/g, ` \\mathrm{${DOT_MARKER}} `)
    .replace(/\\times(?![a-zA-Z])/g, ` \\mathrm{${CROSS_MARKER}} `);
}


export const isMarker = (json: unknown): json is string =>
  json === DOT_MARKER || json === CROSS_MARKER;