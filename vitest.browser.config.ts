import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';

/**
 * 실제 MathLive를 구동하는 에디터 회귀 스위트 (헤드리스 Chromium).
 * jsdom으로는 MathLive가 돌지 않아 실브라우저가 필수다.
 * 실행: npm run test:browser
 */
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.browser.test.{ts,tsx}'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
      // MathLive 폰트/사운드 로딩 실패 노이즈는 하네스에서 끈다.
      screenshotFailures: false,
    },
  },
});
