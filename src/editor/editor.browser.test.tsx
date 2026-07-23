import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import type { MathfieldElement } from 'mathlive';
import { createField } from './harness';
import { MathField } from '../components/MathField';
import { ce } from '../engine/ce';

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
  it('괄호 한쪽을 지우면 문서·필드 모두 즉시 평평한 형태로 교정된다', async () => {
    const { mf, edits } = await mountMathField(String.raw`\left(a+b\right)`);
    mf.position = mf.lastOffset;
    mf.executeCommand('deleteBackward');
    await settle();
    expect(mf.value).toBe('(a+b'); // 필드 되써넣기
    expect(edits.at(-1)?.latex).toBe('(a+b'); // 문서 보고도 교정본
    expect(mf.value).not.toContain(String.raw`\right.`);
    expect(mf.position).toBe(mf.lastOffset); // 캐럿은 끝 유지 (survivor left)
  });

  it('사용자 재현: (sinx+cosx) 뒤 빈 쌍 삭제 후에도 계산 가능한 문서가 유지된다', async () => {
    const base = String.raw`\left(\sin\left(x\right)+\cos\left(x\right)\right)`;
    const { mf, edits } = await mountMathField(base);
    mf.position = mf.lastOffset;
    mf.executeCommand(['typedText', '(', { simulateKeystroke: true }]);
    await settle();
    mf.position = mf.lastOffset; // 쌍 밖으로
    mf.executeCommand('deleteBackward'); // `)` 삭제 → 고아 fence
    await settle();
    const doc = edits.at(-1)?.latex ?? '';
    expect(doc).toBe(`${base}(`); // 평평한 ( 만 남는다
    expect(doc).not.toContain(String.raw`\right.`);
    // 미완성(미결 괄호)이라 파싱이 유효하지 않은 건 정상. 오염 형태가 아닐 뿐.
    // 이어서 ) 를 실제 keydown으로 치면 인터셉터가 쌍을 완성한다.
    mf.dispatchEvent(
      new KeyboardEvent('keydown', { key: ')', bubbles: true, cancelable: true }),
    );
    await settle();
    const healed = edits.at(-1)?.latex ?? '';
    expect(healed).toBe(`${base}\\left(\\right)`);
    expect(ce.parse(healed).isValid).toBe(true);
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
