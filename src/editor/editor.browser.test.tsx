import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import type { MathfieldElement } from 'mathlive';
import { createField } from './harness';
import { MathField } from '../components/MathField';
import { ce } from '../engine/ce';
import { modelOf } from './internals';
import { siblingRunRange } from './selection';
import { KEY_OPS, dispatchKeyOp } from './keyOps';
import { findViolations, repairLatex } from './wellformed';

/**
 * 에디터 회귀 스위트 — 실제 MathLive(헤드리스 Chromium)를 구동한다.
 *
 * 두 층위:
 * 1. "MathLive 동작 핀": 우리가 실측으로 확인하고 설계 근거로 삼은 MathLive의
 *    직렬화/이벤트 동작을 고정한다. 버전 업에서 여기가 깨지면 classifyEdit·
 *    sanitizeLatex의 가정을 재검토해야 한다는 신호다.
 * 2. "MathField 통합": 우리 래퍼(교정 되써넣기, `)` 인터셉터)가 실제 편집
 *    시나리오에서 문서를 오염 없이 유지하는지.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('MathLive 동작 핀 — fence 삭제 직렬화', () => {
  const cases: { name: string; latex: string; pos: number; cmd: string; expected: string }[] = [
    { name: '빈 쌍 안에서 backspace(( 삭제)', latex: String.raw`x\left(\right)`, pos: 2, cmd: 'deleteBackward', expected: String.raw`x\left.\right)` },
    { name: '빈 쌍 뒤에서 backspace() 삭제)', latex: String.raw`x\left(\right)`, pos: 3, cmd: 'deleteBackward', expected: String.raw`x\left(\right.` },
    { name: '빈 쌍 안에서 del() 삭제)', latex: String.raw`x\left(\right)`, pos: 2, cmd: 'deleteForward', expected: String.raw`x\left(\right.` },
    { name: '내용 쌍 뒤에서 backspace', latex: String.raw`\left(a+b\right)`, pos: 6, cmd: 'deleteBackward', expected: String.raw`\left(a+b\right.` },
    { name: '내용 쌍 앞에서 backspace(( 삭제)', latex: String.raw`\left(a+b\right)`, pos: 1, cmd: 'deleteBackward', expected: String.raw`\left.a+b\right)` },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const f = await createField(c.latex);
      cleanups.push(f.dispose);
      f.mf.position = c.pos;
      await f.command(c.cmd);
      expect(f.value()).toBe(c.expected);
    });
  }

  it('평평한 미결 괄호는 재직렬화가 안정적이고, 앞 `(` 입력은 스스로 짝을 찾는다', async () => {
    const f = await createField('a+b)');
    cleanups.push(f.dispose);
    expect(f.value()).toBe('a+b)');
    f.mf.position = 0;
    await f.type('(');
    expect(f.value()).toBe(String.raw`\left(a+b\right)`);
  });
});

describe('MathLive 동작 핀 — 구조 이벤트 시퀀스 (classifyEdit의 실측 근거)', () => {
  it('1/cosy: 분수 구조 + placeholder 치환', async () => {
    const f = await createField();
    cleanups.push(f.dispose);
    await f.type('1/cosy');
    expect(f.events.map((e) => e.latex)).toEqual([
      '1',
      String.raw`\frac{1}{\placeholder{}}`,
      String.raw`\frac{1}{c}`,
      String.raw`\frac{1}{co}`,
      String.raw`\frac{1}{cos}`,
      String.raw`\frac{1}{cosy}`,
    ]);
    // placeholder 치환은 캐럿이 제자리 (4→4), 이후는 +1씩
    expect(f.events.map((e) => e.pos)).toEqual([1, 4, 4, 5, 6, 7]);
  });

  it('e^siny: `^` 단독은 이벤트가 없고 첫 글자와 결합해 온다', async () => {
    const f = await createField();
    cleanups.push(f.dispose);
    await f.type('e^siny');
    expect(f.events.map((e) => e.latex)).toEqual([
      'e',
      'e^{s}',
      'e^{si}',
      'e^{sin}',
      'e^{siny}',
    ]);
  });

  it('x^234: 지수 숫자는 중괄호 없이 깨끗하게 이어진다', async () => {
    const f = await createField();
    cleanups.push(f.dispose);
    await f.type('x^234');
    expect(f.events.map((e) => e.latex)).toEqual(['x', 'x^2', 'x^23', 'x^234']);
  });
});

describe('선택 불변식 — 항상 한 레벨의 연속 형제 열', () => {
  const MIXED = String.raw`1+\frac{a}{b+c}+\begin{pmatrix}1 & 2\\ 3 & 4\end{pmatrix}+x^{2y}`;

  /** 범위 안 atom들이 모두 같은 (부모, branch)인지 — 불변식 그 자체. */
  const isSiblingRun = (mf: Parameters<typeof modelOf>[0], range: [number, number]) => {
    const model = modelOf(mf)!;
    const atoms = model.getAtoms(range);
    if (atoms.length === 0) return true;
    const parent = atoms[0].parent ?? null;
    const branch = JSON.stringify(atoms[0].parentBranch ?? null);
    return atoms.every(
      (a) => (a.parent ?? null) === parent && JSON.stringify(a.parentBranch ?? null) === branch,
    );
  };

  it('레벨을 걸친 범위는 감싸는 요소 전체로 스냅한다', async () => {
    const f = await createField(MIXED);
    cleanups.push(f.dispose);
    const model = modelOf(f.mf)!;
    const snap = (a: number, b: number) => {
      const r = siblingRunRange(model, a, b)!;
      return f.mf.getValue({ ranges: [r] }, 'latex');
    };
    // 분수 분자 일부 / 분자~분모 걸침 → 분수 통째
    expect(snap(3, 5)).toBe(String.raw`\frac{a}{b+c}`);
    expect(snap(4, 8)).toBe(String.raw`\frac{a}{b+c}`);
    // 행렬 셀을 가로지르는 범위 → 행렬 통째
    expect(snap(12, 15)).toContain(String.raw`\begin{pmatrix}`);
    expect(snap(12, 15)).toContain(String.raw`\end{pmatrix}`);
    // 밑~지수 걸침 → 밑을 포함한 거듭제곱 전체 (첨자만 남으면 파싱 불가)
    expect(snap(20, 23)).toBe('x^{2y}');
  });

  it('스냅 결과는 항상 형제 열이고, 멱등이며, 원래 범위를 포함한다 (fuzz)', async () => {
    const f = await createField(MIXED);
    cleanups.push(f.dispose);
    const model = modelOf(f.mf)!;
    const last = model.lastOffset;
    let seed = 42;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    let checked = 0;
    for (let i = 0; i < 200; i += 1) {
      const a = Math.floor(rnd() * (last + 1));
      const b = Math.floor(rnd() * (last + 1));
      if (a === b) continue;
      const range = siblingRunRange(model, a, b);
      expect(range).not.toBeNull();
      const [x, y] = range!;
      expect(isSiblingRun(f.mf, [x, y])).toBe(true); // ① 형제 열
      expect(siblingRunRange(model, x, y)).toEqual([x, y]); // ② 멱등
      expect(x).toBeLessThanOrEqual(Math.min(a, b)); // ③ 포함
      expect(y).toBeGreaterThanOrEqual(Math.max(a, b));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(150);
  });

  it('스냅된 선택의 LaTeX는 독립 부분식으로 파싱된다', async () => {
    const f = await createField(MIXED);
    cleanups.push(f.dispose);
    const model = modelOf(f.mf)!;
    const seen = new Set<string>();
    for (let a = 0; a <= model.lastOffset; a += 1) {
      for (let b = a + 1; b <= model.lastOffset; b += 1) {
        const r = siblingRunRange(model, a, b);
        if (r === null) continue;
        const latex = f.mf.getValue({ ranges: [r] }, 'latex').trim();
        if (latex === '' || seen.has(latex)) continue;
        seen.add(latex);
        // 연산자로 끝나는 조각(`a+`)은 형제 열이지만 미완성 — 그건 정상이다.
        if (/[+\-*/^_=]$/.test(latex)) continue;
        expect(ce.parse(latex).isValid, `parse ${latex}`).toBe(true);
      }
    }
    expect(seen.size).toBeGreaterThan(10);
  });
});

