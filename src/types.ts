/** 셀이 위쪽 정의 셀의 변수를 치환할지 여부. */
export type CellMode = 'symbolic' | 'scoped';

/**
 * 사용자 입력의 정본. 직렬화 대상은 이것뿐이고,
 * 계산 결과(EvalResult)는 상태에 저장하지 않고 셀 배열에서 파생시킨다.
 */
export type Cell = {
  id: string;
  /** LaTeX — mathfield가 들고 있는 것과 같은 문자열 */
  input: string;
  mode: CellMode;
  /** = 를 눌러 확정했는지. 미확정 셀은 결과를 표시하지 않는다. */
  committed: boolean;
};

export type EvalResult =
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ok';
      /** 표시용 LaTeX */
      latex: string;
      /** 정본 — MathJSON */
      json: unknown;
      /** 정의 셀이면 정의된 변수 이름, 아니면 null */
      definitionName: string | null;
    };
