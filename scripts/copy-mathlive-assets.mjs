// MathLive는 폰트를 런타임에 fetch한다. Vite가 서빙할 수 있도록
// node_modules에서 public/ 으로 복사한다. dev/build 전에 자동 실행된다.
import { cpSync, existsSync } from 'node:fs';

const src = 'node_modules/mathlive/fonts';
const dest = 'public/mathlive/fonts';

if (!existsSync(src)) {
  console.error(`[copy-mathlive-assets] ${src} 가 없습니다. npm install 을 먼저 실행하세요.`);
  process.exit(1);
}

cpSync(src, dest, { recursive: true });
console.log(`[copy-mathlive-assets] ${src} -> ${dest}`);
