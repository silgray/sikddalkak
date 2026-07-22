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
   * 결과가 편집돼 독립 식으로 분리됐는지. true면 이 식의 `=` 결과를 표시하지
   * 않는다(결과가 별개 오브젝트로 이전됐으므로). `latex`가 바뀌면 false로 리셋 —
   * 재평가된 새 결과는 다시 보여준다.
   */
  resultDetached: boolean;
};

export type EvalResult =
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  /**
   * 관계식(`1=1`, `x+1=1+x`, `2<1`)의 참/거짓 판정.
   * 수식이 아니라 판정이므로 MathLive가 아니라 일반 텍스트로 렌더한다.
   */
  | { kind: 'boolean'; value: boolean }
  | {
      kind: 'ok';
      /** 표시용 LaTeX */
      latex: string;
      /** 정본 — MathJSON */
      json: unknown;
      /** 정의 오브젝트면 정의된 변수 이름, 아니면 null */
      definitionName: string | null;
    };
