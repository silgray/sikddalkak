/**
 * 스칼라 리터럴 — `num` 노드가 담는 값.
 *
 * 정수 하나(`number`)만 담던 자리를 넓힌 것이다. 유리수·소수·복소수가 전부 여기 들어온다.
 * 심볼 상수(π, e)는 리터럴이 **아니다** — 그건 `sym` 으로 남는다.
 *
 * ⚠ **정규형 불변식은 CE가 만들어 준다.** 리터럴은 오직 `literalMath.fromCeJson` 을
 * 통해서만 생기고, CE가 파싱과 evaluate 양쪽에서 기약분수화(gcd)·부호를 분자로 올리기·
 * 분모가 1이면 정수로 무너뜨리기·허수부가 0이면 실수로 무너뜨리기를 이미 해준다(실측).
 * 우리는 그 결과를 담기만 한다. **여기서 손으로 리터럴을 지어내지 말 것** —
 * `intLit` 처럼 불변식이 자명한 것만 예외다.
 *
 * `decimal` 이 `rational` 로 안 바뀌는 이유: `0.2` 를 `1/5` 로 만들면 렌더가
 * `\frac{1}{5}` 를 내놓아 **사용자가 쓴 글자가 바뀐다**. CE도 `form:['Number']` 에서
 * 안 바꾼다(실측) — 우리가 바꾸면 정규형이 두 벌 생긴다. `text` 를 들고 다니는 것도
 * 같은 이유다(`0.50` 과 `0.5` 를 구분해 원문을 보존한다).
 */

export type Literal =
  | { readonly kind: 'int'; readonly value: number }
  /** `d >= 2`, `gcd(|n|,d) === 1`, 부호는 항상 `n` 쪽. */
  | { readonly kind: 'rational'; readonly n: number; readonly d: number }
  /** `value` 는 수치 대조 전용. 산술은 `text` 를 CE에 넘겨서 한다. */
  | { readonly kind: 'decimal'; readonly value: number; readonly text: string }
  | { readonly kind: 'complex'; readonly re: RealLiteral; readonly im: RealLiteral };

export type RealLiteral = Exclude<Literal, { kind: 'complex' }>;

/** 반환 타입을 `int` 로 좁혀둔다 — 복소수의 `re`/`im` 자리(`RealLiteral`)에 쓰려면 필요하다. */
export const intLit = (value: number): Extract<Literal, { kind: 'int' }> => ({
  kind: 'int',
  value,
});

export const ZERO: Literal = intLit(0);
export const ONE: Literal = intLit(1);

/**
 * 구조 식별 키. `exprKey` 가 이걸 그대로 쓰므로 **단사여야 한다** — 서로 다른 두 리터럴이
 * 같은 키를 내면 동류항 판정이 무너진다.
 */
export function literalKey(l: Literal): string {
  switch (l.kind) {
    case 'int':
      return String(l.value);
    case 'rational':
      return `${l.n}/${l.d}`;
    // `d` 접두사가 필요하다 — 이게 없으면 decimal `3` 과 int `3` 이 같은 키가 된다.
    case 'decimal':
      return `d${l.text}`;
    case 'complex':
      return `c(${literalKey(l.re)},${literalKey(l.im)})`;
  }
}

export function isZero(l: Literal): boolean {
  switch (l.kind) {
    case 'int':
      return l.value === 0;
    case 'rational':
      return l.n === 0; // 정규형에서는 안 나오지만(0은 int로 무너진다) 방어적으로.
    case 'decimal':
      return l.value === 0;
    case 'complex':
      return isZero(l.re) && isZero(l.im);
  }
}

export function isOne(l: Literal): boolean {
  switch (l.kind) {
    case 'int':
      return l.value === 1;
    case 'rational':
      return false; // 정규형에서 분모가 1이면 int 다.
    case 'decimal':
      return l.value === 1;
    case 'complex':
      return isOne(l.re) && isZero(l.im);
  }
}

export const isReal = (l: Literal): l is RealLiteral => l.kind !== 'complex';

/** 정수로 볼 수 있으면 그 값, 아니면 `null`. `matPow` 지수 판정이 쓴다. */
export function asInteger(l: Literal): number | null {
  if (l.kind === 'int') return l.value;
  if (l.kind === 'decimal' && Number.isInteger(l.value)) return l.value;
  return null;
}

/**
 * 부호를 밖으로 뺄 것인가.
 *
 * `buildProduct`/`monomialToExpr`/`renderProduct` 가 공유하는 **"부호는 바깥 `neg` 로"**
 * 관례의 단일 진실이다 (`normalize.ts` 의 `buildProduct` 주석 참고).
 *
 * 순허수 음수(`-4i`)까지는 빼내지만, 실수부·허수부가 둘 다 있는 복소수(`-3+4i`)는
 * 쪼개지 않는다 — 빼내봐야 `-(3-4i)` 라 오히려 지저분해진다.
 */
export function splitSign(l: Literal): { negative: boolean; magnitude: Literal } {
  switch (l.kind) {
    case 'int':
      return l.value < 0
        ? { negative: true, magnitude: intLit(-l.value) }
        : { negative: false, magnitude: l };
    case 'rational':
      return l.n < 0
        ? { negative: true, magnitude: { kind: 'rational', n: -l.n, d: l.d } }
        : { negative: false, magnitude: l };
    case 'decimal':
      return l.value < 0
        ? {
            negative: true,
            magnitude: { kind: 'decimal', value: -l.value, text: l.text.replace(/^-/, '') },
          }
        : { negative: false, magnitude: l };
    case 'complex': {
      if (!isZero(l.re)) return { negative: false, magnitude: l };
      const im = splitSign(l.im);
      return im.negative
        ? { negative: true, magnitude: { kind: 'complex', re: l.re, im: im.magnitude as RealLiteral } }
        : { negative: false, magnitude: l };
    }
  }
}

/**
 * 수치 대조용 실수 값. **복소수는 `null`** — `numeric.ts` 의 `Matrix` 가
 * `number[][]` 라 허수부를 담을 자리가 없다. 호출자는 `unsupported` 로 실패해야 한다
 * (퍼즈는 그 표본을 그냥 버린다).
 */
export function toRealNumber(l: Literal): number | null {
  switch (l.kind) {
    case 'int':
      return l.value;
    case 'rational':
      return l.n / l.d;
    case 'decimal':
      return l.value;
    case 'complex':
      return isZero(l.im) ? toRealNumber(l.re) : null;
  }
}
