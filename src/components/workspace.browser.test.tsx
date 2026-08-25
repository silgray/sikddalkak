import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import '../styles.css';
import { Workspace } from './Workspace';

/**
 * `Workspace` 의 서랍(탭 목록) — 항상 마운트돼 있는 `.drawer-panel` 이 닫힌
 * 상태에서 화면에 흔적을 안 남기는지를 잰다.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  localStorage.clear();
});

const settle = () => new Promise((r) => setTimeout(r, 100));

function mount(): { host: HTMLElement; root: Root } {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(Workspace));
  cleanups.push(() => {
    root.unmount();
    host.remove();
  });
  return { host, root };
}

describe('Workspace — 서랍', () => {
  it('닫혀 있으면 그림자를 안 남긴다 (화면 밖으로 translate만 해선 안 지워지는 자리)', async () => {
    // 회귀 핀 — `.drawer-panel` 은 열림 여부와 무관하게 늘 DOM에 있다(대원칙 3).
    // `translateX(-100%)` 로 화면 밖에 두는 것만으로는 부족하다: box-shadow는
    // offset+blur(12px+34px=46px)만큼 자기 오른쪽 가장자리(닫힌 패널의 오른쪽
    // 끝은 정확히 뷰포트 왼쪽 끝과 겹친다) 너머로 번져서, 카드 사이 빈 틈까지
    // 이어지는 세로줄로 늘 보였다(사용자가 스크린샷으로 두 번 신고 — 처음엔
    // `.cell-group` 쪽을 의심했는데, 카드 틈에도 안 끊기는 게 실마리였다).
    // box-shadow는 `.drawer-open .drawer-panel` 에서만 걸어야 한다.
    const { host } = await mount();
    await settle();
    const panel = host.querySelector('.drawer-panel') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(getComputedStyle(panel).boxShadow).toBe('none');
  });

  it('열면 그림자가 뜨고, 패널 오른쪽 끝이 화면 안으로 들어온다', async () => {
    const { host } = await mount();
    await settle();
    const toggle = host.querySelector('.drawer-toggle') as HTMLButtonElement;
    toggle.click();
    await settle();
    const panel = host.querySelector('.drawer-panel') as HTMLElement;
    expect(getComputedStyle(panel).boxShadow).not.toBe('none');
    expect(panel.getBoundingClientRect().right).toBeGreaterThan(0);
  });
});
