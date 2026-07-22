import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  server: { port: 5173 },
  // GitHub Pages 프로젝트 사이트는 /sikddalkak/ 서브경로에서 서빙된다.
  // dev는 루트 유지 (로컬 개발·launch.json에 영향 없음).
  base: command === 'build' ? '/sikddalkak/' : '/',
}));
