import { ComputeEngine, getDefaultEngine } from '@cortex-js/compute-engine';
import type { TimeLimitedEngine } from './budget';

/**
 * CE 인스턴스를 얻는 **유일한 창구**.
 *
 * **인스턴스를 만드는 곳은 여기뿐이다.** `new ComputeEngine()` 이 이 파일 밖에 있으면
 * 안 된다 — 그래야 버전을 올리거나 엔진 설정을 바꿀 때 볼 곳이 하나가 된다.
 *
 * `@cortex-js/compute-engine` 자체를 import 하는 곳은 둘 더 있는데, 둘 다 의도된 예외다:
 * - **타입만** 가져다 쓰는 곳 (`MathJsonExpression` — `literal/ceJson.ts` 등). 런타임
 *   의존이 아니다.
 * - `transform/delegate.ts` 가 자유 함수 `expand`/`factor`/`simplify` 를 직접 부른다.
 *   0.90에서 이것들은 Expression의 메서드가 아니라 자유 함수라 인스턴스를 안 거친다.
 *   대신 **어느 엔진에서 도는지**(= 어디에 상한을 걸어야 하는지)는 아래 `getDefaultCeEngine`
 *   이 안다.
 *
 * 이 파일이 담는 건 **CE와 말 섞는 공통 규약**뿐이다. 실제로 CE에 뭘 시키는 코드
 * (분수 산술·정리·미적분·역행렬)는 각자 자기 도메인에 남는다 — 자기 타입의 MathJSON
 * 코덱도 마찬가지다 (`literal/ceJson.ts`, `transform/matrixFold.ts`).
 *
 * ⚠ **버전 격리 규칙**: mathlive 는 내부에 CE 0.58을 따로 물고 있다. 우리 0.90과
 * 섞이면 안 되므로 `MathfieldElement.computeEngine` 을 설정하지 않고
 * `mf.getValue('math-json')` 도 쓰지 않는다. MathLive↔CE 경계는 오직 LaTeX 문자열만
 * 건넌다 (`src/main.tsx`, `src/editor/harness.ts` 참고).
 *
 * **왜 모듈마다 인스턴스를 따로 두나.** 지금은 각 호출부가 `createEngine()` 으로 자기
 * 것을 하나씩 갖는다 — 원래부터 그랬고(`render.ts`/`ce/symbolName.ts`/`matrixFold.ts` 가
 * 각자 갖고 있었다) 모듈이 서로를 몰라도 자립하게 하려는 것이다. 우리 모듈 중 엔진에
 * 심볼을 `declare` 하는 곳은 없으므로 하나로 합쳐도 기능상 문제는 없지만, 공유 상태가
 * 생기는 변경이라 별도로 다룬다. 합치기로 하면 **이 파일만** 고치면 된다.
 */

/** 이 모듈 전용 CE 인스턴스를 하나 만든다. */
export function createEngine(): ComputeEngine {
  return new ComputeEngine();
}

/**
 * 라이브러리의 **기본 엔진**. 0.90에서 `expand`/`factor`/`simplify` 는 Expression의
 * 메서드가 아니라 자유 함수이고(`.d.ts` 확인), 그 함수들은 우리가 만든 인스턴스가 아니라
 * 이 기본 엔진에서 돈다 — 그래서 시간 상한도 **여기에** 걸어야 한다
 * (`transform/delegate.ts` 의 `viaCe` 가 유일한 사용처).
 *
 * `TimeLimitedEngine` 으로 좁혀서 돌려준다: 0.90의 `IComputeEngine` 타입에는
 * `withTimeLimit` 이 선언돼 있지 않은데 실체에는 있다(실측). 그 캐스팅을 호출부에
 * 흩지 않고 여기 한 번만 둔다.
 */
export function getDefaultCeEngine(): TimeLimitedEngine {
  return getDefaultEngine() as unknown as TimeLimitedEngine;
}
