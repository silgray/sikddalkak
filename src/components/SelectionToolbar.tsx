/**
 * 선택 위 플로팅 툴바. 1차: 선택이 행렬 하나로 떨어질 때 구분 기호 변경.
 * (☰ 메뉴의 environment-* 서브메뉴를 이곳으로 이전 — 메뉴에서는 제거됨)
 *
 * 적용은 기존 replaceSelection + commitInput 경로를 타므로 실행취소 한 단위 +
 * 선택 복구가 그대로 동작한다.
 */

const MATRIX_ENVS = ['matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix'] as const;
type MatrixEnv = (typeof MATRIX_ENVS)[number];

/** ☰ 메뉴와 같은 5종 (+ Vmatrix는 파서 호환 위해 인식만). */
const DELIMITER_OPTIONS: { env: MatrixEnv; label: string; title: string }[] = [
  { env: 'pmatrix', label: '(⋱)', title: 'Parentheses' },
  { env: 'bmatrix', label: '[⋱]', title: 'Brackets' },
  { env: 'Bmatrix', label: '{⋱}', title: 'Braces' },
  { env: 'vmatrix', label: '|⋱|', title: 'Bars' },
  { env: 'matrix', label: '⋱', title: 'No delimiter' },
];

const ENV_RE = /^\\begin\{(matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix)\}([\s\S]*)\\end\{\1\}$/;

/** 선택 latex가 단일 행렬 env면 그 env 이름을, 아니면 null. */
export function matrixEnvOf(selectedLatex: string): MatrixEnv | null {
  const m = selectedLatex.trim().match(ENV_RE);
  return m === null ? null : (m[1] as MatrixEnv);
}

/** 바깥 env 이름만 바꾼 latex. 단일 행렬 env가 아니면 null. */
export function withMatrixEnv(selectedLatex: string, env: MatrixEnv): string | null {
  const m = selectedLatex.trim().match(ENV_RE);
  if (m === null) return null;
  return `\\begin{${env}}${m[2]}\\end{${env}}`;
}

export function SelectionToolbar({
  selectedLatex,
  onReplace,
}: {
  selectedLatex: string;
  /** 선택을 이 latex로 치환하라 (Cell이 replaceSelection + commit 처리). */
  onReplace: (latex: string) => void;
}) {
  const current = matrixEnvOf(selectedLatex);
  if (current === null) return null;
  return (
    <div className="selection-toolbar" role="toolbar" aria-label="Matrix delimiters">
      {DELIMITER_OPTIONS.map(({ env, label, title }) => (
        <button
          key={env}
          type="button"
          className={env === current ? 'delim-btn delim-btn-active' : 'delim-btn'}
          title={title}
          // 포커스(=선택)를 뺏지 않는다 — TransformButtons와 같은 관행.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (env === current) return;
            const next = withMatrixEnv(selectedLatex, env);
            if (next !== null) onReplace(next);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
