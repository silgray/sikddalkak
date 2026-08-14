import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import type { MathfieldElement } from 'mathlive';
import { createField } from './harness';
import { MathField } from '../components/MathField';
import { parseSyntax } from '../algebra';
import { finalizeGhostFences, modelOf } from './internals';
import { expandSelectionSemantic, siblingRunRange } from './selection';
import { KEY_OPS, dispatchKeyOp } from './keyOps';
import { findViolations, repairLatex } from './wellformed';
import { BLOCKED_KEYBINDINGS } from './keybindings';

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
        expect(parseSyntax(latex).ok, `parse ${latex}`).toBe(true);
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

  it('e^1: 지수 안 맨 앞 backspace → 1이 내려오고 커서는 지수였던 자리(밑 뒤)', async () => {
    const f = await createField('e^1');
    cleanups.push(f.dispose);
    f.mf.position = 2; // 지수 내용 맨 앞
    await f.settle();
    expect(dispatchKeyOp(f.mf, 'Backspace')).toBe(true);
    await f.settle();
    expect(f.value()).toBe('e1');
    // 밑 e는 그대로, 커서는 내려온 1의 맨 앞 (e와 1 사이) — offset 1.
    expect(f.mf.position).toBe(1);
  });

  it('a_1: 아래첨자도 같다 (커서도 밑 뒤)', async () => {
    const f = await createField('a_1');
    cleanups.push(f.dispose);
    f.mf.position = 2;
    await f.settle();
    expect(dispatchKeyOp(f.mf, 'Backspace')).toBe(true);
    await f.settle();
    expect(f.value()).toBe('a1');
    expect(f.mf.position).toBe(1);
  });

  it('밑이 사라져 첨자만 남으면 교정이 벗겨낸다', async () => {
    // MathLive에서 밑을 지우면 `^1`이 남는다(실측) — 구조 규칙이 백스톱.
    expect(docOf('^1')).toBe('1');
    expect(docOf('_1')).toBe('1');
  });

  it('빈 식에서 ) 입력 → 빈 쌍, 캐럿은 바깥 (여는 괄호의 거울상)', async () => {
    const f = await createField('');
    cleanups.push(f.dispose);
    expect(dispatchKeyOp(f.mf, ')')).toBe(true);
    await f.settle();
    expect(f.value()).toBe(String.raw`\left(\right)`);
    // `(` 가 캐럿을 쌍 **안**에 두는 것의 거울상 — `)` 는 쌍 **밖**(닫은 뒤)에 둔다.
    expect(f.mf.position).toBe(f.mf.lastOffset);
  });

  // 삭제는 우리 keyOp이 한 번에 처리한다 — 반쪽 fence(`\left.`)를 거치지 않으므로
  // 교정 게이트도, 캐럿 재추측도 돌지 않는다. 캐럿은 지운 구분자 자리에 남는다.
  it('여는 구분자 삭제 → 쌍이 함께 사라지고 캐럿은 내용 맨 앞', async () => {
    const f = await createField(String.raw`\left(a+b\right)`);
    cleanups.push(f.dispose);
    await f.settle();
    f.mf.position = 1; // 내용 맨 앞 (= 여는 구분자 바로 뒤)
    expect(dispatchKeyOp(f.mf, 'Backspace')).toBe(true);
    await f.settle();
    expect(f.value()).toBe('a+b');
    expect(f.mf.position).toBe(0); // `a` 앞
  });

  it('닫는 구분자 뒤 backspace → 쌍이 함께 사라지고 캐럿은 내용 맨 뒤', async () => {
    const f = await createField(String.raw`\left(a+b\right)`);
    cleanups.push(f.dispose);
    await f.settle();
    f.mf.position = f.mf.lastOffset;
    expect(dispatchKeyOp(f.mf, 'Backspace')).toBe(true);
    await f.settle();
    expect(f.value()).toBe('a+b');
    expect(f.mf.position).toBe(3); // `b` 뒤
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
    expect(parseSyntax(doc).ok).toBe(true);
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

  /** 실제 앱과 같은 경로: keydown → keyOp(우리) → 없으면 네이티브. */
  const pressKey = (
    mf: MathfieldElement,
    key: string,
    fallback: 'deleteBackward' | 'deleteForward',
  ) => {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    mf.dispatchEvent(ev);
    if (!ev.defaultPrevented) mf.executeCommand(fallback);
  };

  // 사용자 보고 버그: 중첩 괄호를 지우면 캐럿이 남은 괄호 **밖**으로 튀었다.
  // 이제 keyOp이 캐럿까지 직접 정하므로 남은 괄호 안에 머문다.
  it('중첩 괄호 안쪽을 지워도 캐럿이 남은 괄호 안에 머문다', async () => {
    const { mf } = await mountMathField(String.raw`x\left(\left(a\right)\right)`);
    mf.position = 3; // 안쪽 fence 본문 시작
    pressKey(mf, 'Backspace', 'deleteBackward');
    await settle();
    expect(mf.value).toBe(String.raw`x\left(a\right)`);
    expect(mf.position).toBe(2); // 남은 괄호 **안**, `a` 앞
  });

  // 빈 본문 중첩은 내용 카운트가 전부 0이라 옛 휴리스틱이 가장 크게 어긋나던 자리다.
  it('빈 본문 중첩을 지워도 캐럿이 남은 괄호 안에 머문다', async () => {
    const { mf } = await mountMathField(String.raw`\left(\left(\right)\right)`);
    mf.position = 2; // 안쪽 빈 본문
    pressKey(mf, 'Backspace', 'deleteBackward');
    await settle();
    expect(mf.value).toBe(String.raw`\left(\right)`);
    expect(mf.position).toBe(1); // `()` 안 — 밖(2)이 아니다
  });

  it('구조가 낀 괄호를 지워도 캐럿이 그 구조 밖에 남는다', async () => {
    const { mf } = await mountMathField(String.raw`x\left(\frac{a}{b}\right)y`);
    mf.position = 2; // fence 본문 시작 (분수 앞)
    pressKey(mf, 'Backspace', 'deleteBackward');
    await settle();
    expect(mf.value).toBe(String.raw`x\frac{a}{b}y`);
    expect(mf.position).toBe(1); // 분수 **밖** — 분자 안(2)이 아니다
  });

  it('평범한 괄호 삭제는 캐럿 위치가 그대로다 (회귀 방지)', async () => {
    const { mf } = await mountMathField(String.raw`xy\left(a+b\right)`);
    mf.position = 3; // 본문 시작
    pressKey(mf, 'Backspace', 'deleteBackward');
    await settle();
    expect(mf.value).toBe('xya+b');
    expect(mf.position).toBe(2); // `xy` 뒤, `a` 앞
  });

  // 사용자 보고 버그: 행렬 마지막 행을 비우면 matrix-trailing-empty-row 규칙이
  // placeholder를 끼워 넣는데, contentCount 기반 캐럿 복원이 "방금 비운 그 칸"과
  // "그 앞 행의 끝"을 구분하지 못해(둘 다 앞선 내용 카운트가 같다) 캐럿이 앞 행에
  // 남았다. 그 상태로 이어 입력하면 값이 엉뚱한 행에 끼어든다(실측: 마지막 행 "3"을
  // 지우고 "5"를 치면 2행이 "25"가 됨). 이제 caret이 placeholder 바로 앞에 놓여
  // 이어 입력이 그 자리를 자연스럽게 대체한다.
  it('행렬 마지막 행을 비우고 이어 입력하면 그 행에 들어간다', async () => {
    const { mf } = await mountMathField(String.raw`\begin{pmatrix}1\\2\\3\end{pmatrix}`);
    mf.position = 6; // '3' 바로 뒤 (셀 안)
    pressKey(mf, 'Backspace', 'deleteBackward');
    await settle();
    expect(mf.value).toBe(String.raw`\begin{pmatrix}1\\ 2\\ \placeholder{}\end{pmatrix}`);
    mf.executeCommand(['typedText', '5', { simulateKeystroke: true }]);
    await settle();
    // 2행이 "25"로 오염되지 않고, 3행에 "5"가 들어간다.
    expect(mf.value).toBe(String.raw`\begin{pmatrix}1\\ 2\\ 5\end{pmatrix}`);
  });

  it('Escape는 비활성화 — 선택 확장도, 원본 LaTeX 모드 전환도 없다', async () => {
    // MathLive 기본 ESC는 선택을 확장하다가 끝에서 원본 LaTeX 모드로 넘어가
    // 렌더가 깨진다. capture 가드가 이를 통째로 막는다.
    const { mf } = await mountMathField('a+b+c');
    mf.position = 2; // 식 중간
    for (let i = 0; i < 4; i += 1) {
      mf.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    }
    await settle();
    expect(mf.value).toBe('a+b+c'); // 값 불변
    expect(mf.mode).toBe('math'); // 원본 LaTeX 모드로 안 넘어감
    expect(mf.selectionIsCollapsed).toBe(true); // 선택도 확장 안 됨
  });

  it('마운트 후 mf.keybindings 에 차단 key 가 하나도 없다', async () => {
    const { mf } = await mountMathField('a');
    const remaining = mf.keybindings.map((kb) => kb.key).filter((key) => BLOCKED_KEYBINDINGS.has(key));
    expect(remaining).toEqual([]);
  });

  it(String.raw`Ctrl+2 를 눌러도 \sqrt 가 안 들어간다 (기본 키바인딩 차단)`, async () => {
    const { mf } = await mountMathField('a');
    mf.position = mf.lastOffset;
    mf.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: '2',
        code: 'Digit2',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await settle();
    expect(mf.value).toBe('a');
    expect(mf.value).not.toContain('sqrt');
  });

  it(String.raw`Alt+D 를 눌러도 \differentialD 가 안 들어간다 (기본 키바인딩 차단)`, async () => {
    const { mf } = await mountMathField('a');
    mf.position = mf.lastOffset;
    mf.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'd',
        code: 'KeyD',
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await settle();
    expect(mf.value).toBe('a');
    expect(mf.value).not.toContain('differentialD');
  });
});

