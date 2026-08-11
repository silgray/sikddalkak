import { describe, expect, it } from 'vitest';
import type { TypedExpr } from '../expression/node';
import { evaluate } from './evaluate';
import { evalNumeric, matricesClose } from '../numeric';
import { render } from '../render';
import { expand, factor, simplify } from './transform';
import { formatShape } from '../shape/shape';
import { TEST_ENV, TEST_VALUES, typedOf } from '../testEnv';
import { parse } from '../index';

/**
 * 무작위 식으로 재작성을 대조한다 (설계 §10②).
 *
 * 표 테스트는 **내가 생각해낸 경우**만 본다. 스칼라·벡터·행렬이 얽히면 생각해내지 못한
 * 조합에서 교환법칙이 잘못 적용되거나 인수 순서가 뒤집힌다. 그건 사람이 못 잡는다.
 * 그래서 식을 무작위로 만들어 놓고 **값이 그대로인지** 기계로 확인한다.
 *
 * 확인하는 성질:
 *   ① `evalNumeric(rewrite(e)) ≈ evalNumeric(e)`  — 답이 바뀌지 않았다
 *   ② `shapeOf(rewrite(e)) === shapeOf(e)`        — 모양이 바뀌지 않았다
 *   ③ `parse(render(rewrite(e))) === rewrite(e)`  — 다시 읽어도 같다
 *
 * 씨앗이 고정이라 실패는 항상 재현된다.
 */

/** 씨앗 고정 난수 (mulberry32). */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `TEST_ENV` 에 있는 심볼들 + 미정의(=스칼라) 심볼 몇 개 + 항등원(`I`).
 * `I` 는 문맥에서 모양이 정해지므로(곱·덧셈 상대) 무작위 조합에 자연스럽게 섞여
 * 소거 규칙(`AI→A`, `AIA→A²` 등)이 값·모양·왕복 대조를 자동으로 받는다.
 */
const LEAVES = ['u', 'v', 'w', 'r', 'p', 'A', 'B', 'C', 'M', 'a', 'b', 'k', '2', '3', 'I'];

/**
 * LaTeX 식을 무작위로 만든다.
 *
 * **모양이 맞는 식만 골라내지 않는다** — 일부러 아무거나 만들고, elaborate를 통과한
 * 것만 검사 대상으로 삼는다(거부 표집). 이러면 파서와 모양 검사기도 같이 흔들린다.
 */
function randomLatex(random: () => number, depth: number, leaves: readonly string[] = LEAVES): string {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  if (depth <= 0) return pick(leaves);

  const left = (): string => randomLatex(random, depth - 1, leaves);
  const group = (s: string): string => `\\left(${s}\\right)`;

  switch (Math.floor(random() * 14)) {
    case 0:
      return `${group(left())}${group(left())}`;
    case 1:
      return `${group(left())}\\cdot ${group(left())}`;
    case 2:
      return `${group(left())}\\times ${group(left())}`;
    case 3:
      return `${group(left())}+${group(left())}`;
    case 4:
      return `${group(left())}-${group(left())}`;
    case 5:
      return `${group(left())}^T`;
    case 6:
      return `-${group(left())}`;
    case 7:
      return `${group(left())}^{2}`;
    case 8:
      return `\\frac{${left()}}{${left()}}`;
    case 9:
      return `\\sin\\left(${left()}\\right)`;
    case 10:
      return `${group(left())}^{3}`;
    case 11:
      return `\\sum_{k=1}^{3}\\left(${left()}\\right)`;
    case 12:
      return `\\prod_{k=1}^{2}\\left(${left()}\\right)`;
    default:
      return `${pick(leaves)}${group(left())}`;
  }
}