describe('키 연산 — 선언된 시나리오 순회', () => {
  for (const op of KEY_OPS) {
    describe(`${op.id}: ${op.summary}`, () => {
      for (const s of op.scenarios) {
        it(`${JSON.stringify(s.start)} + ${s.key} → ${JSON.stringify(s.expect)}`, async () => {
          const f = await createField(s.start);
          cleanups.push(f.dispose);
          if (s.selection !== undefined) {
            f.mf.selection = { ranges: [s.selection], direction: 'forward' };
          } else {
            f.mf.position = s.caret ?? f.mf.lastOffset;
          }
          await f.settle();
          const handled = dispatchKeyOp(f.mf, s.key);
          expect(handled, '연산이 이 상황을 잡아야 한다').toBe(true);
          await f.settle();
          expect(f.value()).toBe(s.expect);
          // 어떤 연산도 파손을 남기지 않는다
          expect(findViolations(f.value())).toEqual([]);
        });
      }
    });
  }
});

describe('사용자 보고 파손 경로 — 실제 편집으로 재현', () => {
  /** 앱과 같은 파이프라인: 편집 후 교정본이 문서가 된다. */
  const docOf = (latex: string) => repairLatex(latex).latex;

  it('e^1: 지수 안 맨 앞 backspace → 1이 내려온다 (^도 함께 제거)', async () => {
    const f = await createField('e^1');
    cleanups.push(f.dispose);
    f.mf.position = 2; // 지수 내용 맨 앞
    await f.settle();
    expect(dispatchKeyOp(f.mf, 'Backspace')).toBe(true);
    await f.settle();
    expect(f.value()).toBe('e1');
  });

  it('a_1: 아래첨자도 같다', async () => {
    const f = await createField('a_1');
    cleanups.push(f.dispose);
    f.mf.position = 2;
    await f.settle();
    expect(dispatchKeyOp(f.mf, 'Backspace')).toBe(true);
    await f.settle();
    expect(f.value()).toBe('a1');
  });

  it('밑이 사라져 첨자만 남으면 교정이 벗겨낸다', async () => {
    // MathLive에서 밑을 지우면 `^1`이 남는다(실측) — 구조 규칙이 백스톱.
    expect(docOf('^1')).toBe('1');
    expect(docOf('_1')).toBe('1');
  });

  it('빈 식에서 ) 입력 → 빈 쌍, 캐럿은 안쪽', async () => {
    const f = await createField('');
    cleanups.push(f.dispose);
    expect(dispatchKeyOp(f.mf, ')')).toBe(true);
    await f.settle();
    expect(f.value()).toBe(String.raw`\left(\right)`);
    // 캐럿은 쌍 안쪽 (바깥 끝이 아니다)
    expect(f.mf.position).toBeLessThan(f.mf.lastOffset);
  });

  it('여는 괄호 삭제 → 쌍이 함께 벗겨지고 내용은 남는다', async () => {
    const f = await createField(String.raw`\left(a+b\right)`);
    cleanups.push(f.dispose);
    f.mf.position = 1; // 내용 맨 앞 (= 여는 구분자 바로 뒤)
    await f.settle();
    expect(dispatchKeyOp(f.mf, 'Backspace')).toBe(true);
    await f.settle();
    expect(f.value()).toBe('a+b');
  });

  it('닫는 괄호 뒤 backspace → 지우지 않고 커서만 안으로', async () => {
    const f = await createField(String.raw`\left(a+b\right)`);
    cleanups.push(f.dispose);
    f.mf.position = f.mf.lastOffset;
    await f.settle();
    expect(dispatchKeyOp(f.mf, 'Backspace')).toBe(true);
    await f.settle();
    expect(f.value()).toBe(String.raw`\left(a+b\right)`); // 그대로
    expect(f.mf.position).toBeLessThan(f.mf.lastOffset); // 캐럿은 그룹 안
  });

  it('밑 없는 ^ / _ 입력은 차단된다', async () => {
    const f = await createField('');
    cleanups.push(f.dispose);
    expect(dispatchKeyOp(f.mf, '^')).toBe(true);
    await f.settle();
    expect(f.value()).toBe('');
    expect(dispatchKeyOp(f.mf, '_')).toBe(true);
    await f.settle();
    expect(f.value()).toBe('');
  });

  it('MathLive가 남기는 반쪽 fence는 교정된다 (undo/redo·factor 경로 포함)', async () => {
    const f = await createField(String.raw`\left(a+b\right)`);
    cleanups.push(f.dispose);
    f.mf.position = f.mf.lastOffset;
    await f.command('deleteBackward'); // MathLive 기본 삭제 = 반쪽 fence
    expect(f.value()).toContain(String.raw`\right.`);
    expect(docOf(f.value())).toBe('a+b'); // 게이트가 교정하면 쌍이 함께 사라진다
  });
});

