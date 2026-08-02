import { useRef } from 'react';
import { MathInput } from './MathInput';
import type { LabCase, Verdict } from './cases';

const VERDICTS: readonly { value: Verdict; label: string }[] = [
  { value: 'ok', label: 'OK' },
  { value: 'ng', label: 'NG' },
  { value: 'hold', label: '보류' },
];

export function CaseList({
  cases,
  currentActual,
  onLoad,
  onUpdate,
  onRemove,
  onImport,
}: {
  cases: readonly LabCase[];
  /** 지금 화면의 결과 — 저장 시점과 달라졌는지 보여주기 위해. */
  currentActual: (c: LabCase) => string | null;
  onLoad: (c: LabCase) => void;
  onUpdate: (id: string, patch: Partial<LabCase>) => void;
  onRemove: (id: string) => void;
  onImport: (cases: readonly LabCase[]) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);

  const exportJson = (): void => {
    const blob = new Blob([JSON.stringify(cases, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'algebra-lab-cases.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  const importJson = (file: File): void => {
    void file.text().then((text) => {
      try {
        const parsed = JSON.parse(text) as LabCase[];
        if (Array.isArray(parsed)) onImport(parsed);
      } catch {
        // 잘못된 파일은 조용히 무시한다 — 랩 도구라 오류 UI까지 만들 이유가 없다.
      }
    });
  };

  return (
    <section className="panel">
      <h2>
        Cases <span className="count">{cases.length}</span>
        <span className="panel-actions">
          <button type="button" onClick={exportJson} disabled={cases.length === 0}>
            Export
          </button>
          <button type="button" onClick={() => fileInput.current?.click()}>
            Import
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file !== undefined) importJson(file);
              e.target.value = '';
            }}
          />
        </span>
      </h2>

      {cases.length === 0 && (
        <p className="empty">
          아직 저장한 케이스가 없다. 위에서 식을 만들고 <strong>Save case</strong> 를 눌러라.
        </p>
      )}

      <ul className="case-list">
        {cases.map((c) => {
          const now = currentActual(c);
          const drifted = now !== null && now !== c.actual;
          return (
            <li key={c.id} className={`case verdict-${c.verdict ?? 'none'}`}>
              <div className="case-head">
                <input
                  className="case-title"
                  value={c.title}
                  onChange={(e) => onUpdate(c.id, { title: e.target.value })}
                  placeholder="untitled"
                />
                <span className="op-badge">{c.op}</span>
                <span className="case-actions">
                  {VERDICTS.map((v) => (
                    <button
                      key={v.value}
                      type="button"
                      className={c.verdict === v.value ? 'active' : ''}
                      onClick={() =>
                        onUpdate(c.id, { verdict: c.verdict === v.value ? null : v.value })
                      }
                    >
                      {v.label}
                    </button>
                  ))}
                  <button type="button" onClick={() => onLoad(c)}>
                    Load
                  </button>
                  <button type="button" onClick={() => onRemove(c.id)}>
                    ✕
                  </button>
                </span>
              </div>

              <div className="case-body">
                <div className="case-field">
                  <span className="case-label">input</span>
                  <MathInput value={c.expression} readOnly />
                </div>
                <div className="case-field">
                  <span className="case-label">saved</span>
                  <MathInput value={c.actual} readOnly />
                </div>
                {c.expected !== '' && (
                  <div className="case-field">
                    <span className="case-label">expected</span>
                    <MathInput value={c.expected} readOnly />
                  </div>
                )}
                {drifted && (
                  <div className="case-field drift">
                    <span className="case-label">now</span>
                    <MathInput value={now} readOnly />
                    <span className="drift-note">저장 시점과 결과가 다르다</span>
                  </div>
                )}
              </div>

              <input
                className="case-note"
                value={c.note}
                onChange={(e) => onUpdate(c.id, { note: e.target.value })}
                placeholder="메모 (왜 OK/NG 인지)"
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