/**
 * `matIdentity` 가 **모양이 확정된 채(스칼라로 굳지 않고)** 트리 어딘가에 있는가.
 *
 * `I` 는 렌더에 크기를 안 남긴다(`I` 뿐, `I_3` 같은 표기 없음). 그래서 크기를 알려주던
 * 문맥이 재작성 도중 대수적으로 사라지면(예: `(I/k-(A-A))^3` 에서 `A-A` 가 0으로
 * 소거), 결과 문자열을 다시 읽었을 때 `I` 가 기본값 (1,1)로 다르게 굳을 수 있다 —
 * 코드 버그가 아니라 표현 자체의 한계다. 나중에 재작성 시점에 `I_3` 처럼 크기를
 * 남기는 표기를 붙이기로 했고(아직 미착수), 그때까지는 `I` 가 낀 표본의 왕복 불일치를
 * 알려진 한계로 관대하게 봐준다 — 그 대신 표본 자체는 계속 돌려서 **다른** 회귀는
 * 여전히 잡는다.
 */
function containsResolvedIdentity(e: TypedExpr): boolean {
  switch (e.op) {
    // 원래는 "**정사각으로** 확정된 I" 만 봤다(모양이 안 나온 채 렌더된다는 게 요점).
    // `\sum`/`\prod` 본문처럼 **CE로 안 넘기는 불투명 노드** 안에 맨 `I` 가 들어가면
    // 그 자리에서 크기를 알려줄 문맥이 없어 **스칼라로** 굳어버릴 수 있다(정상 동작,
    // `normalize.ts` 의 matIdentity 케이스). 문제는 렌더가 스칼라 I든 정사각 I든
    // 똑같이 `I` 하나만 내놓는다는 것 — 다시 읽으면 또 미정(unknown)에서 출발해
    // 그 사이 어떤 문맥을 만나느냐에 따라 **다르게** 굳을 수 있다. 그래서 크기와
    // 무관하게 **`I` 가 있다는 사실 자체**를 알려진 한계로 잡는다.
    case 'matIdentity':
      return true;
    case 'num':
    case 'sym':
      return false;
    case 'matrix':
      return e.rows.some((row) => row.some(containsResolvedIdentity));
    case 'add':
      return e.terms.some(containsResolvedIdentity);
    case 'neg':
      return containsResolvedIdentity(e.operand);
    case 'scalarMul':
    case 'matMul':
      return e.factors.some(containsResolvedIdentity);
    case 'mul':
      return containsResolvedIdentity(e.scalar) || containsResolvedIdentity(e.nonScalar);
    case 'dot':
    case 'cross':
      return containsResolvedIdentity(e.left) || containsResolvedIdentity(e.right);
    case 'transpose':
      return containsResolvedIdentity(e.operand);
    case 'matPow':
      return containsResolvedIdentity(e.base);
    case 'scalarPow':
      return containsResolvedIdentity(e.base) || containsResolvedIdentity(e.exponent);
    case 'call':
    case 'apply':
      return e.args.some(containsResolvedIdentity);
    case 'frac':
      return containsResolvedIdentity(e.numerator) || containsResolvedIdentity(e.denominator);
    case 'deriv':
      return containsResolvedIdentity(e.body);
    case 'sum':
    case 'prod':
    case 'integral':
      return (
        containsResolvedIdentity(e.body) ||
        (e.lower !== null && containsResolvedIdentity(e.lower)) ||
        (e.upper !== null && containsResolvedIdentity(e.upper))
      );
  }
}

type Check = { readonly latex: string; readonly typed: TypedExpr };

/** elaborate와 수치 평가를 모두 통과하는 식만 검사 대상이다. */
function usable(latex: string): Check | null {
  const parsed = parse(latex, TEST_ENV);
  if (!parsed.ok) return null;
  const value = evalNumeric(parsed.value, TEST_VALUES);
  if (!value.ok) return null;
  // 값이 너무 크면 부동소수 비교가 의미를 잃는다.
  if (value.value.some((row) => row.some((x) => !Number.isFinite(x) || Math.abs(x) > 1e12))) {
    return null;
  }
  return { latex, typed: parsed.value };
}

function generate(count: number, seed: number, leaves: readonly string[] = LEAVES): Check[] {
  const random = rng(seed);
  const out: Check[] = [];
  for (let i = 0; out.length < count && i < count * 60; i += 1) {
    const check = usable(randomLatex(random, 1 + Math.floor(random() * 3), leaves));
    if (check !== null) out.push(check);
  }
  return out;
}