describe('구조 불변식 fuzz — 무작위 편집열', () => {
  /** 앱 파이프라인 재현: 키 연산(있으면) → MathLive 기본 → 게이트 교정. */
  const applyKey = (mf: Parameters<typeof dispatchKeyOp>[0], key: string) => {
    if (dispatchKeyOp(mf, key)) return;
    if (key === 'Backspace') mf.executeCommand('deleteBackward');
    else if (key === 'Delete') mf.executeCommand('deleteForward');
    else if (key === 'ArrowLeft') mf.executeCommand('moveToPreviousChar');
    else if (key === 'ArrowRight') mf.executeCommand('moveToNextChar');
    else mf.executeCommand(['typedText', key, { simulateKeystroke: true }]);
  };

  const KEYS = [
    'x', 'y', '1', '2', '+', '-', '/', '^', '_', '(', ')', '[', ']',
    'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight',
  ];

  const contentOf = (latex: string) => (latex.match(/[a-zA-Z0-9]/g) ?? []).sort().join('');

  for (const seed of [1, 2, 3, 4]) {
    it(`seed=${seed}: 매 스텝 문서가 정규형이고 undo 대상이 안전하다`, async () => {
      const f = await createField('');
      cleanups.push(f.dispose);
      let s = seed >>> 0;
      const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
      /** 게이트를 거친 "문서" 열 — undo가 되돌아갈 수 있는 상태들. */
      const docs: string[] = [''];

      for (let step = 0; step < 60; step += 1) {
        const key = KEYS[Math.floor(rnd() * KEYS.length)];
        applyKey(f.mf, key);
        await f.settle();

        // 게이트: 교정본만 문서가 된다 (MathField의 input 핸들러와 같은 규칙)
        const fix = repairLatex(f.mf.value);
        if (fix.changed) {
          f.mf.setValue(fix.latex, { silenceNotifications: true });
          await f.settle();
        }
        const doc = f.mf.value;

        // ① 문서에 구조 위반이 없다
        expect(findViolations(doc), `seed=${seed} step=${step} key=${key} doc=${doc}`).toEqual([]);
        // ② 재직렬화 안정 (MathLive 왕복 후 동일)
        f.mf.setValue(doc, { silenceNotifications: true });
        expect(f.mf.value, `roundtrip step=${step}`).toBe(doc);
        // ③ 교정이 내용을 잃지 않았다 (교정 전후 내용 문자 비교)
        if (fix.changed) {
          expect(contentOf(fix.latex).length).toBeLessThanOrEqual(contentOf(doc).length + 2);
        }
        docs.push(doc);
      }

      // ④ undo 안전성: 기록된 모든 상태가 정규형이므로, 어느 지점으로 되돌아가도
      //    파손된 문서가 복원되지 않는다. 실제로 되돌려 확인한다.
      for (let i = docs.length - 1; i >= 0; i -= 1) {
        f.mf.setValue(docs[i], { silenceNotifications: true });
        await f.settle();
        expect(findViolations(f.mf.value), `undo target ${i}`).toEqual([]);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// MathField 통합 — React 래퍼를 마운트해 교정 파이프라인을 종단 검증
// ---------------------------------------------------------------------------

type Mounted = {
  mf: MathfieldElement;
  edits: { latex: string; caret: number }[];
  root: Root;
};

async function mountMathField(initial = ''): Promise<Mounted> {
  const host = document.createElement('div');
  document.body.append(host);
  const edits: { latex: string; caret: number }[] = [];
  const root = createRoot(host);
  root.render(
    createElement(MathField, {
      value: initial,
      onEdit: (latex: string, caret: number) => edits.push({ latex, caret }),
    }),
  );
  await new Promise((r) => setTimeout(r, 30));
  const mf = host.querySelector('math-field') as MathfieldElement;
  cleanups.push(() => {
    root.unmount();
    host.remove();
  });
  mf.focus();
  return { mf, edits, root };
}

const settle = () => new Promise((r) => setTimeout(r, 60));

describe('MathField 통합 — 고아 fence 교정 파이프라인', () => {
  it('괄호 한쪽이 깨지면 쌍이 함께 벗겨진다 (내용 유지)', async () => {
    const { mf, edits } = await mountMathField(String.raw`\left(a+b\right)`);
    mf.position = mf.lastOffset;
    mf.executeCommand('deleteBackward'); // MathLive 기본 = 반쪽 fence
    await settle();
    expect(mf.value).toBe('a+b'); // 필드 되써넣기 (구분자 둘 다 제거)
    expect(edits.at(-1)?.latex).toBe('a+b'); // 문서 보고도 교정본
    expect(mf.value).not.toContain(String.raw`\right.`);
  });

  it('사용자 재현: (sinx+cosx) 뒤 빈 쌍을 지워도 문서가 계산 가능하게 유지된다', async () => {
    const base = String.raw`\left(\sin\left(x\right)+\cos\left(x\right)\right)`;
    const { mf, edits } = await mountMathField(base);
    mf.position = mf.lastOffset;
    mf.executeCommand(['typedText', '(', { simulateKeystroke: true }]);
    await settle();
    mf.position = mf.lastOffset; // 쌍 밖으로
    mf.executeCommand('deleteBackward'); // 반쪽 fence가 되는 삭제
    await settle();
    const doc = edits.at(-1)?.latex ?? '';
    // 쌍이 통째로 사라져 원래 식으로 돌아온다 — 미결 괄호가 남지 않는다.
    expect(doc).toBe(base);
    expect(findViolations(doc)).toEqual([]);
    expect(ce.parse(doc).isValid).toBe(true);
  });

  it('`)` 입력: 미결 평평한 `(`가 있으면 거기부터 닫고, 없으면 왼쪽 전체를 감싼다', async () => {
    // 미결 ( 닫기
    const a = await mountMathField('(a+b');
    a.mf.position = a.mf.lastOffset;
    a.mf.dispatchEvent(
      new KeyboardEvent('keydown', { key: ')', bubbles: true, cancelable: true }),
    );
    await settle();
    expect(a.mf.value).toBe(String.raw`\left(a+b\right)`);

    // 왼쪽 전체 감싸기 (기존 동작 유지)
    const b = await mountMathField('a+b');
    b.mf.position = b.mf.lastOffset;
    b.mf.dispatchEvent(
      new KeyboardEvent('keydown', { key: ')', bubbles: true, cancelable: true }),
    );
    await settle();
    expect(b.mf.value).toBe(String.raw`\left(a+b\right)`);
  });
});
