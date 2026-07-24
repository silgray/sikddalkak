import { describe, expect, it } from 'vitest';
import { RULES, findViolations, repairLatex, contentCount } from './wellformed';
import { forEachTokenList, scanLatex } from './latexScan';

/**
 * 규칙 자체의 사양은 각 규칙의 `examples`에 선언돼 있고, 여기서는 그 선언을
 * 순회한다 — 규칙을 추가하면 테스트도 자동으로 늘어난다.
 * 그 아래 "성질" 테스트는 규칙과 무관하게 항상 성립해야 하는 것들로,
 * 새 규칙이 기존 불변식을 깨면 여기서 잡힌다.
 */

describe('구조 규칙 — 선언된 예시 순회', () => {
  for (const rule of RULES) {
    describe(`${rule.id}: ${rule.summary}`, () => {
      for (const { before, after } of rule.examples) {
        it(`${JSON.stringify(before)} → ${JSON.stringify(after)}`, () => {
          expect(repairLatex(before).latex).toBe(after);
        });
      }
    });
  }
});

describe('사용자 보고 파손 경로', () => {
  const cases: { name: string; broken: string; fixed: string }[] = [
    { name: '밑 없는 지수', broken: '^1', fixed: '1' },
    { name: '밑 없는 아래첨자', broken: '_1', fixed: '1' },
    { name: '짝 없는 닫는 괄호', broken: ')', fixed: '' },
    { name: '짝 없는 여는 괄호', broken: '(a+b', fixed: 'a+b' },
    { name: '반쪽 fence (닫는 쪽 삭제)', broken: String.raw`\left(a+b\right.`, fixed: 'a+b' },
    { name: '반쪽 fence (여는 쪽 삭제)', broken: String.raw`\left.a+b\right)`, fixed: 'a+b' },
    { name: '빈 지수', broken: 'x^{}', fixed: 'x' },
    { name: '빈 아래첨자', broken: 'x_{}', fixed: 'x' },
  ];
  for (const { name, broken, fixed } of cases) {
    it(name, () => {
      expect(findViolations(broken).length).toBeGreaterThan(0);
      expect(repairLatex(broken).latex).toBe(fixed);
      expect(findViolations(fixed)).toEqual([]);
    });
  }
});

describe('성질 — 규칙과 무관하게 항상 성립', () => {
  const CORPUS = [
    '',
    'x',
    'x^2',
    'x_1^2',
    '1+x',
    String.raw`\frac{1}{1+x}`,
    String.raw`\left(a+b\right)`,
    String.raw`\left(0,1\right]`,
    String.raw`\begin{pmatrix}1 & 2\\ 3 & 4\end{pmatrix}`,
    String.raw`\sin^2 x+\cos^2 x`,
    // 미완성 (정상)
    'x+',
    String.raw`\frac{1}{\placeholder{}}`,
    String.raw`\left(\right)`,
    // 파손
    '^1',
    '(a+b',
    'a+b)',
    String.raw`\left(a+b\right.`,
    'x^{}',
    String.raw`x\left(\right.`,
    String.raw`\left(a+\left(b\right.\right)`,
  ];

  it('멱등: 교정본을 다시 교정해도 그대로', () => {
    for (const latex of CORPUS) {
      const once = repairLatex(latex).latex;
      expect(repairLatex(once).latex, latex).toBe(once);
    }
  });

  it('교정본에는 위반이 남지 않는다', () => {
    for (const latex of CORPUS) {
      expect(findViolations(repairLatex(latex).latex), latex).toEqual([]);
    }
  });

  it('내용 보존: 구조 토큰만 사라지고 내용은 잃지 않는다', () => {
    // 명령어 이름의 글자(\left의 l,e,f,t)가 아니라 **내용 문자**만 센다.
    const contentChars = (s: string) => {
      const out: string[] = [];
      forEachTokenList(scanLatex(s), (tokens) => {
        for (const t of tokens) if (t.kind === 'char' && /[a-zA-Z0-9]/.test(t.text)) out.push(t.text);
      });
      return out.sort().join('');
    };
    for (const latex of CORPUS) {
      expect(contentChars(repairLatex(latex).latex), latex).toBe(contentChars(latex));
    }
  });

  it('미완성 식은 건드리지 않는다', () => {
    const incomplete = [
      'x+',
      String.raw`\frac{1}{\placeholder{}}`,
      String.raw`\left(\right)`,
      String.raw`\frac{\placeholder{}}{\placeholder{}}`,
    ];
    for (const latex of incomplete) {
      expect(repairLatex(latex).changed, latex).toBe(false);
    }
  });

  it('정상 식은 바이트 그대로 보존된다', () => {
    const wellFormed = CORPUS.filter((l) => findViolations(l).length === 0);
    expect(wellFormed.length).toBeGreaterThan(10);
    for (const latex of wellFormed) {
      expect(repairLatex(latex).latex, latex).toBe(latex);
    }
  });
});

describe('스캐너와 캐럿 기준', () => {
  it('중첩 그룹과 fence를 위치와 함께 읽는다', () => {
    const doc = scanLatex(String.raw`\frac{a}{\left(b\right)}`);
    expect(doc.tokens.map((t) => t.kind)).toEqual(['command', 'group', 'group']);
    const denom = doc.tokens[2];
    expect(denom.children?.map((t) => t.kind)).toEqual(['fenceOpen', 'char', 'fenceClose']);
    // 위치 정보가 원본과 일치한다 (splice 기반 교정의 전제)
    expect(doc.latex.slice(denom.start, denom.end)).toBe(String.raw`{\left(b\right)}`);
  });

  it('contentCount는 구조 토큰을 세지 않는다', () => {
    expect(contentCount('ab')).toBe(2);
    expect(contentCount(String.raw`\left(ab\right)`)).toBe(2); // 구분자는 제외
    expect(contentCount('a^2')).toBe(2); // ^ 는 제외, a와 2만
    expect(contentCount(String.raw`\frac{a}{b}`)).toBe(3); // \frac + a + b
  });
});