/**
 * 모델의 fence 구분자 상태. ghost는 `'?'` 로 나타난다 — LaTeX에는 안 보이므로
 * (직렬화가 짝으로 바꾼다) 모델을 직접 봐야 ghost 여부를 확인할 수 있다.
 */
function ghostFences(mf: MathfieldElement): { left?: string; right?: string }[] {
  const model = modelOf(mf);
  if (model === null) return [];
  const out: { left?: string; right?: string }[] = [];
  for (let q = 0; q <= model.lastOffset; q += 1) {
    const atom = model.at(q);
    if (atom?.type === 'leftright') out.push({ left: atom.leftDelim, right: atom.rightDelim });
  }
  return out;
}

describe('괄호 로직 — 네이티브 smartFence + 닫는 괄호 거울상', () => {
  // 선택 위에 닫는 괄호를 쳐도 dangling이 아니라 감싼다 (네이티브 기형 버그 우회).
  it('선택 + ) → 감쌈 (dangling 아님)', async () => {
    const f = await createField('a+b');
    cleanups.push(f.dispose);
    f.mf.selection = { ranges: [[0, 3]], direction: 'forward' };
    await f.settle();
    expect(dispatchKeyOp(f.mf, ')')).toBe(true);
    await f.settle();
    expect(f.value()).toBe(String.raw`\left(a+b\right)`);
  });

  // ghost 왼쪽 구분자를 만들고, `(` 를 치면 **네이티브가** 승격시킨다 (우리 코드 없음).
  it(') → ghost 여는 괄호, 이후 ( 입력 시 네이티브가 승격', async () => {
    const f = await createField('a+b');
    cleanups.push(f.dispose);
    f.mf.position = f.mf.lastOffset;
    expect(dispatchKeyOp(f.mf, ')')).toBe(true);
    await f.settle();
    // 직렬화는 짝으로 나오지만(internals.ts 패치) 모델은 ghost 상태다.
    expect(f.value()).toBe(String.raw`\left(a+b\right)`);
    expect(ghostFences(f.mf)).toEqual([{ left: '?', right: ')' }]);

    // `(` 는 우리가 잡지 않는다 — 네이티브 smartFence의 ghost-left 분기가 채운다.
    expect(dispatchKeyOp(f.mf, '(')).toBe(false);
    f.mf.executeCommand(['typedText', '(', { simulateKeystroke: true }]);
    await f.settle();
    expect(f.value()).toBe(String.raw`\left(a+b\right)`);
    expect(ghostFences(f.mf)).toEqual([{ left: '(', right: ')' }]); // 승격됨
  });

  // 여는 괄호가 만든 ghost는 네이티브가 승격시킨다 — 우리는 손을 뗀다.
  it('( 로 만든 ghost는 ) 입력 시 네이티브가 승격 (위임)', async () => {
    const f = await createField('');
    cleanups.push(f.dispose);
    f.mf.executeCommand(['typedText', '(', { simulateKeystroke: true }]);
    f.mf.executeCommand(['typedText', 'x', { simulateKeystroke: true }]);
    await f.settle();
    expect(ghostFences(f.mf)).toEqual([{ left: '(', right: '?' }]);
    // 같은 종류의 승격 대상이 있으므로 우리 연산은 비켜선다.
    expect(dispatchKeyOp(f.mf, ')')).toBe(false);
    f.mf.executeCommand(['typedText', ')', { simulateKeystroke: true }]);
    await f.settle();
    expect(f.value()).toBe(String.raw`\left(x\right)`); // 중첩되지 않음
    expect(ghostFences(f.mf)).toEqual([{ left: '(', right: ')' }]);
  });

  // 혼합 구분자 금지: `(` 안에서 `]` 는 그 fence를 닫지 않고 자기 fence를 만든다.
  it('( ghost 안에서 ] → 혼합 없이 각자 fence', async () => {
    const f = await createField('');
    cleanups.push(f.dispose);
    for (const ch of ['(', 'x']) {
      f.mf.executeCommand(['typedText', ch, { simulateKeystroke: true }]);
    }
    await f.settle();
    expect(dispatchKeyOp(f.mf, ']')).toBe(true); // 종류가 달라 우리가 처리
    await f.settle();
    expect(f.value()).toBe(String.raw`\left(\left\lbrack x\right\rbrack\right)`);
  });

  // Fix C: 구간 맨 앞에서는 (커서) 빈 쌍을 넣는다 (감싸기 아님).
  it('분수 분자 맨 앞에서 ) → 맨 앞에 빈 쌍', async () => {
    const f = await createField(String.raw`\frac{1}{x}`);
    cleanups.push(f.dispose);
    await f.settle();
    f.mf.position = 1; // 분자 내용 맨 앞 (settle이 캐럿을 밀지 않게 dispatch 직전에 설정)
    expect(f.mf.position).toBe(1);
    expect(dispatchKeyOp(f.mf, ')')).toBe(true);
    await f.settle();
    expect(f.value()).toBe(String.raw`\frac{\left(\right)1}{x}`);
  });

  // 위임은 **ghost일 때만**이다. 진짜 fence 본문 끝은 위임하지 않는다 —
  // 네이티브가 거기서 하는 건 승격이 아니라 타이핑 오버라서 여닫이가 비대칭해진다.
  // (진짜 fence 케이스는 아래 "거울상" 테스트가 결과까지 고정한다.)
  it('ghost fence 본문 끝에서만 ) 를 위임한다', async () => {
    const ghost = await createField('');
    cleanups.push(ghost.dispose);
    ghost.mf.executeCommand(['typedText', '(', { simulateKeystroke: true }]);
    ghost.mf.executeCommand(['typedText', 'x', { simulateKeystroke: true }]);
    await ghost.settle();
    expect(dispatchKeyOp(ghost.mf, ')')).toBe(false); // ghost → 네이티브에 맡긴다

    const real = await createField(String.raw`\left(x\right)`);
    cleanups.push(real.dispose);
    await real.settle();
    real.mf.position = 2; // 본문 끝
    expect(dispatchKeyOp(real.mf, ')')).toBe(true); // 진짜 fence → 우리가 처리
  });

  // Fix B: Ctrl+D는 원자 → 곱셈 항 → 덧셈식 순으로 오른다.
  it('Ctrl+D: 1+xy → y → xy → 1+xy', async () => {
    const f = await createField('1+xy');
    cleanups.push(f.dispose);
    f.mf.position = f.mf.lastOffset;
    const step = () => {
      expandSelectionSemantic(f.mf);
      return f.mf.getValue(f.mf.selection, 'latex');
    };
    expect(step()).toBe('y');
    expect(step()).toBe('xy');
    expect(step()).toBe('1+xy');
  });

  // 흡수 범위는 여는 괄호의 정확한 거울상이다: `(` 가 캐럿→branch 끝을 삼키듯
  // `)` 는 branch 시작→캐럿을 삼킨다. (항/연산자 경계를 따지지 않는다 — 네이티브와 동일)
  it(') 는 branch 시작부터 캐럿까지 흡수한다 (여는 괄호의 거울상)', async () => {
    const f = await createField('1+xy');
    cleanups.push(f.dispose);
    await f.settle();
    f.mf.position = 2; // + 바로 뒤
    expect(dispatchKeyOp(f.mf, ')')).toBe(true);
    await f.settle();
    expect(f.value()).toBe(String.raw`\left(1+\right)xy`);
    expect(ghostFences(f.mf)).toEqual([{ left: '?', right: ')' }]);
  });

  // MathLive는 ghost **오른쪽**만 반투명 렌더한다. 왼쪽은 internals.ts의 프로토타입
  // 패치가 채운다 — 안 되면 `?` 글리프가 그대로 보이는 깨진 렌더가 되므로 핀으로 고정.
  it('ghost 여는 괄호는 반투명 클래스로 렌더된다', async () => {
    const f = await createField('a+b');
    cleanups.push(f.dispose);
    f.mf.position = f.mf.lastOffset;
    expect(dispatchKeyOp(f.mf, ')')).toBe(true);
    await f.settle();
    const openClasses = [...(f.mf.shadowRoot?.querySelectorAll('[class*="ML__open"]') ?? [])].map(
      (el) => el.className.toString(),
    );
    expect(openClasses.length).toBeGreaterThan(0);
    expect(openClasses.some((c) => c.includes('ML__smart-fence__close'))).toBe(true);
  });

  // 사용자 보고 버그: 진짜 fence 안에서 `)` 가 입력되지 않았다. 위임 조건이 넓어
  // 네이티브가 짝 없는 `)` 를 넣었고 교정 규칙(unmatched-delim)이 그걸 지웠다.
  it('진짜 fence 본문 중간에서 ) → 입력이 취소되지 않는다', async () => {
    const f = await createField(String.raw`\left(1+x\right)`);
    cleanups.push(f.dispose);
    await f.settle();
    f.mf.position = 3; // 본문 중간 (`1+` 뒤)
    expect(dispatchKeyOp(f.mf, ')')).toBe(true); // 위임하지 않고 우리가 처리
    await f.settle();
    expect(f.value()).toBe(String.raw`\left(\left(1+\right)x\right)`);
    expect(findViolations(f.value())).toEqual([]);
  });

  // 사용자 보고 버그: 진짜 fence 끝에서 `)` 가 타이핑 오버(캐럿만 밖으로)라
  // 여는 괄호와 비대칭이었다. 이제 `(` 처럼 새 fence를 만든다.
  it('진짜 fence에서 ( 와 ) 는 거울상 — 타이핑 오버가 아니다', async () => {
    const closing = await createField(String.raw`\left(x\right)`);
    cleanups.push(closing.dispose);
    await closing.settle();
    closing.mf.position = 2; // 본문 끝
    expect(dispatchKeyOp(closing.mf, ')')).toBe(true);
    await closing.settle();
    expect(closing.value()).toBe(String.raw`\left(\left(x\right)\right)`);
    // 새로 생긴 안쪽 fence의 **왼쪽**이 ghost다.
    expect(ghostFences(closing.mf)[0]).toEqual({ left: '?', right: ')' });

    // 거울상: 같은 자리에서 `(` 는 안쪽 **오른쪽**이 ghost인 같은 모양을 만든다.
    const opening = await createField(String.raw`\left(x\right)`);
    cleanups.push(opening.dispose);
    await opening.settle();
    opening.mf.position = 1; // 본문 시작
    expect(dispatchKeyOp(opening.mf, '(')).toBe(false); // 여는 키는 네이티브 담당
    opening.mf.executeCommand(['typedText', '(', { simulateKeystroke: true }]);
    await opening.settle();
    expect(opening.value()).toBe(closing.value()); // 같은 LaTeX
    expect(ghostFences(opening.mf)[0]).toEqual({ left: '(', right: '?' });
  });

  // 선택 감싸기는 여닫이가 같아야 한다 — 네이티브 `(` 가 선택을 유지하므로 `)` 도.
  it('선택 + ) 는 감싼 뒤에도 선택을 유지한다', async () => {
    const f = await createField('a+b');
    cleanups.push(f.dispose);
    f.mf.selection = { ranges: [[0, 3]], direction: 'forward' };
    await f.settle();
    expect(dispatchKeyOp(f.mf, ')')).toBe(true);
    await f.settle();
    expect(f.value()).toBe(String.raw`\left(a+b\right)`);
    expect(f.mf.selectionIsCollapsed).toBe(false);
    expect(f.mf.getValue(f.mf.selection, 'latex')).toBe('a+b'); // 감싼 본문이 선택된 채
  });

  // ghost는 "편집 중인 셀의 순간 상태" — 포커스가 떠나면 확정된다.
  it('finalizeGhostFences 는 ghost를 전부 확정한다', async () => {
    const f = await createField('a+b');
    cleanups.push(f.dispose);
    f.mf.position = f.mf.lastOffset;
    expect(dispatchKeyOp(f.mf, ')')).toBe(true);
    await f.settle();
    expect(ghostFences(f.mf)).toEqual([{ left: '?', right: ')' }]);

    finalizeGhostFences(f.mf);
    expect(ghostFences(f.mf)).toEqual([{ left: '(', right: ')' }]);
    expect(f.value()).toBe(String.raw`\left(a+b\right)`); // LaTeX은 그대로
  });

  // 사용자 보고 버그: 멀리 있는 ghost까지 뒤로 스캔해 위임하면, 네이티브가 그 ghost를
  // 승격시키며 **사이의 내용을 전부 흡수**한다 (`()?()?()` + `)` → `()?(())`).
  it('비인접 ghost는 승격시키지 않고 전체를 감싼다', async () => {
    const f = await createField('');
    cleanups.push(f.dispose);
    // `()?()?()?` 를 만들고 마지막만 완결해 `()?()?()` 로 둔다.
    for (let i = 0; i < 3; i += 1) {
      f.mf.executeCommand(['typedText', '(', { simulateKeystroke: true }]);
      f.mf.executeCommand('moveToNextChar');
    }
    await f.settle();
    f.mf.executeCommand('moveToPreviousChar');
    f.mf.executeCommand(['typedText', ')', { simulateKeystroke: true }]);
    await f.settle();
    expect(ghostFences(f.mf)).toEqual([
      { left: '(', right: '?' },
      { left: '(', right: '?' },
      { left: '(', right: ')' },
    ]);

    // 사이에 완결된 fence가 끼어 있으므로 위임하지 않는다 — 우리가 전체를 감싼다.
    expect(dispatchKeyOp(f.mf, ')')).toBe(true);
    await f.settle();
    expect(f.value()).toBe(
      String.raw`\left(\left(\right)\left(\right)\left(\right)\right)`,
    );
    // 감싸도 안쪽 ghost 상태가 보존된다 (감싸기는 LaTeX 왕복이라 그냥 두면 확정된다).
    expect(ghostFences(f.mf)).toEqual([
      { left: '(', right: '?' },
      { left: '(', right: '?' },
      { left: '(', right: ')' },
      { left: '?', right: ')' },
    ]);
  });

  it('인접한 ghost는 여전히 네이티브가 승격시킨다 (위임)', async () => {
    const f = await createField('');
    cleanups.push(f.dispose);
    f.mf.executeCommand(['typedText', '(', { simulateKeystroke: true }]);
    f.mf.executeCommand(['typedText', 'x', { simulateKeystroke: true }]);
    await f.settle();
    f.mf.executeCommand('moveToNextChar'); // ghost fence 바로 뒤(바깥)
    expect(dispatchKeyOp(f.mf, ')')).toBe(false);
  });

  // 네 방향 삭제 모두 쌍이 사라지고, 캐럿은 "지운 구분자가 있던 자리"에 남는다.
  it('네 방향 삭제: 쌍이 사라지고 캐럿은 지운 쪽에 남는다', async () => {
    const cases: { caret: number; key: string; pos: number }[] = [
      { caret: 2, key: 'Backspace', pos: 1 }, // 본문 시작 → 여는 쪽 → 내용 맨 앞
      { caret: 1, key: 'Delete', pos: 1 }, //    fence 바로 앞 → 여는 쪽
      { caret: 3, key: 'Delete', pos: 2 }, //    본문 끝 → 닫는 쪽 → 내용 맨 뒤
      { caret: 4, key: 'Backspace', pos: 2 }, // fence 바로 뒤 → 닫는 쪽
    ];
    for (const c of cases) {
      const f = await createField(String.raw`x\left(a\right)y`);
      cleanups.push(f.dispose);
      await f.settle();
      f.mf.position = c.caret;
      expect(dispatchKeyOp(f.mf, c.key), `caret ${c.caret} + ${c.key}`).toBe(true);
      await f.settle();
      expect(f.value(), `caret ${c.caret} + ${c.key}`).toBe('xay');
      expect(f.mf.position, `caret ${c.caret} + ${c.key}`).toBe(c.pos);
    }
  });

  it('괄호를 지워도 안쪽 ghost는 보존된다', async () => {
    const f = await createField('');
    cleanups.push(f.dispose);
    // `((x?)` 모양: 바깥 fence 안에 ghost fence 하나
    for (const ch of ['(', '(', 'x']) {
      f.mf.executeCommand(['typedText', ch, { simulateKeystroke: true }]);
    }
    await f.settle();
    expect(ghostFences(f.mf)).toEqual([
      { left: '(', right: '?' },
      { left: '(', right: '?' },
    ]);
    // 바깥 fence의 여는 쪽을 지운다 (캐럿을 바깥 본문 시작으로)
    f.mf.position = 1;
    expect(dispatchKeyOp(f.mf, 'Backspace')).toBe(true);
    await f.settle();
    expect(ghostFences(f.mf)).toEqual([{ left: '(', right: '?' }]); // 안쪽 ghost 유지
  });

  it('깊은 중첩은 한 번에 한 겹씩만 벗겨진다', async () => {
    const f = await createField(String.raw`\left(\left(\left(\right)\right)\right)`);
    cleanups.push(f.dispose);
    await f.settle();
    f.mf.position = 3; // 가장 안쪽 빈 본문
    expect(dispatchKeyOp(f.mf, 'Backspace')).toBe(true);
    await f.settle();
    expect(f.value()).toBe(String.raw`\left(\left(\right)\right)`);
    expect(f.mf.position).toBe(2); // 남은 안쪽 괄호 안
  });

  // ghost 왼쪽 구분자가 문서·계산으로 새면 안 된다 (CE가 `\left?` 를 못 읽는다).
  it('ghost 왼쪽 구분자는 LaTeX으로 새지 않는다', async () => {
    const f = await createField('a');
    cleanups.push(f.dispose);
    f.mf.position = f.mf.lastOffset;
    for (const key of [')', ']', '}']) {
      const g = await createField('a');
      cleanups.push(g.dispose);
      g.mf.position = g.mf.lastOffset;
      expect(dispatchKeyOp(g.mf, key)).toBe(true);
      await g.settle();
      expect(g.value()).not.toContain('\\left?');
      expect(findViolations(g.value())).toEqual([]);
    }
  });
});
