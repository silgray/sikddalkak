import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { createElement, Fragment } from 'react';
import type { MathfieldElement } from 'mathlive';
import '../styles.css';
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

/** 행렬 크기 창의 `rows`×`cols` 칸. */
function matrixCell(host: HTMLElement, rows: number, cols: number): HTMLButtonElement {
  const cell = [...host.querySelectorAll<HTMLButtonElement>('.matrix-picker-cell')].find(
    (b) => b.title === `${rows} × ${cols}`,
  );
  if (cell === undefined) throw new Error(`matrix cell not found: ${rows}×${cols}`);
  return cell;
}

/** 포인터를 격자의 `rows`×`cols` 칸 한가운데로 보낸다. 칸이 아니라 **격자**가
 *  포인터를 받으므로(암묵적 캡처, `KeyPalette.tsx` 참고) 이벤트도 격자에 쏜다. */
function matrixPointer(host: HTMLElement, type: string, rows: number, cols: number): void {
  const grid = host.querySelector('.matrix-picker-grid');
  if (grid === null) throw new Error('matrix grid not found');
  const box = matrixCell(host, rows, cols).getBoundingClientRect();
  grid.dispatchEvent(
    new PointerEvent(type, {
      pointerId: 7,
      isPrimary: true,
      pointerType: 'touch',
      buttons: type === 'pointerup' ? 0 : 1,
      bubbles: true,
      cancelable: true,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
    }),
  );
}

/** 짚었다 떼기 — 그 크기로 삽입된다. */
function pickMatrixCell(host: HTMLElement, rows: number, cols: number): void {
  matrixPointer(host, 'pointerdown', rows, cols);
  matrixPointer(host, 'pointerup', rows, cols);
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

  it('prime 키는 프라임을 위첨자로 올려 붙인다 (분수 키를 밀어낸 자리)', async () => {
    const { mf, host } = await mount();
    clickKey(host, 'x');
    await settle();
    clickKey(host, 'prime');
    await settle();
    // `'` 한 글자만 흘리는데도 MathLive가 위첨자로 올려 준다(실측) — 그 실측이
    // 깨지면 여기서 잡힌다. 우리 파서도 이 꼴을 안다(`algebra/parse/prime.test.ts`).
    expect(mf.value).toBe(String.raw`x^{\prime}`);
  });

  it('행렬 키를 누르면 크기 고르기 창이 뜬다 (누르기만 해선 아무것도 안 들어간다)', async () => {
    const { mf, host } = await mount();
    expect(host.querySelector('.matrix-picker')).toBeNull();
    clickKey(host, 'matrix (pick size)');
    await settle();
    expect(host.querySelector('.matrix-picker')).not.toBeNull();
    // 막 떴을 땐 기본값(2×2)이 칠해져 있다.
    expect(host.querySelector('.matrix-picker-label')?.textContent).toBe('2 × 2 matrix');
    expect(mf.value).toBe('');
  });

  it('창에서 고른 칸의 크기대로 들어가고 창은 닫힌다', async () => {
    const { mf, host } = await mount();
    clickKey(host, 'matrix (pick size)');
    await settle();
    pickMatrixCell(host, 3, 4);
    await settle();
    expect(host.querySelector('.matrix-picker')).toBeNull();
    // `#?` 로 넣은 placeholder는 되읽으면 `\placeholder{}` 로 나온다(실측) —
    // 정확한 문자열 대신 구조로 잰다. 3행×4열: `\\` 2개(행-1), `&` 9개((열-1)×행).
    expect(mf.value).toContain('pmatrix');
    expect((mf.value.match(/\\\\/g) ?? []).length).toBe(2);
    expect((mf.value.match(/&/g) ?? []).length).toBe(9);
  });

  it('격자 위에서 손가락을 끌면 왼쪽 위부터 거기까지 칠해진다', async () => {
    const { host } = await mount();
    clickKey(host, 'matrix (pick size)');
    await settle();
    matrixPointer(host, 'pointerdown', 1, 1);
    matrixPointer(host, 'pointermove', 2, 3);
    await settle();
    expect(host.querySelector('.matrix-picker-label')?.textContent).toBe('2 × 3 matrix');
    // 칠해진 칸 수 = 2×3.
    expect(host.querySelectorAll('.matrix-picker-cell-on').length).toBe(6);
  });

  it('바깥을 짚으면 아무것도 안 넣고 닫힌다', async () => {
    const { mf, host } = await mount();
    clickKey(host, 'matrix (pick size)');
    await settle();
    const backdrop = host.querySelector('.matrix-picker-backdrop');
    expect(backdrop).not.toBeNull();
    backdrop!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    await settle();
    expect(host.querySelector('.matrix-picker')).toBeNull();
    expect(mf.value).toBe('');
  });
});

