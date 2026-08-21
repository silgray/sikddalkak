import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { createElement, Fragment } from 'react';
import type { MathfieldElement } from 'mathlive';
import { MathField } from './MathField';
import { KeyPalette, PALETTE_LAYERS, type PaletteKey } from './KeyPalette';

/**
 * `KeyPalette` 종단 검증 — 버튼 클릭이 실제로 `MathField`에 반영되는지.
 * `MathField`와 `KeyPalette`를 **함께** 마운트한다 — 팔레트는 `activeField`
 * (모듈 전역, `editor/activeField.ts`)로 대상을 찾으므로, `MathField`의
 * `focusin` 리스너가 실제로 등록·발화해야 하고 그건 진짜 마운트 없인 안 된다.
 * `mathField.browser.test.tsx`와 같은 마운트 규율.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const settle = () => new Promise((r) => setTimeout(r, 60));

async function mount(): Promise<{ mf: MathfieldElement; root: Root; host: HTMLElement }> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(Fragment, null, createElement(MathField, { value: '' }), createElement(KeyPalette)));
  await new Promise((r) => setTimeout(r, 30));
  const mf = host.querySelector('math-field') as MathfieldElement;
  cleanups.push(() => {
    root.unmount();
    host.remove();
  });
  mf.focus();
  await settle();
  return { mf, root, host };
}

/** 라벨(버튼 텍스트) 또는 title로 팔레트 버튼을 찾아 클릭한다. */
function clickKey(host: HTMLElement, labelOrTitle: string): void {
  const btn = [...host.querySelectorAll<HTMLButtonElement>('.palette-key')].find(
    (b) => b.textContent === labelOrTitle || b.title === labelOrTitle,
  );
  if (btn === undefined) throw new Error(`palette key not found: ${labelOrTitle}`);
  btn.click();
}

function clickTab(host: HTMLElement, label: string): void {
  const btn = [...host.querySelectorAll<HTMLButtonElement>('.palette-tab')].find((b) => b.textContent === label);
  if (btn === undefined) throw new Error(`palette tab not found: ${label}`);
  btn.click();
}

describe('KeyPalette — 버튼 클릭이 activeField에 반영된다', () => {
  it('숫자 레이어: 여러 글자를 이어 눌러도 순서대로 쌓인다', async () => {
    const { mf, host } = await mount();
    for (const ch of ['1', '+', '2']) {
      clickKey(host, ch);
      await settle();
    }
    expect(mf.value).toBe('1+2');
  });

  it('abc 레이어: 여러 글자를 이어 눌러도 순서대로 쌓인다 (숏컷 미완성 접두어)', async () => {
    const { mf, host } = await mount();
    clickTab(host, 'abc');
    await settle();
    for (const ch of ['x', 'y', 'z']) {
      clickKey(host, ch);
      await settle();
    }
    expect(mf.value).toBe('xyz');
  });

  it('sym 레이어: sqrt 키 — 인라인 숏컷이 발동해 \\sqrt가 된다', async () => {
    const { mf, host } = await mount();
    clickTab(host, 'ƒ(x)');
    await settle();
    clickKey(host, '√');
    await settle();
    expect(mf.value).toBe(String.raw`\sqrt{\placeholder{}}`);
  });

  it('sym 레이어: cos 키 — 세 글자가 이어져 \\cos가 된다', async () => {
    const { mf, host } = await mount();
    clickTab(host, 'ƒ(x)');
    await settle();
    clickKey(host, 'cos');
    await settle();
    expect(mf.value).toBe(String.raw`\cos`);
  });

  it('nav 줄: backspace가 직전 글자를 지운다', async () => {
    const { mf, host } = await mount();
    for (const ch of ['1', '2']) {
      clickKey(host, ch);
      await settle();
    }
    expect(mf.value).toBe('12');
    clickKey(host, 'backspace');
    await settle();
    expect(mf.value).toBe('1');
  });

  it('nav 줄은 레이어를 바꿔도 항상 같은 자리에 있다', async () => {
    const { mf, host } = await mount();
    clickTab(host, 'abc');
    await settle();
    clickKey(host, 'a');
    await settle();
    clickKey(host, 'backspace');
    await settle();
    expect(mf.value).toBe('');
  });

  it('abc 레이어: ⇧ 를 누르면 대문자가 나오고, 한 글자 쓰면 풀린다', async () => {
    const { mf, host } = await mount();
    clickTab(host, 'abc');
    await settle();
    clickKey(host, 'shift (uppercase)');
    await settle();
    clickKey(host, 'A'); // ⇧ 가 켜져 라벨도 대문자다
    await settle();
    expect(mf.value).toBe('A');
    clickKey(host, 'b'); // one-shot 이라 이미 풀렸다
    await settle();
    expect(mf.value).toBe('Ab');
  });

  it('숫자 레이어의 = 는 평가가 아니라 문자 입력이다', async () => {
    const { mf, host } = await mount();
    for (const ch of ['1', '=']) {
      clickKey(host, ch);
      await settle();
    }
    expect(mf.value).toBe('1=');
  });

  it('행렬 키는 2×2 를 넣는다 (키 입력 경로가 없는 유일한 예외)', async () => {
    const { mf, host } = await mount();
    clickKey(host, 'matrix (2×2)');
    await settle();
    expect(mf.value).toContain('pmatrix');
  });
});

