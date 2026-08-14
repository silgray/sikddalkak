import { afterEach, describe, expect, it } from 'vitest';
import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import type { MathfieldElement } from 'mathlive';
import { FieldClip } from './FieldClip';
import { MathField } from './MathField';

/**
 * `FieldClip` 이 실제로 넘친 식을 잘라 보여주고(펼치기 버튼 등장), 펼치면 스크롤이
 * 허용되는지. 넘침 판정은 latex 길이 어림(`FieldClip.tsx` 문서 참고) — 정확한 렌더
 * 폭이 아니라 그 임계값(현재 50자) 언저리를 실제 MathLive 필드로 확인한다.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const settle = () => new Promise((r) => setTimeout(r, 60));

async function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  let latex = '';
  const root = createRoot(host);
  const render = () => {
    root.render(
      createElement(FieldClip, {
        watch: latex,
        children: createElement(MathField, {
          value: latex,
          onEdit: (v: string) => {
            latex = v;
            render();
          },
        }),
      }),
    );
  };
  render();
  await new Promise((r) => setTimeout(r, 30));
  const mf = host.querySelector('math-field') as MathfieldElement;
  mf.focus();
  await settle();
  cleanups.push(() => {
    root.unmount();
    host.remove();
  });
  return {
    host,
    mf,
    async type(text: string) {
      for (const ch of text) {
        mf.executeCommand(['typedText', ch, { simulateKeystroke: true }]);
      }
      await settle();
      await settle();
    },
  };
}

describe('FieldClip — 긴 식 축약', () => {
  it('짧은 식은 안 잘린다 (펼치기 버튼 없음)', async () => {
    const { host, type } = await mount();
    await type('x+1');
    expect(host.querySelector('.field-expand-btn')).toBeNull();
    expect(host.querySelector('.field-clip-clipped')).toBeNull();
  });

  it('임계값을 넘는 긴 식은 잘리고 펼치기 버튼이 뜬다', async () => {
    const { host, type } = await mount();
    // 51자 이상 — FieldClip의 CLIP_THRESHOLD(50)를 넘긴다.
    await type('x^{1}+x^{2}+x^{3}+x^{4}+x^{5}+x^{6}+x^{7}+x^{8}+x9');
    expect(host.querySelector('.field-clip-clipped')).not.toBeNull();
    expect(host.querySelector('.field-expand-btn')).not.toBeNull();
  });

  it('펼치기 버튼을 누르면 가로 스크롤이 허용되고 잘림 표시가 없어진다', async () => {
    const { host, type } = await mount();
    await type('x^{1}+x^{2}+x^{3}+x^{4}+x^{5}+x^{6}+x^{7}+x^{8}+x9');
    const btn = host.querySelector('.field-expand-btn') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.click();
    await settle();
    expect(host.querySelector('.field-clip-expanded')).not.toBeNull();
    expect(host.querySelector('.field-clip-clipped')).toBeNull();
    // 버튼은 넘침 상태에서는 계속 남아 — 다시 눌러 접을 수 있다.
    expect(host.querySelector('.field-expand-btn')).not.toBeNull();
  });
});
