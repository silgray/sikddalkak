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
      // ⚠ `hasTouch` 는 편의가 아니라 **필수**다. 모바일 판정이
      // `(pointer: coarse)`(`src/mobile.ts`)라 이걸 안 켜면 헤드리스 Chromium 은
      // fine 포인터로 떠서 모바일 CSS가 **한 번도 안 켜진다** — 스텁 없이 모바일
      // 규칙에 기대는 테스트(`components/cellGroup.browser.test.tsx`)가 통째로
      // 깨진다. 실측: 켜면 `matchMedia('(pointer: coarse)').matches === true` 이고
      // `@media (pointer: coarse)` 규칙이 실제로 적용된다(`isMobile` 은 안 켠다 —
      // UA·뷰포트까지 건드리는데 판정을 뒤집는 건 `hasTouch` 하나로 충분하다).
      provider: playwright({ contextOptions: { hasTouch: true } }),
      headless: true,
      instances: [{ browser: 'chromium' }],
      // MathLive 폰트/사운드 로딩 실패 노이즈는 하네스에서 끈다.
      screenshotFailures: false,
    },
  },
});
