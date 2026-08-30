import { describe, expect, it } from 'vitest';
// `@types/madge` 는 5.x용이라 우리가 쓰는 8.x API(`detectiveOptions.ts.skipAsyncImports` 등)와
// 안 맞을 수 있다(버전 격차 미확인) — 실제로 쓰는 부분만 여기서 최소 선언한다.
import madgeUntyped from 'madge';
const madge = madgeUntyped as (
  path: string,
  opts: {
    tsConfig: string;
    fileExtensions: string[];
    detectiveOptions: Record<string, { skipTypeImports?: boolean; skipAsyncImports?: boolean }>;
  },
) => Promise<{ obj(): Record<string, string[]> }>;

/**
 * `main.tsx`(메인 스레드)에서 **정적 import만** 따라가면 `src/algebra` 에 닿지 않아야
 * 한다는 회귀 가드.
 *
 * 왜 필요한가: CE(`@cortex-js/compute-engine`)는 `src/worker/client.ts` 가 워커로
 * 떼어놓은 무거운 짐이다. 그 파일의 문서가 이미 경고해 뒀듯 — 정적으로 끌어오면
 * `cellGraph`/`cellSelection`(그리고 그 밑의 CE 전체)이 메인 스레드 번들에도 딸려
 * 들어가 워커로 뗀 요점이 반쯤 무색해진다. 실제로 `components/Cell.tsx` 가
 * `cellEnv.ts` 에서 `splitRelation` 하나만 쓰면서 그 파일의 `algebra` import를 통째로
 * 끌고 온 적이 있다(초기 JS gzip 832kB → 308kB, `splitRelation` 을 잎 모듈
 * `cellRelation.ts` 로 뗀 뒤 실측). 이 테스트가 그 회귀를 다시 잡는다.
 *
 * ⚠ **실측 함정 두 가지**:
 * - `skipAsyncImports` 는 `es6` 키가 아니라 **`ts`/`tsx` 키**에 둬야 먹는다(`.ts`/`.tsx`
 *   는 typescript detective를 탄다) — 이게 있어야 `worker/client.ts` 의 폴백 동적
 *   `await import('../cellGraph')` 가 경계로 처리된다.
 * - `skipTypeImports` 가 없으면 타입 전용 import(`import type { Env } from '../algebra'`)
 *   까지 간선으로 세어 이 가드가 항상 빨간불이 된다.
 */
describe('main.tsx 정적 import 그래프', () => {
  it('algebra/ 에 닿지 않는다 (CE는 워커 전용)', async () => {
    const graph = await madge('src/main.tsx', {
      tsConfig: 'tsconfig.json',
      fileExtensions: ['ts', 'tsx'],
      detectiveOptions: {
        ts: { skipTypeImports: true, skipAsyncImports: true },
        tsx: { skipTypeImports: true, skipAsyncImports: true },
      },
    });
    const obj = graph.obj();

    // BFS + 부모 추적 — 실패하면 누수 경로를 그대로 찍어준다.
    const parent = new Map<string, string | null>([['main.tsx', null]]);
    const queue = ['main.tsx'];
    while (queue.length > 0) {
      const node = queue.shift()!;
      for (const child of obj[node] ?? []) {
        if (!parent.has(child)) {
          parent.set(child, node);
          queue.push(child);
        }
      }
    }

    const leaked = [...parent.keys()].find((n) => n.startsWith('algebra/'));
    if (leaked !== undefined) {
      const path: string[] = [];
      let cur: string | null = leaked;
      while (cur !== null) {
        path.unshift(cur);
        cur = parent.get(cur) ?? null;
      }
      expect.fail(`메인 스레드가 algebra/ 에 정적으로 닿는다:\n  ${path.join('\n  -> ')}`);
    }
  });
});
