import { deferEngine } from './engine';

/**
 * 심볼 이름 → LaTeX. **CE를 사전으로만 쓰는 자리다.**
 *
 * `Pi` → `\pi`, `A_bold` → `\mathbf{A}` 같은 이름 사전은 CE가 정확히 갖고 있고 우리가
 * 다시 만들 이유가 없다. 반대로 **구조 렌더는 절대 CE에 맡기지 않는다** — CE는
 * `["Power","A",-1]` 을 `\frac{1}{A}` 로 되돌려 역행렬을 행렬 나눗셈으로 바꿔버린다(실측).
 * `render.ts` 가 CE에 넘기는 건 잎 심볼 이름뿐이고, 그 한 줄이 이 파일이다.
 *
 * 실패하면 이름을 그대로 쓴다 — 렌더가 죽는 것보다 낫다.
 */

const ce = deferEngine();

const cache = new Map<string, string>();
cache.set('ExponentialE', 'e'); // 초기 캐시, ce가 \exponentialE -> \mathrm{e}로 렌더해서 아예 직접 지정

export function symbolToLatex(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  let latex = name;
  try {
    const boxed = ce().box(name, { canonical: false }).latex;
    if (typeof boxed === 'string' && boxed.length > 0) latex = boxed;
  } catch {
    // 이름을 그대로 쓴다 — 렌더가 죽는 것보다 낫다.
  }
  cache.set(name, latex);
  return latex;
}
