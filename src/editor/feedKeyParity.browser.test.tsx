import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import type { MathfieldElement } from 'mathlive';
import { MathField } from '../components/MathField';
import { KeyPalette } from '../components/KeyPalette';
import { feedKey, type KeyStroke } from './feedKey';

/**
 * **물리 키보드 ↔ feedKey 동등성(parity) 검증.**
 *
 * 여기가 `KeyPalette` 설계의 핵심 주장("가상 키보드가 물리 키보드와 같은 경로를 탄다")을
 * 실제로 반증 가능하게 만드는 자리다. `userEvent`(vitest browser mode)는 Playwright
 * CDP로 **진짜 trusted 키 이벤트**를 만든다 — `new KeyboardEvent(...)` 합성으로는
 * 절대 못 만드는 그것이다. 두 경로를 같은 초기 상태에 각각 걸고 결과를 대조한다.
 *
 * 대조 항목은 값만이 아니라 **캐럿·선택까지** 본다 — placeholder를 지나갈 때의
 * 차이가 정확히 거기서 드러나기 때문이다.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const settle = () => new Promise((r) => setTimeout(r, 60));

async function mount(initial: string): Promise<MathfieldElement> {
  const host = document.createElement('div');
  document.body.append(host);
  const root: Root = createRoot(host);
  root.render(createElement(MathField, { value: initial }));
  await new Promise((r) => setTimeout(r, 30));
  const mf = host.querySelector('math-field') as MathfieldElement;
  cleanups.push(() => {
    root.unmount();
    host.remove();
  });
  mf.focus();
  await settle();
  return mf;
}

/** 관찰 가능한 상태 전부 — 값·캐럿·선택 범위. */
function snap(mf: MathfieldElement) {
  return {
    value: mf.value,
    position: mf.position,
    selection: JSON.stringify(mf.selection.ranges),
    collapsed: mf.selectionIsCollapsed,
  };
}

/**
 * 같은 초기 상태에서 같은 키 열을, 한 번은 진짜 키보드로 한 번은 feedKey로 흘리고
 * 매 스텝의 상태를 나란히 돌려준다.
 */
async function bothPaths(initial: string, startPos: number, strokes: KeyStroke[], realKeys: string) {
  const realMf = await mount(initial);
  realMf.position = startPos;
  await settle();
  const real: ReturnType<typeof snap>[] = [];
  for (const k of realKeys.split('|')) {
    await userEvent.keyboard(k);
    await settle();
    real.push(snap(realMf));
  }

  const fedMf = await mount(initial);
  fedMf.position = startPos;
  await settle();
  const fed: ReturnType<typeof snap>[] = [];
  for (const s of strokes) {
    feedKey(fedMf, s);
    await settle();
    fed.push(snap(fedMf));
  }

  return { real, fed };
}

const LEFT: KeyStroke = { key: 'ArrowLeft', code: 'ArrowLeft' };
const RIGHT: KeyStroke = { key: 'ArrowRight', code: 'ArrowRight' };

