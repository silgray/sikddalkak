import { scanLatex } from './editor/latexScan';

/**
 * 최상위 `=` 가 있는데 정의(변수·함수)가 아니면 등식이다 (`2x+1=7`, `x^2=4`).
 *
 * `cellEnv.ts` 의 `splitDefinition`/`splitFunctionDefinition` **다음에** 시도해야
 * 한다 — 셋 다 "최상위 `=`" 를 전제하므로, 정의 판정이 둘 다 실패한 뒤에만 등식으로
 * 본다. `cellGraph.ts` 와 `components/Cell.tsx` 가 같이 쓴다 — solve 대상 선택 가능
 * 여부(UI)와 그래프 진입 여부(계산)가 서로 다른 판정을 쓰면 어긋난다.
 *
 * **이 함수만 `cellEnv.ts` 밖으로 뗀 이유**: `scanLatex` 만 쓰고 algebra(=CE)가 전혀
 * 필요 없다. `cellEnv.ts` 의 나머지(`splitDefinition` 등)는 `algebra.parse` 를 쓰므로
 * import하면 CE 전체가 딸려 온다 — `components/Cell.tsx` 는 이 판정 하나만 필요한데
 * `cellEnv` 를 통째로 끌어와 CE(1.9MB)를 메인 스레드 번들에 실은 적이 있다(실측,
 * `src/importGraph.test.ts` 가 그 회귀를 잡는다). `splitRelation` 을 여기 잎 모듈로
 * 두면 `Cell.tsx` 가 algebra를 안 보고 이 판정만 얻는다.
 *
 * ⚠ **이 파일은 잎이다** — import가 `editor/latexScan` 하나를 넘으면 누수가 돌아온
 * 것이다(`algebra/expression/builders.ts` 의 "잎" 규약과 같은 자리).
 */
export function splitRelation(latex: string): { lhs: string; rhs: string } | null {
  const doc = scanLatex(latex);
  const eq = doc.tokens.find((t) => t.kind === 'char' && t.text === '=');
  if (eq === undefined) return null;

  const lhs = latex.slice(0, eq.start).trim();
  const rhs = latex.slice(eq.end).trim();
  if (lhs === '' || rhs === '') return null;
  return { lhs, rhs };
}