/**
 * **인라인 숏컷 의존 키의 자동 검증 — 하드코딩 방지 장치.**
 *
 * 팔레트는 LaTeX을 안 적고 트리거 글자(`sqrt`, `cos`…)만 흘린다. 그래서 변환 결과가
 * 바뀌면 자동 반영되지만, **트리거 이름 자체는 이 파일 밖(`MathField.tsx`의
 * `DISABLED_INLINE_SHORTCUTS`/`CUSTOM_INLINE_SHORTCUTS`)에서 사라질 수 있다.**
 * 그러면 팔레트는 조용히 리터럴(`cos`)을 입력하게 된다.
 *
 * 여기서 **여러 글자짜리 알파벳 트리거를 가진 키를 전부 자동으로 찾아** 실제로 눌러보고,
 * 결과가 리터럴 그대로면 실패시킨다. 팔레트에 키를 추가해도 목록을 따로 관리할 필요가
 * 없고, 숏컷을 끄면 여기서 바로 잡힌다.
 */
describe('KeyPalette — 인라인 숏컷 의존 키가 실제로 변환된다', () => {
  /** 알파벳 여러 글자를 흘리는 키 = 인라인 숏컷에 기대는 키. */
  const dependsOnShortcut = (k: PaletteKey): boolean =>
    k.strokes !== undefined &&
    k.strokes.length > 1 &&
    k.strokes.every((s) => /^[a-zA-Z]$/.test(s.key));

  const keysOf = (layer: (typeof PALETTE_LAYERS)[number]): PaletteKey[] =>
    layer.kind === 'split' ? [...layer.left.flat(), ...layer.right.flat()] : layer.rows.flat();

  const targets = PALETTE_LAYERS.flatMap((layer) =>
    keysOf(layer)
      .filter(dependsOnShortcut)
      .map((k) => ({ layer, k })),
  );

  it('그런 키가 실제로 존재한다 (스위트가 빈 채로 통과하지 않게)', () => {
    expect(targets.length).toBeGreaterThan(5);
  });

  for (const { layer, k } of targets) {
    const trigger = k.strokes!.map((s) => s.key).join('');
    it(`[${layer.label}] "${k.label}" (${trigger}) 가 리터럴로 남지 않는다`, async () => {
      const { mf, host } = await mount();
      clickTab(host, layer.label);
      await settle();
      clickKey(host, k.title ?? k.label);
      await settle();
      // 숏컷이 죽었으면 트리거 글자가 그대로 남는다. 그게 이 테스트가 잡는 것이다.
      expect(mf.value, `"${trigger}" 인라인 숏컷이 사라졌거나 이름이 바뀌었다`).not.toBe(trigger);
      expect(mf.value).not.toBe('');
    });
  }
});
