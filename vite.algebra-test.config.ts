import { defineConfig } from 'vite';

/**
 * `src/algebra/test/test.ts` 디버깅용 최소 뷰어 설정.
 *
 * 주 앱 빌드(`vite.config.ts`)와 완전히 분리돼 있다. React 없이 순수 DOM +
 * mathlive만 쓴다. 배포되지 않는다 — 로컬 확인 전용.
 */
export default defineConfig({
  root: 'src/algebra/test',
  server: { port: 5175 },
  // MathLive 폰트는 저장소 루트의 public/ 에 복사된다 (scripts/copy-mathlive-assets.mjs).
  publicDir: '../../../public',
});