/**
 * 실행취소/다시실행은 리듀서로 직접 배선되지 않는다 — `feedKey` 로 Ctrl+Z/Y 를
 * 흘려보내고 `Workspace.tsx` 가 **window capture** 에서 받는다. 그 경로가 실제로
 * 이어지는지 여기서 본다(안 이어지면 버튼이 조용히 아무것도 안 한다).
 */
describe('KeyPalette — 실행취소/다시실행 버튼', () => {
  it('탭 줄 오른쪽에 있고, 레이어를 바꿔도 그대로 있다', async () => {
    const { host } = await mount();
    const inHistory = () =>
      [...host.querySelectorAll<HTMLButtonElement>('.key-palette-history .palette-key')].map(
        (b) => b.title,
      );
    expect(inHistory()).toEqual(['undo (Ctrl+Z)', 'redo (Ctrl+Y)']);
    clickTab(host, 'abc');
    await settle();
    expect(inHistory()).toEqual(['undo (Ctrl+Z)', 'redo (Ctrl+Y)']);
  });

  it('Ctrl+Z 가 window capture 리스너까지 도달한다 (Workspace 배선의 전제)', async () => {
    const { host } = await mount();
    // `Workspace.tsx` 와 같은 자리·같은 조건으로 듣는다. 실제 리듀서 연결은
    // 앱에서만 되지만, **이벤트가 거기까지 가는지**가 이 버튼의 유일한 전제다.
    const seen: string[] = [];
    const onKeyDown = (ev: KeyboardEvent) => {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      const k = ev.key.toLowerCase();
      if (k === 'z' || k === 'y') seen.push(ev.shiftKey ? `shift+${k}` : k);
    };
    window.addEventListener('keydown', onKeyDown, true);
    cleanups.push(() => window.removeEventListener('keydown', onKeyDown, true));

    clickKey(host, 'undo (Ctrl+Z)');
    await settle();
    clickKey(host, 'redo (Ctrl+Y)');
    await settle();

    expect(seen).toEqual(['z', 'y']);
  });

  it('실행취소 키는 수식에 글자를 남기지 않는다', async () => {
    const { mf, host } = await mount();
    clickKey(host, '1');
    await settle();
    clickKey(host, 'undo (Ctrl+Z)');
    await settle();
    // Ctrl 조합이라 `feedKey` 의 문자 삽입 폴백을 안 탄다 — 'z' 가 박히면 안 된다.
    expect(mf.value).not.toContain('z');
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

  const keysOf = (layer: (typeof PALETTE_LAYERS)[number]): PaletteKey[] => {
    if (layer.kind === 'split') {
      return [...layer.left.flat(), ...layer.right.flat(), ...(layer.aside?.flat() ?? [])];
    }
    if (layer.kind === 'sections') return layer.sections.flatMap((s) => s.keys);
    return layer.rows.flat();
  };

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

  /**
   * `upperStrokes` (⇧ 상태에서 대신 흘리는 시퀀스, 그리스 대문자 키)도 같은
   * 위험이 있다 — 위 스위프는 `upper=false` 로만 누르므로 이건 못 잡는다.
   * ⇧ 를 먼저 누른 뒤 같은 방식으로 훑는다.
   */
  const upperTargets = PALETTE_LAYERS.flatMap((layer) =>
    keysOf(layer)
      .filter((k) => k.upperStrokes !== undefined && k.upperStrokes.length > 1)
      .map((k) => ({ layer, k })),
  );

  it('⇧ 상태 전용 트리거(upperStrokes)도 존재한다', () => {
    expect(upperTargets.length).toBeGreaterThan(0);
  });

  for (const { layer, k } of upperTargets) {
    const trigger = k.upperStrokes!.map((s) => s.key).join('');
    it(`[${layer.label}] ⇧+"${k.label}" (${trigger}) 가 리터럴로 남지 않는다`, async () => {
      const { mf, host } = await mount();
      clickTab(host, layer.label);
      await settle();
      clickKey(host, 'shift (uppercase)');
      await settle();
      clickKey(host, k.title ?? k.label);
      await settle();
      expect(mf.value, `"${trigger}" 인라인 숏컷이 사라졌거나 이름이 바뀌었다`).not.toBe(trigger);
      expect(mf.value).not.toBe('');
    });
  }
});

describe('KeyPalette — 포커스된 셀이 없으면 접힌다', () => {
  /**
   * 실제 트리와 같은 중첩(`.app` 안에 팔레트)으로 띄운다 — 접힘이 `display` 뿐
   * 아니라 **바닥 여백까지** 풀어주는지 재려는 것이라 `.app` 이 있어야 한다.
   */
  async function mountInApp(): Promise<{
    mf: MathfieldElement;
    palette: HTMLElement;
    app: HTMLElement;
  }> {
    const app = document.createElement('div');
    app.className = 'app';
    document.body.append(app);
    const root = createRoot(app);
    root.render(
      createElement(Fragment, null, createElement(MathField, { value: 'x' }), createElement(KeyPalette)),
    );
    await new Promise((r) => setTimeout(r, 30));
    cleanups.push(() => {
      root.unmount();
      app.remove();
    });
    return {
      mf: app.querySelector('math-field') as MathfieldElement,
      palette: app.querySelector('.key-palette') as HTMLElement,
      app,
    };
  }

  it('아무 셀도 포커스가 없으면 접혀 있다', async () => {
    const { palette } = await mountInApp();
    await settle();
    expect(palette.hasAttribute('hidden')).toBe(true);
  });

  it('셀에 포커스가 들어오면 펴지고, 빠지면 다시 접힌다', async () => {
    const { mf, palette } = await mountInApp();
    mf.focus();
    await settle();
    expect(palette.hasAttribute('hidden')).toBe(false);
    mf.blur();
    await settle();
    expect(palette.hasAttribute('hidden')).toBe(true);
  });

  it('접히면 자리도 안 남는다 — `.app` 바닥 여백이 함께 풀린다', async () => {
    // `display` 만 꺼서는 안 되는 자리다: 바닥 여백이 `--palette-h` 로 팔레트 높이와
    // 묶여 있어(`styles/base.css`) 끄기만 하면 그 높이만큼 빈 자리가 그대로 남는다.
    const { mf, palette, app } = await mountInApp();
    mf.focus();
    await settle();
    expect(getComputedStyle(palette).display).toBe('flex');
    expect(parseFloat(getComputedStyle(app).paddingBottom)).toBeGreaterThan(0);

    mf.blur();
    await settle();
    expect(getComputedStyle(palette).display).toBe('none');
    expect(parseFloat(getComputedStyle(app).paddingBottom)).toBe(0);
  });
});

/**
 * 1번 탭의 ⌫ 는 좌우 블록 밖 좁은 열에 혼자 산다. 그 열은 **키가 하나뿐**이라
 * 자리를 CSS가 정하는데(`justify-content: flex-end`), 그 배선이 끊기면 ⌫ 가
 * 조용히 맨 위로 올라간다 — 예전에 빈 줄을 쌓아 밀던 방식이 딱 그렇게 깨졌다.
 */
/**
 * ƒ(x) 탭은 소제목 달린 구획들이다. 어느 키가 어느 구획에 있는지는 **화면에서
 * 찾는 순서**를 정하므로, 옮긴 자리가 조용히 되돌아가지 않게 못 박는다.
 */
/**
 * ⋆·† 는 위첨자 자리에 쓰는 기호라 트리거 앞에 `^` 를 먼저 흘린다. 그 `^` 가
 * 빠지면 기호만 본문 줄에 박혀 조용히 다른 식이 된다 — 여기서 잡는다.
 */
describe('KeyPalette — ƒ(x) 탭의 ⋆·† 는 위첨자로 올라간다', () => {
  it.each([
    ['star (superscript)', String.raw`A^{\star}`],
    ['dagger (superscript)', String.raw`A^{\dagger}`],
  ])('%s', async (title, expected) => {
    const { mf, host } = await mount();
    clickTab(host, 'abc');
    await settle();
    clickKey(host, 'shift (uppercase)');
    await settle();
    clickKey(host, 'A');
    await settle();
    clickTab(host, 'ƒ(x)');
    await settle();
    clickKey(host, title);
    await settle();
    expect(mf.value).toBe(expected);
  });
});

describe('KeyPalette — ƒ(x) 탭의 overline 은 Matrix & complex 구획에 있다', () => {
  /** 구획 소제목 → 그 안 키들의 title(없으면 라벨). */
  function sectionKeys(host: HTMLElement, heading: string): string[] {
    const section = [...host.querySelectorAll('.key-palette-section')].find(
      (el) => el.querySelector('.key-palette-section-heading')?.textContent === heading,
    );
    if (section === undefined) throw new Error(`section not found: ${heading}`);
    return [...section.querySelectorAll<HTMLButtonElement>('.palette-key')].map(
      (b) => b.title || (b.textContent ?? ''),
    );
  }

  it('Matrix & complex 에 있고 Other 에는 없다', async () => {
    const { host } = await mount();
    clickTab(host, 'ƒ(x)');
    await settle();
    expect(sectionKeys(host, 'Matrix & complex')).toContain('overline');
    expect(sectionKeys(host, 'Other')).not.toContain('overline');
  });
});

describe('KeyPalette — 1번 탭의 ⌫ 는 맨 아랫줄에 선다', () => {
  function keyByTitle(host: HTMLElement, title: string): HTMLButtonElement {
    const btn = [...host.querySelectorAll<HTMLButtonElement>('.palette-key')].find(
      (b) => b.title === title,
    );
    if (btn === undefined) throw new Error(`palette key not found: ${title}`);
    return btn;
  }
  function keyByLabel(host: HTMLElement, label: string): HTMLButtonElement {
    const btn = [...host.querySelectorAll<HTMLButtonElement>('.palette-key')].find(
      (b) => b.textContent === label,
    );
    if (btn === undefined) throw new Error(`palette key not found: ${label}`);
    return btn;
  }

  it('아래끝이 숫자 블록 마지막 줄과 맞고, 높이도 같다', async () => {
    const { host } = await mount();
    const back = keyByTitle(host, 'backspace').getBoundingClientRect();
    const plus = keyByLabel(host, '+').getBoundingClientRect(); // 마지막 줄 오른쪽 끝
    // 소수점 반올림 여지만 둔다(1px).
    expect(Math.abs(back.bottom - plus.bottom), '아래끝이 안 맞는다').toBeLessThan(1);
    expect(Math.abs(back.height - plus.height), '키 높이가 다르다').toBeLessThan(1);
  });

  it('첫 줄보다 아래에 있다 (맨 위로 올라가 있지 않다)', async () => {
    const { host } = await mount();
    const back = keyByTitle(host, 'backspace').getBoundingClientRect();
    const seven = keyByLabel(host, '7').getBoundingClientRect(); // 첫 줄
    expect(back.top).toBeGreaterThan(seven.bottom);
  });
});

describe('KeyPalette — 숫자 키는 톤으로 갈린다 (시안)', () => {
  /** 라벨로 팔레트 키 하나를 집는다. */
  function keyOf(host: HTMLElement, label: string): HTMLButtonElement {
    const btn = [...host.querySelectorAll<HTMLButtonElement>('.palette-key')].find(
      (b) => b.textContent === label,
    );
    if (btn === undefined) throw new Error(`palette key not found: ${label}`);
    return btn;
  }

  it('숫자·백스페이스만 tint 클래스를 단다', async () => {
    const { host } = await mount();
    // 선언 데이터(`PaletteKey.tint`)가 실제 클래스로 나오는지 — 이 둘이 끊기면
    // 톤이 조용히 사라진다.
    for (const label of ['7', '0', '.', '⌫']) {
      expect(keyOf(host, label).classList.contains('palette-key-tint'), label).toBe(true);
    }
    for (const label of ['÷', '×', '+', '=']) {
      expect(keyOf(host, label).classList.contains('palette-key-tint'), label).toBe(false);
    }
  });

  it('그 클래스가 실제로 다른 배경을 만든다 (CSS까지 이어져 있다)', async () => {
    // 클래스만 붙고 CSS가 없으면 위 테스트는 통과해도 화면은 그대로다 —
    // 계산된 값으로 한 번 더 잰다. 정확한 색이 아니라 **갈렸다**는 것만 본다
    // (라이트/다크 어느 쪽이든 성립해야 하므로).
    const { host } = await mount();
    const tinted = getComputedStyle(keyOf(host, '7')).backgroundColor;
    const plain = getComputedStyle(keyOf(host, '÷')).backgroundColor;
    expect(tinted).not.toBe(plain);
  });
});
