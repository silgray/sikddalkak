/** 오브젝트가 다른 오브젝트의 정의를 치환할지 여부. */
export type CellMode = 'symbolic' | 'scoped';

/**
 * 수식 오브젝트의 정본. 영속 대상이자 엔진이 보는 것은 이것뿐이다.
 *
 * `latex`는 **확정된** 값이다 — 편집 중인 라이브 문자열(draft)은 여기 없다.
 * draft는 mathfield DOM 안에만 있고, 디바운스/blur/Enter 시점에만 이리로
 * flush된다. 그래서 타이핑 중간의 미완성 상태(파싱 에러가 나는)가 평가되지 않는다.
 *
 * 배치 정보(스택 순서, 캔버스 좌표)는 여기 없다. 순서는 배열 위치가 표현하고,
 * 캔버스 좌표는 캔버스 뷰를 만들 때 별도로 붙인다.
 */
export type FormulaObject = {
  /** crypto.randomUUID() — 세션/저장 경계를 넘어 안정적이어야 한다. */
  id: string;
  /** 확정된 LaTeX (평가 대상) */
  latex: string;
  mode: CellMode;
  /**
   * 셀 그룹 식별자. 같은 값을 가진 **인접한** 오브젝트들이 한 그룹이다
   * (`src/cellGroup.ts` 의 `groupsOf`). 그룹은 result 필드 편집(`editResult` 액션)
   * 으로만 생기고 커진다 — `makeObject()` 는 항상 새 uuid를 준다.
   */
  groupId: string;
  /**
   * 이 셀에서 Enter를 쳐 결과를 확정했는지. 그룹 안에 최대 하나만 true다 — 새로
   * Enter를 치면 같은 그룹의 다른 셀은 꺼진다. `latex`가 바뀌면(그 셀이든 같은
   * 그룹의 다른 셀이든) 그룹 전체가 false로 리셋된다.
   */
  entered: boolean;
  /**
   * false면 이 셀을 위상정렬·평가에서 통째로 뺀다 — 정의도 안 되고 결과도 안 나온다
   * (`cellGraph.ts` 의 `evaluateCells` 참고). 지운 게 아니라 잠깐 끈 것이라 `latex`는
   * 그대로 남는다. UI는 셀 전체를 반투명하게 표시해 이 상태를 알린다.
   */
  enabled: boolean;
  /**
   * 이 셀이 등식(`2x+1=7`)일 때, 어느 변수에 대해 풀지. `null`이면 결과가 비어 있다
   * (solve 버튼을 아직 안 눌렀다는 뜻). 등식이 아닌 셀에서는 그냥 무시된다.
   * `latex`를 고쳐도 리셋하지 않는다 — solve 대상을 고른 채로 식을 계속 다듬을 수
   * 있어야 한다(`entered`가 latex 변경에 리셋되는 것과 반대).
   */
  solveFor: string | null;
};

export type EvalResult =
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  /**
   * 계산 중 — 워커(`worker/client.ts`)가 아직 응답하지 않았다. `CellStack.tsx` 가
   * 새 결과를 받기 전까지 **이전 결과**를 그대로 들고 있는 것과는 다르다: 이 상태는
   * 셀이 새로 생겼거나 첫 계산이 아직 안 끝난 경우에만 나온다(이전 값이 없으니 흐릴
   * 것도 없다). `ResultRow` 는 이걸 받으면 조용히 있는다 — 깜빡임 방지.
   */
  | { kind: 'pending' }
  /**
   * 관계식(`1=1`, `x+1=1+x`, `2<1`)의 참/거짓 판정.
   * 수식이 아니라 판정이므로 MathLive가 아니라 일반 텍스트로 렌더한다.
   */
  | { kind: 'boolean'; value: boolean }
  | {
      kind: 'ok';
      /** 표시용 LaTeX */
      latex: string;
      /** 정의 오브젝트면 정의된 변수 이름, 아니면 null */
      definitionName: string | null;
      /**
       * substitute+evaluate가 입력 트리를 구조적으로 하나도 안 바꿨는지
       * (`exprKey` 비교, `cellGraph.ts` 의 `computeNode` 참고). true면 상시 표시에서
       * 숨길 대상이다 — `3`을 쳤을 때 결과 줄이 또 뜨는 걸 막는다.
       */
      unchanged: boolean;
    };