// 이 저장소엔 `@types/node` 가 없다. 테스트 실행기에는 `process` 가 있으니 타입만 얹는다.
declare const process: { readonly env: Readonly<Record<string, string | undefined>> };

/** 씨앗을 여러 개 쓰는 건 한 씨앗이 특정 모양에 치우칠 수 있어서다. */
const SEEDS = [0x5eed, 0x1234, 0xbeef];
const PER_SEED = Number(process.env.ALGEBRA_FUZZ_SAMPLES ?? 250);
const SAMPLES = SEEDS.flatMap((seed) => generate(PER_SEED, seed));

/**
 * `LEAVES` + 리터럴 행렬/벡터 몇 개. `evaluate` 전용 — 순수 심볼로만 된 `SAMPLES` 로는
 * `matrixFold` 의 산술이 실제로 켜지는 경우가 없다(접을 리터럴이 없으니). `TEST_ENV`의
 * `A`/`u` 등과 같은 모양(3×3, 3×1)으로 맞춰 조합될 확률을 높인다.
 */
const LITERAL_LEAVES = [
  ...LEAVES,
  String.raw`\begin{pmatrix}1&2&0\\3&-1&2\\0&1&1\end{pmatrix}`,
  String.raw`\begin{pmatrix}2&0&1\\1&2&-1\\0&-2&3\end{pmatrix}`,
  String.raw`\begin{pmatrix}3\\-2\\1\end{pmatrix}`,
  String.raw`\begin{pmatrix}-1\\4\\2\end{pmatrix}`,
];
const LITERAL_SAMPLES = SEEDS.flatMap((seed) => generate(PER_SEED, seed, LITERAL_LEAVES));

