import { describe, expect, it } from 'vitest';
import { addLit, mulLit, negLit, powLit } from './arith';
import { fromCeJson, toCeJson } from './ceJson';
import {
  asInteger,
  intLit,
  isOne,
  isZero,
  literalKey,
  splitSign,
  toRealNumber,
  type Literal,
} from './literal';

/**
 * 리터럴 층 테스트.
 *
 * 여기서 보는 건 **정규형이 실제로 지켜지는가** 하나다 — 기약분수, 부호는 분자,
 * 분모 1이면 정수. 이게 깨지면 `exprKey` 가 흔들리고 동류항 판정이 통째로 무너진다.
 */

/** `n/d` 를 CE 경유로 만든다 (리터럴이 생기는 정상 경로와 같게). */
function rat(n: number, d: number): Literal {
  const l = fromCeJson(['Rational', n, d]);
  if (l === null) throw new Error(`rational ${n}/${d} rejected`);
  return l;
}

const key = (l: Literal | null): string => (l === null ? '<null>' : literalKey(l));

describe('정규형 — CE가 만들어 준다', () => {
  it('기약분수로 줄인다', () => {
    expect(key(rat(6, 4))).toBe('3/2');
    expect(key(rat(100, 25))).toBe('4');
  });

  it('부호는 항상 분자로 올린다', () => {
    expect(key(rat(3, -7))).toBe('-3/7');
    expect(key(rat(-3, 7))).toBe('-3/7');
    expect(key(rat(-3, -7))).toBe('3/7');
  });

  it('분모가 1이면 정수로 무너진다', () => {
    expect(key(rat(4, 2))).toBe('2');
    expect(key(rat(13, 1))).toBe('13');
    expect(key(rat(0, 3))).toBe('0');
  });

  it('0으로 나누는 건 리터럴이 아니다', () => {
    // CE는 ComplexInfinity/NaN 을 주는데, 그게 sym 으로 새면 "변수 NaN" 이 된다.
    expect(fromCeJson(['Rational', 1, 0])).toBeNull();
    expect(fromCeJson('ComplexInfinity')).toBeNull();
    expect(fromCeJson('NaN')).toBeNull();
  });
});

describe('산술 — 정확해야 한다', () => {
  it('유리수 덧셈이 정확하다 (동류항 합치기가 여기 걸려 있다)', () => {
    // 목표 케이스: \frac{3}{7}AcB + \frac{1}{5}cAB -> \frac{22}{35}cAB
    expect(key(addLit(rat(3, 7), rat(1, 5)))).toBe('22/35');
    expect(key(addLit(rat(1, 3), rat(1, 6)))).toBe('1/2');
    expect(key(addLit(rat(1, 2), rat(1, 2)))).toBe('1');
    expect(key(addLit(rat(1, 3), rat(-1, 3)))).toBe('0');
  });

  it('유리수 곱셈이 정확하다', () => {
    expect(key(mulLit(rat(2, 3), rat(3, 4)))).toBe('1/2');
    expect(key(mulLit(rat(3, 7), intLit(7)))).toBe('3');
  });

  it('소수는 IEEE가 아니라 십진으로 더한다', () => {
    const a = fromCeJson(0.1);
    const b = fromCeJson(0.2);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // JS로는 0.30000000000000004 다. CE 위임의 존재 이유.
    expect(key(addLit(a as Literal, b as Literal))).toBe('d0.3');
  });

  it('정수 거듭제곱', () => {
    expect(key(powLit(intLit(2), 10))).toBe('1024');
    expect(key(powLit(rat(2, 3), 2))).toBe('4/9');
    expect(key(powLit(intLit(2), -2))).toBe('1/4');
  });

  it('부호 뒤집기는 실패하지 않는다', () => {
    expect(key(negLit(rat(3, 7)))).toBe('-3/7');
    expect(key(negLit(intLit(-5)))).toBe('5');
  });
});

describe('술어', () => {
  it('literalKey 는 단사다 — 종류가 다르면 키도 달라야 한다', () => {
    // decimal 3 과 int 3 이 같은 키를 내면 동류항 판정이 둘을 섞어버린다.
    const dec = fromCeJson(3.5);
    expect(literalKey(intLit(3))).toBe('3');
    expect(key(dec)).toBe('d3.5');
    expect(literalKey(intLit(3))).not.toBe(key(fromCeJson({ num: '3.0' })));
  });

  it('splitSign 은 부호를 바깥으로 낸다', () => {
    expect(splitSign(intLit(-3))).toEqual({ negative: true, magnitude: intLit(3) });
    expect(splitSign(intLit(3)).negative).toBe(false);
    const r = splitSign(rat(-3, 7));
    expect(r.negative).toBe(true);
    expect(literalKey(r.magnitude)).toBe('3/7');
  });

  it('isZero / isOne / asInteger', () => {
    expect(isZero(intLit(0))).toBe(true);
    expect(isOne(intLit(1))).toBe(true);
    expect(isOne(rat(3, 2))).toBe(false);
    expect(asInteger(intLit(7))).toBe(7);
    expect(asInteger(rat(3, 2))).toBeNull();
  });

  it('toRealNumber 는 수치 대조용', () => {
    expect(toRealNumber(rat(1, 4))).toBe(0.25);
    expect(toRealNumber(intLit(-3))).toBe(-3);
  });
});

describe('CE 왕복', () => {
  it('toCeJson -> fromCeJson 이 제자리로 돌아온다', () => {
    for (const l of [intLit(0), intLit(-7), rat(3, 7), rat(-22, 35)]) {
      expect(key(fromCeJson(toCeJson(l)))).toBe(literalKey(l));
    }
  });

  it('안전 정수를 벗어나는 리터럴은 정직하게 거절한다', () => {
    // 조용히 뭉개면 값이 달라진다. 거절하면 호출자가 원식을 유지한다.
    expect(fromCeJson({ num: '123456789012345678901234567890' })).toBeNull();
  });
});
