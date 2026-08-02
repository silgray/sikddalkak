import {
  formatShape,
  isPureScalar,
  sexpSyntax,
  sexpTyped,
  sexpTypedWithShapes,
  type Diagnostics as DiagnosticsData,
} from '../src/algebra';

/**
 * 진단 패널 — **어느 단계에서 무엇이 정해졌는지**를 눈으로 보는 곳.
 *
 * 이 모듈의 설계 주장은 "구조 판단(우선순위·그룹)과 의미 판단(연산·모양)이 서로 다른
 * 단계에서 일어난다"는 것이다. 그 주장이 실제로 지켜지는지 확인하려면 두 단계의 결과를
 * 나란히 볼 수 있어야 한다.
 */
export function Diagnostics({ data }: { data: DiagnosticsData }) {
  return (
    <div className="diagnostics">
      <Row label="Syntax IR" hint="구조만 — 어느 곱 기호였고 어떻게 묶였는가">
        {data.syntax === null ? <em>—</em> : <code>{sexpSyntax(data.syntax)}</code>}
      </Row>

      <Row label="Typed IR" hint="해석된 연산 — 여기서 내적/외적/행렬곱/스칼라곱이 갈린다">
        {data.typed === null ? <em>—</em> : <code>{sexpTyped(data.typed)}</code>}
      </Row>

      <Row label="Shapes" hint="노드마다 붙은 모양. (1,1) 이 곧 스칼라다">
        {data.typed === null ? <em>—</em> : <code>{sexpTypedWithShapes(data.typed)}</code>}
      </Row>

      <Row label="Result shape" hint="식 전체의 모양">
        {data.shape === null ? <em>—</em> : <code>{formatShape(data.shape)}</code>}
      </Row>

      <Row label="CE delegation" hint="순수 스칼라일 때만 compute-engine에 통째로 넘긴다">
        {data.typed === null ? (
          <em>—</em>
        ) : isPureScalar(data.typed) ? (
          <code>delegated (pure scalar)</code>
        ) : (
          <code>ours (shape-aware)</code>
        )}
      </Row>

      {data.errors.length > 0 && (
        <Row label="Errors" hint="모호하거나 모양이 안 맞으면 계산하지 않는다">
          <ul className="errors">
            {data.errors.map((e, i) => (
              <li key={i}>
                <span className="code">{e.code}</span> {e.message}
                {e.where !== undefined && <span className="where"> ({e.where})</span>}
              </li>
            ))}
          </ul>
        </Row>
      )}
    </div>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="diagnostics-row">
      <div className="diagnostics-label">
        {label}
        <span className="hint">{hint}</span>
      </div>
      <div className="diagnostics-value">{children}</div>
    </div>
  );
}
