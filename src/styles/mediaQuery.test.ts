import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOBILE_QUERY } from '../mobile';

/**
 * 모바일 CSS 분할(`CLAUDE.md` §모바일 대원칙 1)의 세 불변식을 못박는다.
 *
 * 파일마다 자기 `@media (max-width: 640px)` 블록을 갖게 되면서 그 임계값
 * 문자열이 여러 벌로 는다 — 여기서 `src/mobile.ts` 의 `MOBILE_QUERY` 하나와
 * 계속 대조해, 규율이 아니라 테스트가 어긋남을 잡게 한다.
 */

const STYLES_DIR = dirname(fileURLToPath(import.meta.url));
const BARREL_PATH = join(STYLES_DIR, '..', 'styles.css');

const cssFiles = readdirSync(STYLES_DIR).filter((f) => f.endsWith('.css'));

describe('CSS 파일의 @media 임계값이 MOBILE_QUERY 와 어긋나지 않는다', () => {
  it.each(cssFiles)('%s', (file) => {
    const content = readFileSync(join(STYLES_DIR, file), 'utf8');
    const matches = [...content.matchAll(/@media\s*([^{]+?)\s*\{/g)].map((m) => m[1].trim());
    for (const query of matches) {
      expect(
        query === MOBILE_QUERY || query === '(prefers-color-scheme: dark)',
        `${file} 의 @media ${query} 가 MOBILE_QUERY(${MOBILE_QUERY}) 도 다크모드 쿼리도 아니다`,
      ).toBe(true);
    }
  });
});

describe('src/styles.css 는 @import 만 있는 얇은 입구다', () => {
  it('주석을 뺀 내용이 전부 @import 문이다', () => {
    const raw = readFileSync(BARREL_PATH, 'utf8');
    const withoutComments = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    const lines = withoutComments
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    for (const line of lines) {
      expect(line, `styles.css 에 @import 가 아닌 줄이 있다: "${line}"`).toMatch(
        /^@import\s+'\.\/styles\/[\w.-]+\.css';$/,
      );
    }
  });

  it('src/styles/ 의 모든 CSS 파일이 정확히 한 번씩 import 된다', () => {
    const raw = readFileSync(BARREL_PATH, 'utf8');
    for (const file of cssFiles) {
      // mediaQuery.test.ts 자기 자신은 CSS가 아니라 여기 목록에 안 들어온다
      // (cssFiles 는 .css 확장자만 걸렀다).
      const pattern = new RegExp(`@import\\s+'\\./styles/${file.replace('.', '\\.')}';`, 'g');
      const count = [...raw.matchAll(pattern)].length;
      expect(count, `${file} 이 styles.css 에서 ${count}번 import 됐다 (정확히 1번이어야 한다)`).toBe(
        1,
      );
    }
    // 반대 방향 — styles.css 가 가리키는 파일 수와 실제 파일 수가 같아야
    // "import는 있는데 파일이 없다" 도 잡는다.
    const importedNames = [...raw.matchAll(/@import\s+'\.\/styles\/([\w.-]+\.css)';/g)].map(
      (m) => m[1],
    );
    expect(new Set(importedNames).size).toBe(importedNames.length); // 중복 import 없음
    expect(importedNames.sort()).toEqual([...cssFiles].sort());
  });
});
