import { describe, expect, it } from 'vitest';
import { compareExpr, exprKey, sortScalars } from './key';
import type { TypedExpr } from './node';
import { TEST_ENV, typedOf } from '../testEnv';
import { rng, randomLatex, LEAVES } from '../transform/transform.fuzz.test';

/**
 * `compareExpr` 안전망.
 *
 * `sortScalars`/`normalize.ts` 의 `sortTerms` 가 `exprKey` 문자열 비교를 이걸로 갈아
 * 끼운다(성능 최적화, `key.ts` 의 `compareExpr` 문서 참고). 표 테스트가 아니라 **불변식**을
 * 대조하는 게 안전망이다 — 최적화가 값을 바꾸면 여기서 잡힌다.
 */

function usableExpr(latex: string): TypedExpr | null {
  try {
    return typedOf(latex, TEST_ENV);
  } catch {
    return null;
  }
}

/** 씨앗 고정 무작위 식 표본. `transform.fuzz.test.ts` 와 같은 생성기를 재사용한다. */
function sample(count: number, seed: number): TypedExpr[] {
  const random = rng(seed);
  const out: TypedExpr[] = [];
  for (let i = 0; out.length < count && i < count * 60; i += 1) {
    const e = usableExpr(randomLatex(random, 1 + Math.floor(random() * 3), LEAVES));
    if (e !== null) out.push(e);
  }
  return out;
}

const SAMPLES = sample(400, 0x5eed);

describe('compareExpr', () => {
  it('충분한 표본이 모인다', () => {
    expect(SAMPLES.length).toBe(400);
  });

  it('compareExpr(a,b) === 0 ⟺ exprKey(a) === exprKey(b)', () => {
    const failures: string[] = [];
    // 자기 자신과, 그리고 이웃 표본과 짝지어 본다 — 자기 자신은 항상 같아야 하고,
    // 이웃끼리는 대개 달라야 한다(어느 쪽이든 불변식은 지켜져야 한다).
    for (let i = 0; i < SAMPLES.length; i += 1) {
      const a = SAMPLES[i];
      const b = SAMPLES[(i + 1) % SAMPLES.length];
      for (const [x, y] of [[a, a], [a, b]] as const) {
        const byCompare = compareExpr(x, y) === 0;
        const byKey = exprKey(x) === exprKey(y);
        if (byCompare !== byKey) {
          failures.push(
            `compareExpr=${compareExpr(x, y)} but exprKey ${byKey ? '==' : '!='}: ` +
              `${exprKey(x)} vs ${exprKey(y)}`,
          );
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });

  it('반대칭이다 — sign(cmp(a,b)) === -sign(cmp(b,a))', () => {
    const failures: string[] = [];
    for (let i = 0; i < SAMPLES.length; i += 1) {
      const a = SAMPLES[i];
      const b = SAMPLES[(i + 7) % SAMPLES.length];
      const ab = Math.sign(compareExpr(a, b));
      const ba = Math.sign(compareExpr(b, a));
      if (ab !== -ba) failures.push(`${exprKey(a)} vs ${exprKey(b)}: ${ab} / ${ba}`);
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });

  it('추이성 — a<=b, b<=c 이면 a<=c', () => {
    const failures: string[] = [];
    for (let i = 0; i + 2 < SAMPLES.length; i += 3) {
      const [a, b, c] = [SAMPLES[i], SAMPLES[i + 1], SAMPLES[i + 2]];
      const ab = compareExpr(a, b);
      const bc = compareExpr(b, c);
      const ac = compareExpr(a, c);
      if (ab <= 0 && bc <= 0 && ac > 0) {
        failures.push(`${exprKey(a)} <= ${exprKey(b)} <= ${exprKey(c)} but a > c`);
      }
      if (ab >= 0 && bc >= 0 && ac < 0) {
        failures.push(`${exprKey(a)} >= ${exprKey(b)} >= ${exprKey(c)} but a < c`);
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });
});

describe('sortScalars', () => {
  it('멱등이다 — 두 번 정렬해도 같다', () => {
    for (const e of SAMPLES.slice(0, 100)) {
      const once = sortScalars([e, e, e]);
      const twice = sortScalars(once);
      expect(twice.map(exprKey)).toEqual(once.map(exprKey));
    }
  });

  it('입력 순서와 무관하다 — 셔플해도 같은 정렬 결과가 나온다', () => {
    const group = SAMPLES.slice(0, 6);
    const forward = sortScalars(group).map(exprKey);
    const shuffled = [...group].reverse();
    const backward = sortScalars(shuffled).map(exprKey);
    expect(backward).toEqual(forward);
  });

  it('길이 0·1 은 입력을 그대로 돌려준다', () => {
    const empty: TypedExpr[] = [];
    expect(sortScalars(empty)).toBe(empty);
    const single = [SAMPLES[0]];
    expect(sortScalars(single)).toBe(single);
  });
});
