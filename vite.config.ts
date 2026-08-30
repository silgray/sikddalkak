/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  server: { port: 5173 },
  // GitHub Pages 프로젝트 사이트는 /sikddalkak/ 서브경로에서 서빙된다.
  // dev는 루트 유지 (로컬 개발·launch.json에 영향 없음).
  base: command === 'build' ? '/sikddalkak/' : '/',
  test: {
    // **범위를 `src/` 로 못박는다.** 기본 include(`**/*.test.*`)는 레포 어디든 훑으므로
    // `.claude/worktrees/` 의 워크트리 사본까지 함께 돌아, 그쪽 브라우저 테스트가 jsdom에서
    // `document is not defined` 로 죽는다(실측: 파일 72개·가짜 실패 150건·2배 시간).
    // 차단 목록을 늘리는 대신 포함 범위를 좁히면 워크트리도 `dist` 도 자동으로 빠진다.
    include: ['src/**/*.test.{ts,tsx}'],
    // 브라우저 스위트는 별도 설정으로 (vitest.browser.config.ts, npm run test:browser).
    // `*.browser.test.tsx` 도 위 include에 걸리므로 이 줄은 여전히 필요하다.
    exclude: ['**/node_modules/**', 'src/**/*.browser.test.*'],
    // 벤치도 같은 이유로 범위를 못박는다 — `test.exclude` 는 벤치에 안 물려받아지고
    // (`benchmark` 옵션은 자기만의 include/exclude를 갖는다), 이게 없으면 워크트리
    // 사본의 벤치까지 한 벌 더 돈다(실측: 최상위 `benchmark:` 키로 뒀더니 안 먹혔다 —
    // vitest 옵션은 전부 `test` 블록 아래 있어야 한다).
    benchmark: { include: ['src/**/*.bench.ts'] },
  },
}));