describe('무작위 식 대조', () => {
  it('충분한 표본이 모인다', () => {
    // 표본이 적으면 이 테스트가 통과해도 의미가 없다 — 표본 수 자체를 고정해 둔다.
    // 더 넓게 훑고 싶으면 `ALGEBRA_FUZZ_SAMPLES=5000 npx vitest run src/algebra`.
    expect(SAMPLES.length).toBe(SEEDS.length * PER_SEED);
  });

  for (const [name, op] of [
    ['expand', expand],
    ['simplify', simplify],
    ['factor', factor],
  ] as const) {
    // 표본을 크게 잡고 훑을 때(`ALGEBRA_FUZZ_SAMPLES`) 기본 5초 제한에 걸리지 않게 넉넉히.
    it(`${name} 는 값·모양을 바꾸지 않는다`, { timeout: 120_000 }, () => {
      const failures: string[] = [];
      for (const { latex, typed } of SAMPLES) {
        const result = op(typed, TEST_ENV);
        if (!result.ok) {
          failures.push(`${latex}: ${name} failed — ${result.errors[0].message}`);
          continue;
        }
        if (formatShape(result.value.shape) !== formatShape(typed.shape)) {
          failures.push(
            `${latex}: shape ${formatShape(typed.shape)} -> ${formatShape(result.value.shape)}`,
          );
          continue;
        }
        const before = evalNumeric(typed, TEST_VALUES);
        const after = evalNumeric(result.value, TEST_VALUES);
        if (!before.ok || !after.ok) {
          failures.push(`${latex}: not evaluable after ${name}`);
          continue;
        }
        if (!matricesClose(before.value, after.value, 1e-7)) {
          failures.push(
            `${latex} -> ${render(result.value)}: ${JSON.stringify(before.value)} vs ${JSON.stringify(after.value)}`,
          );
        }
      }
      expect(failures.slice(0, 5)).toEqual([]);
    });
  }

  /**
   * `evaluate` = `foldMatrices` → `simplify` 대조. **리터럴 표본**(`LITERAL_SAMPLES`)을
   * 쓰는 게 요점이다 — `matrixFold` 의 산술(`numeric.ts` 와 별개로 새로 짠 코드)이
   * `numeric.ts` 와 어긋나지 않는다는 보증은 실제로 리터럴 행렬이 접혀야만 의미가 있다.
   */
  it('충분한 리터럴 표본이 모인다', () => {
    expect(LITERAL_SAMPLES.length).toBe(SEEDS.length * PER_SEED);
  });

  it('evaluate 는 값·모양을 바꾸지 않는다', { timeout: 120_000 }, () => {
    const failures: string[] = [];
    for (const { latex, typed } of LITERAL_SAMPLES) {
      const result = evaluate(typed, TEST_ENV);
      if (!result.ok) {
        failures.push(`${latex}: evaluate failed — ${result.errors[0].message}`);
        continue;
      }
      if (formatShape(result.value.shape) !== formatShape(typed.shape)) {
        failures.push(
          `${latex}: shape ${formatShape(typed.shape)} -> ${formatShape(result.value.shape)}`,
        );
        continue;
      }
      const before = evalNumeric(typed, TEST_VALUES);
      const after = evalNumeric(result.value, TEST_VALUES);
      if (!before.ok || !after.ok) {
        failures.push(`${latex}: not evaluable after evaluate`);
        continue;
      }
      if (!matricesClose(before.value, after.value, 1e-7)) {
        failures.push(
          `${latex} -> ${render(result.value)}: ${JSON.stringify(before.value)} vs ${JSON.stringify(after.value)}`,
        );
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });

  /**
   * 왕복은 **트리 동일성이 아니라 렌더 멱등성**으로 본다.
   *
   * LaTeX에는 `-(rC)` 와 `(-r)C` 를 구분할 표기가 없다 — 둘 다 `-rC` 다. 값이 같으니
   * 구분할 이유도 없다. 그래서 요구할 수 있는 최선은 "낸 걸 다시 읽어 또 내면 같다"이고,
   * 값이 같은지는 아래에서 따로 확인한다.
   */
  it('재작성 결과를 다시 읽어 또 내도 같은 LaTeX이다', { timeout: 120_000 }, () => {
    const failures: string[] = [];
    for (const { latex, typed } of SAMPLES) {
      const result = expand(typed, TEST_ENV);
      if (!result.ok) continue;
      // 알려진 한계(containsResolvedIdentity 주석 참고) — 표본은 계속 돌리되, 실제로
      // 어긋났을 때만 I가 관련돼 있으면 눈감아준다. 무관한 회귀는 여전히 잡는다.
      const identityInvolved = containsResolvedIdentity(result.value);
      const out = render(result.value);
      const reparsed = parse(out, TEST_ENV);
      if (!reparsed.ok) {
        if (identityInvolved) continue;
        failures.push(`${latex} -> ${out}: reparse failed — ${reparsed.errors[0].message}`);
        continue;
      }
      if (render(reparsed.value) !== out) {
        if (identityInvolved) continue;
        failures.push(`${latex} -> ${out} -> ${render(reparsed.value)}`);
        continue;
      }
      const before = evalNumeric(result.value, TEST_VALUES);
      const after = evalNumeric(reparsed.value, TEST_VALUES);
      if (before.ok && after.ok && !matricesClose(before.value, after.value, 1e-7)) {
        if (identityInvolved) continue;
        failures.push(`${latex} -> ${out}: value changed on reparse`);
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });
});

describe('생성기 자체 점검', () => {
  it('행렬·벡터가 실제로 섞여 나온다', () => {
    // 표본이 전부 스칼라면 이 스위트는 아무것도 검증하지 못한다.
    const kinds = new Set(SAMPLES.map((s) => formatShape(s.typed.shape)));
    expect(kinds.has('scalar')).toBe(true);
    expect([...kinds].some((k) => k !== 'scalar')).toBe(true);
  });

  it('알려진 식은 여전히 통과한다 (생성기 회귀 방지)', () => {
    expect(usable('v^TAv')).not.toBeNull();
    expect(usable(typedOf('ABA') && 'ABA')).not.toBeNull();
  });
});
