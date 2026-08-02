import { describe, expect, it } from 'vitest';
import type { TypedExpr } from './elaborate';
import { evalNumeric, matricesClose } from './numeric';
import { render } from './render';
import { expand, factor, simplify } from './rewrite';
import { formatShape } from './shape';
import { TEST_ENV, TEST_VALUES, typedOf } from './testEnv';
import { parse } from './index';

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

/** `TEST_ENV` 에 있는 심볼들 + 미정의(=스칼라) 심볼 몇 개. */
const LEAVES = ['u', 'v', 'w', 'r', 'p', 'A', 'B', 'C', 'M', 'a', 'b', 'k', '2', '3'];

/**
 * LaTeX 식을 무작위로 만든다.
 *
 * **모양이 맞는 식만 골라내지 않는다** — 일부러 아무거나 만들고, elaborate를 통과한
 * 것만 검사 대상으로 삼는다(거부 표집). 이러면 파서와 모양 검사기도 같이 흔들린다.
 */
function randomLatex(random: () => number, depth: number): string {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  if (depth <= 0) return pick(LEAVES);

  const left = (): string => randomLatex(random, depth - 1);
  const group = (s: string): string => `\\left(${s}\\right)`;

  switch (Math.floor(random() * 12)) {
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
    default:
      return `${pick(LEAVES)}${group(left())}`;
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

function generate(count: number, seed: number): Check[] {
  const random = rng(seed);
  const out: Check[] = [];
  for (let i = 0; out.length < count && i < count * 60; i += 1) {
    const check = usable(randomLatex(random, 1 + Math.floor(random() * 3)));
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
      const out = render(result.value);
      const reparsed = parse(out, TEST_ENV);
      if (!reparsed.ok) {
        failures.push(`${latex} -> ${out}: reparse failed — ${reparsed.errors[0].message}`);
        continue;
      }
      if (render(reparsed.value) !== out) {
        failures.push(`${latex} -> ${out} -> ${render(reparsed.value)}`);
        continue;
      }
      const before = evalNumeric(result.value, TEST_VALUES);
      const after = evalNumeric(reparsed.value, TEST_VALUES);
      if (before.ok && after.ok && !matricesClose(before.value, after.value, 1e-7)) {
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
