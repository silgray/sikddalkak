import { afterEach, describe, expect, it } from 'vitest';
import type { MathfieldElement } from 'mathlive';
import { createField, pressKey } from './harness';
import { configureKeybindings, CUSTOM_KEYBINDINGS } from './keybindings';

/**
 * Alt+- → `\overline{...}` 커스텀 키바인딩 (`keybindings.ts` 의 `CUSTOM_KEYBINDINGS`).
 *
 * **실제 키 입력 경로로 검증한다** — `executeCommand` 를 직접 부르면 키바인딩 표를
 * 안 거쳐서 "바인딩이 실제로 먹는가" 를 못 본다(MathLive는 모호한 바인딩을 조용히
 * 버린다, `keybindings.ts` 서두 경고).
 *
 * ⚠ **키 이벤트는 호스트(`math-field`)가 아니라 셰도우 DOM 안의 `.ML__keyboard-sink`
 * 로 보내야 한다**(실측) — MathLive가 거기서 듣는다. 호스트에 쏘면 아무 일도 안 난다.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** 실제 Alt+- 키 입력. MathLive의 키바인딩 디스패치를 그대로 탄다. */
function pressAltMinus(mf: MathfieldElement): void {
  pressKey(mf, { key: '-', code: 'Minus', altKey: true });
}

async function field(initial: string) {
  const f = await createField(initial);
  cleanups.push(f.dispose);
  configureKeybindings(f.mf);
  return f;
}

describe('Alt+- 오버라인 키바인딩', () => {
  it('레지스트리에 있고 insert 명령으로 `#@` 를 쓴다', () => {
    const overline = CUSTOM_KEYBINDINGS.find((kb) => kb.key === 'alt+-');
    expect(overline).toBeDefined();
    expect(overline?.command).toEqual(['insert', '\\overline{#@}']);
  });

  it('선택이 있으면 그 범위를 감싼다', async () => {
    const f = await field('x+y');
    f.mf.selection = { ranges: [[0, 3]], direction: 'forward' };
    await f.settle();
    pressAltMinus(f.mf);
    await f.settle();
    expect(f.value()).toBe(String.raw`\overline{x+y}`);
  });

  it('선택이 없으면 캐럿 앞 항목을 감싼다 (`#@` 의 기본 동작)', async () => {
    const f = await field('x');
    f.mf.position = f.mf.lastOffset;
    await f.settle();
    pressAltMinus(f.mf);
    await f.settle();
    expect(f.value()).toBe(String.raw`\overline{x}`);
  });

  it('빈 필드면 채울 자리를 남긴다', async () => {
    const f = await field('');
    pressAltMinus(f.mf);
    await f.settle();
    expect(f.value()).toBe(String.raw`\overline{\placeholder{}}`);
  });
});
