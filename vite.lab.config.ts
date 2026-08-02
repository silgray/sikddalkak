import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 랩(lab) 앱 전용 설정 — `src/algebra` 를 사람 눈으로 검증하기 위한 도구다.
 *
 * 주 앱 빌드(`vite.config.ts`)와 **완전히 분리**되어 있다. 랩은 배포되지 않고
 * Pages 워크플로도 건드리지 않는다. 랩이 깨져도 제품은 영향받지 않는다.
 */
export default defineConfig({
  root: 'lab',
  plugins: [react()],
  server: { port: 5174 },
  // MathLive 폰트는 저장소 루트의 public/ 에 복사된다 (scripts/copy-mathlive-assets.mjs).
  publicDir: '../public',
  build: { outDir: '../dist-lab', emptyOutDir: true },
});
