import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { createElement, Fragment } from 'react';
import type { MathfieldElement } from 'mathlive';
import { MathField } from './MathField';
import { KeyPalette } from './KeyPalette';

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
});
