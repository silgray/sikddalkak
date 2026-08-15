import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MathfieldElement } from 'mathlive';
import '../styles.css';
import { FieldClip } from './FieldClip';
import { MathField } from './MathField';

/**
 * `FieldClip` 의 넘침 판정 — **실제 렌더 폭**으로 도는지 확인한다.
 *
 * 이 스위트가 존재하는 이유: 예전 구현은 latex **글자 수 > 50** 으로 어림했고,
 * `\begin{pmatrix}…\end{pmatrix}^{-1}`(54자)처럼 구조 문자만 많은 짧은 식이 전부
 * 넘침으로 잡혀 말줄임표가 튀어나왔다(사용자 보고). 그 회귀를 여기 핀으로 박는다.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const settle = () => new Promise((r) => setTimeout(r, 80));

type Mounted = { mf: MathfieldElement; clip: HTMLElement; root: Root };

/** 폭을 못 박은 셀 안에 `FieldClip`+`MathField` 를 띄운다. */
async function mount(initial: string, width = 320): Promise<Mounted> {
  const host = document.createElement('div');
  // `.cell-input` 과 같은 모양 — flex 안에서 남는 폭을 다 쓰는 자리.
  host.style.width = `${width}px`;
  host.style.display = 'flex';
  document.body.append(host);
  const root = createRoot(host);
  root.render(
    createElement(FieldClip, { watch: initial }, createElement(MathField, { value: initial })),
  );
  await settle();
  const mf = host.querySelector('math-field') as MathfieldElement;
  const clip = host.querySelector('.field-clip') as HTMLElement;
  cleanups.push(() => {
    root.unmount();
    host.remove();
  });
  return { mf, clip, root };
}

/** 320px 셀에는 확실히 안 들어가는 식. */
const LONG = String.raw`x^{10}+9x^{9}+8x^{8}+7x^{7}+6x^{6}+5x^{5}+4x^{4}+3x^{3}+2x^{2}+x+123456`;

const marks = (clip: HTMLElement) => ({
  left: clip.classList.contains('field-clip-more-left'),
  right: clip.classList.contains('field-clip-more-right'),
});

describe('FieldClip — 가려진 쪽에만 말줄임표', () => {
  it('짧은 식에는 표식이 없다', async () => {
    const { clip } = await mount('x+1');
    expect(marks(clip)).toEqual({ left: false, right: false });
  });

  it('회귀: 글자 수는 많지만 화면엔 짧은 행렬 식에도 표식이 없다', async () => {
    // 54자 — 옛 임계값(50)을 넘겨 말줄임표가 뜨던 바로 그 식이다.
    const latex = String.raw`\begin{pmatrix}1+i & 1-i\\ 2i & -2i\end{pmatrix}^{-1}`;
    expect(latex.length).toBeGreaterThan(50);
    const { clip } = await mount(latex);
    expect(marks(clip)).toEqual({ left: false, right: false });
  });

  it('진짜로 넘치면 뒤가 잘려 오른쪽에 표식이 뜬다', async () => {
    const { clip } = await mount(LONG);
    await settle();
    // 아직 스크롤 전 — 앞부분이 보이고 뒤가 잘려 있다.
    expect(marks(clip)).toEqual({ left: false, right: true });
  });

  it('캐럿을 옮기면 보이는 창이 따라 움직이고 표식도 뒤집힌다', async () => {
    const { mf, clip } = await mount(LONG);
    await settle();
    // MathLive는 포커스·캐럿 이동마다 `.ML__content` 를 캐럿 쪽으로 스크롤한다
    // (`Mathfield.scrollIntoView`). 포커스는 캐럿을 끝에 놓으므로 앞이 잘린다.
    mf.focus();
    await settle();
    expect(marks(clip)).toEqual({ left: true, right: false });

    // ⚠ `mf.position = 0` 은 스크롤을 안 옮긴다(실측) — 캐럿만 바꾼다. 실제 키 입력이
    // 부르는 편집 명령을 써야 `scrollIntoView` 까지 탄다.
    mf.executeCommand('moveToMathfieldStart');
    await settle();
    expect(marks(clip)).toEqual({ left: false, right: true });
  });
});
