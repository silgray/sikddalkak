import { TRANSFORM_OPS, type SelectionInfo, type SelectionOp } from '../cellSelection';

/**
 * 변환 버튼 묶음. 선택이 있는 필드 바로 옆에 렌더한다.
 * mousedown preventDefault로 포커스(=선택)를 뺏지 않는다.
 *
 * algebra가 선택을 못 읽었으면 버튼 대신 그 이유를 같은 자리에 보여준다. 조용히
 * 사라지면 "안 바뀐 것"과 "못 읽은 것"을 구분할 수 없다 — 지금은 후자를 봐야 하는
 * 시기다. 메시지는 algebra가 영어로 낸 것을 그대로 쓴다.
 *
 * `Cell`(입력 selection)과 `CellGroup`(결과 selection) 둘 다 쓴다 — 이 파일이 그
 * 공유 지점이다.
 */
export function TransformButtons({
  selection,
  onApply,
}: {
  selection: SelectionInfo;
  onApply: (op: SelectionOp) => void;
}) {
  if (selection.error !== null) {
    return <span className="result-error">⚠ {selection.error}</span>;
  }
  return (
    <>
      {TRANSFORM_OPS.filter((op) => selection.replacements[op] !== undefined).map((op) => (
        <button
          key={op}
          type="button"
          className="transform-btn"
          title={`Apply ${op} to the selection`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onApply(op)}
        >
          {op}
        </button>
      ))}
    </>
  );
}