describe('feedKey parity — placeholder를 화살표로 지나가기', () => {
  it('\\sqrt{\\placeholder{}} 를 오른쪽으로 통과', async () => {
    const { real, fed } = await bothPaths(
      String.raw`\sqrt{\placeholder{}}`,
      0,
      [RIGHT, RIGHT, RIGHT],
      '{ArrowRight}|{ArrowRight}|{ArrowRight}',
    );
    // ⚠ 자기검증: 진짜 키보드가 실제로 캐럿을 움직였는가. 이게 없으면 "둘 다
    // 아무것도 안 했다"도 통과해버려 대조 자체가 무의미해진다.
    expect(real.map((s) => s.position)).not.toEqual([0, 0, 0]);
    expect(fed).toEqual(real);
  });

  it('반증 가능성 확인 — code 없는 화살표는 물리와 갈린다', async () => {
    // `NAV_ROW`가 `code`를 반드시 채워야 하는 이유(KeyPalette.tsx의 ⚠)를 여기서
    // 못박는다. code가 비면 `mightProducePrintableCharacter`가 무조건 true를 내서
    // placeholder가 지워지는 등 물리와 다르게 군다 — 그게 실제로 갈리는지 본다.
    const { real, fed } = await bothPaths(
      String.raw`\sqrt{\placeholder{}}`,
      0,
      [{ key: 'ArrowRight' }, { key: 'ArrowRight' }, { key: 'ArrowRight' }],
      '{ArrowRight}|{ArrowRight}|{ArrowRight}',
    );
    expect(fed).not.toEqual(real);
  });

  it('\\frac{1}{\\placeholder{}} 를 오른쪽으로 통과', async () => {
    const { real, fed } = await bothPaths(
      String.raw`\frac{1}{\placeholder{}}`,
      0,
      [RIGHT, RIGHT, RIGHT, RIGHT],
      '{ArrowRight}|{ArrowRight}|{ArrowRight}|{ArrowRight}',
    );
    expect(fed).toEqual(real);
  });

  it('x^{\\placeholder{}} 를 왼쪽으로 통과 (끝에서 시작)', async () => {
    const mf = await mount(String.raw`x^{\placeholder{}}`);
    const last = mf.lastOffset;
    const { real, fed } = await bothPaths(
      String.raw`x^{\placeholder{}}`,
      last,
      [LEFT, LEFT, LEFT],
      '{ArrowLeft}|{ArrowLeft}|{ArrowLeft}',
    );
    expect(fed).toEqual(real);
  });

  // 위 표 케이스는 내가 고른 몇 자리일 뿐이다 — placeholder 주변 **모든** 시작
  // 오프셋에서 양방향으로 훑어 어디서도 안 갈리는지 본다.
  const SWEEP = [
    String.raw`\sqrt{\placeholder{}}`,
    String.raw`\frac{1}{\placeholder{}}`,
    String.raw`\frac{\placeholder{}}{2}`,
    String.raw`x^{\placeholder{}}`,
    String.raw`a_{\placeholder{}}+b`,
    String.raw`1+\sqrt{\placeholder{}}+2`,
  ];

  for (const latex of SWEEP) {
    for (const dir of ['ArrowRight', 'ArrowLeft'] as const) {
      it(`스윕: ${latex} 를 ${dir} 로, 모든 시작 오프셋에서`, async () => {
        const probe = await mount(latex);
        const last = probe.lastOffset;
        const stroke: KeyStroke = { key: dir, code: dir };
        for (let start = 0; start <= last; start += 1) {
          const { real, fed } = await bothPaths(
            latex,
            start,
            [stroke, stroke],
            `{${dir}}|{${dir}}`,
          );
          expect(fed, `${latex} @${start} ${dir}`).toEqual(real);
        }
      });
    }
  }

  it('placeholder 위에서 글자를 치면 치환된다 (물리와 같은가)', async () => {
    const { real, fed } = await bothPaths(
      String.raw`\sqrt{\placeholder{}}`,
      0,
      [RIGHT, { key: 'a' }],
      '{ArrowRight}|a',
    );
    expect(fed).toEqual(real);
  });
});

describe('팔레트 버튼 parity — 실제로 눌렀을 때 (feedKey 직접 호출과 다를 수 있다)', () => {
  /** `MathField` + `KeyPalette` 를 함께 마운트한다 — 앱과 같은 배치. */
  async function mountApp(initial: string): Promise<{ mf: MathfieldElement; host: HTMLElement }> {
    const host = document.createElement('div');
    document.body.append(host);
    const root: Root = createRoot(host);
    root.render(
      createElement(
        'div',
        null,
        createElement(MathField, { value: initial }),
        createElement(KeyPalette),
      ),
    );
    await new Promise((r) => setTimeout(r, 30));
    const mf = host.querySelector('math-field') as MathfieldElement;
    cleanups.push(() => {
      root.unmount();
      host.remove();
    });
    mf.focus();
    await settle();
    return { mf, host };
  }

  it('placeholder 위에서 팔레트 →를 누르면 물리 →와 같아야 한다', async () => {
    const latex = String.raw`\sqrt{\placeholder{}}`;

    // 물리 키보드: 오른쪽 두 번
    const { mf: realMf } = await mountApp(latex);
    realMf.position = 0;
    await settle();
    await userEvent.keyboard('{ArrowRight}');
    await settle();
    const realAfter1 = snap(realMf);
    await userEvent.keyboard('{ArrowRight}');
    await settle();
    const realAfter2 = snap(realMf);

    // 팔레트 버튼: 진짜 클릭(trusted pointerdown 포함)으로 오른쪽 두 번
    const { mf: palMf, host } = await mountApp(latex);
    palMf.position = 0;
    await settle();
    const rightBtn = [...host.querySelectorAll<HTMLButtonElement>('.palette-key')].find(
      (b) => b.title === 'move right',
    )!;
    await userEvent.click(rightBtn);
    await settle();
    const palAfter1 = snap(palMf);
    await userEvent.click(rightBtn);
    await settle();
    const palAfter2 = snap(palMf);

    // 첫 →로 캐럿이 placeholder 위에 서면 MathLive가 그걸 **선택**한다
    // (selectionIsCollapsed === false). 자기검증: 그 상태가 실제로 만들어졌는가.
    expect(realAfter1.collapsed, '물리 →가 placeholder를 선택해야 이 테스트가 의미 있다').toBe(false);

    expect(palAfter1, '팔레트 → 1회').toEqual(realAfter1);
    expect(palAfter2, '팔레트 → 2회').toEqual(realAfter2);
  });

  // 위는 →만 봤다. 선택이 살아 있는 상태(placeholder 위)에서 **아무 팔레트 키나**
  // 눌러도 물리와 같아야 한다 — 같은 부류의 버그가 다른 키에 숨어 있지 않은지.
  const AFTER_PLACEHOLDER: { btnTitle: string; realKey: string }[] = [
    { btnTitle: 'move right', realKey: '{ArrowRight}' },
    { btnTitle: 'move left', realKey: '{ArrowLeft}' },
    { btnTitle: 'backspace', realKey: '{Backspace}' },
  ];

  for (const { btnTitle, realKey } of AFTER_PLACEHOLDER) {
    it(`placeholder 선택 상태에서 팔레트 "${btnTitle}" 가 물리 ${realKey} 와 같다`, async () => {
      const latex = String.raw`\sqrt{\placeholder{}}`;

      const { mf: realMf } = await mountApp(latex);
      realMf.position = 0;
      await settle();
      await userEvent.keyboard('{ArrowRight}'); // placeholder 위로 (선택 상태 만들기)
      await settle();
      expect(snap(realMf).collapsed, '전제: placeholder가 선택돼 있어야 한다').toBe(false);
      await userEvent.keyboard(realKey);
      await settle();
      const realAfter = snap(realMf);

      const { mf: palMf, host } = await mountApp(latex);
      palMf.position = 0;
      await settle();
      const btn = (t: string) =>
        [...host.querySelectorAll<HTMLButtonElement>('.palette-key')].find((b) => b.title === t)!;
      await userEvent.click(btn('move right'));
      await settle();
      await userEvent.click(btn(btnTitle));
      await settle();

      expect(snap(palMf)).toEqual(realAfter);
    });
  }

  it('숫자 키도 placeholder 선택 상태에서 물리와 같다 (치환)', async () => {
    const latex = String.raw`\sqrt{\placeholder{}}`;

    const { mf: realMf } = await mountApp(latex);
    realMf.position = 0;
    await settle();
    await userEvent.keyboard('{ArrowRight}');
    await settle();
    await userEvent.keyboard('7');
    await settle();
    const realAfter = snap(realMf);

    const { mf: palMf, host } = await mountApp(latex);
    palMf.position = 0;
    await settle();
    const keys = [...host.querySelectorAll<HTMLButtonElement>('.palette-key')];
    await userEvent.click(keys.find((b) => b.title === 'move right')!);
    await settle();
    await userEvent.click(keys.find((b) => b.textContent === '7')!);
    await settle();

    expect(snap(palMf)).toEqual(realAfter);
  });
});

describe('feedKey parity — 평범한 편집', () => {
  it('일반 문자 입력', async () => {
    const { real, fed } = await bothPaths('', 0, [{ key: 'a' }, { key: 'b' }], 'a|b');
    expect(fed).toEqual(real);
  });

  it('인라인 숏컷 (sqrt)', async () => {
    const { real, fed } = await bothPaths(
      '',
      0,
      [{ key: 's' }, { key: 'q' }, { key: 'r' }, { key: 't' }],
      's|q|r|t',
    );
    expect(fed).toEqual(real);
  });

  it('backspace', async () => {
    const { real, fed } = await bothPaths(
      'abc',
      3,
      [{ key: 'Backspace', code: 'Backspace' }],
      '{Backspace}',
    );
    expect(fed).toEqual(real);
  });
});
