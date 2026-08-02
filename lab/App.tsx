import { useEffect, useMemo, useState } from 'react';
import {
  analyze,
  buildEnv,
  formatShape,
  transform,
  type Env,
  type TransformOp,
} from '../src/algebra';
import { CaseList } from './CaseList';
import { Diagnostics } from './Diagnostics';
import { MathInput } from './MathInput';
import {
  loadState,
  newId,
  saveState,
  type Definition,
  type LabCase,
  type LabState,
} from './cases';

const OPS: readonly TransformOp[] = ['expand', 'simplify', 'factor', 'substitute'];

/**
 * 대수 모듈 검증용 랩.
 *
 * 자동 테스트가 보는 건 "값이 바뀌지 않았는가"뿐이다. **정리된 꼴이 쓸 만한가**는
 * 사람만 판단할 수 있어서, 그 판단을 여기서 하고 케이스로 남긴다 (설계 §10③).
 */
export function App() {
  const [state, setState] = useState<LabState>(loadState);
  const { definitions, expression, op, cases } = state;

  useEffect(() => {
    saveState(state);
  }, [state]);

  const patch = (next: Partial<LabState>): void => setState((s) => ({ ...s, ...next }));

  // 정의들로 환경을 만든다. 정의가 바뀔 때만 다시 만든다.
  const built = useMemo(() => {
    const map: Record<string, string> = {};
    for (const d of definitions) {
      if (d.name.trim() !== '' && d.latex.trim() !== '') map[d.name.trim()] = d.latex;
    }
    return buildEnv(map);
  }, [definitions]);

  const diagnostics = useMemo(
    () => analyze(expression, built.env),
    [expression, built.env],
  );

  const results = useMemo(
    () =>
      OPS.map((name) => ({ name, result: transform(expression, name, built.env) })),
    [expression, built.env],
  );

  const currentFor = (name: TransformOp): string | null => {
    const found = results.find((r) => r.name === name);
    return found !== undefined && found.result.ok ? found.result.value : null;
  };

  const updateDefinition = (id: string, next: Partial<Definition>): void =>
    patch({ definitions: definitions.map((d) => (d.id === id ? { ...d, ...next } : d)) });

  const saveCase = (): void => {
    const actual = currentFor(op);
    patch({
      cases: [
        {
          id: newId(),
          title: '',
          definitions,
          expression,
          op,
          expected: '',
          actual: actual ?? '',
          verdict: null,
          note: '',
        },
        ...cases,
      ],
    });
  };

  /** 저장된 케이스를 **그 케이스의 정의로** 지금 다시 돌려본다. */
  const replay = (c: LabCase): string | null => {
    const map: Record<string, string> = {};
    for (const d of c.definitions) {
      if (d.name.trim() !== '' && d.latex.trim() !== '') map[d.name.trim()] = d.latex;
    }
    const result = transform(c.expression, c.op, buildEnv(map).env);
    return result.ok ? result.value : null;
  };

  return (
    <main className="lab">
      <header>
        <h1>algebra lab</h1>
        <p>
          <code>src/algebra</code> 를 눈으로 확인하는 도구. 정의를 바꾸면 같은 식이 다르게
          해석되는지 볼 수 있다 — 그게 이 모듈의 요점이다.
        </p>
      </header>

      <section className="panel">
        <h2>
          Definitions
          <span className="panel-actions">
            <button
              type="button"
              onClick={() =>
                patch({ definitions: [...definitions, { id: newId(), name: '', latex: '' }] })
              }
            >
              + Add
            </button>
          </span>
        </h2>

        <ul className="definitions">
          {definitions.map((d) => {
            const shape = built.env.shapes[d.name.trim()];
            return (
              <li key={d.id}>
                <input
                  className="def-name"
                  value={d.name}
                  onChange={(e) => updateDefinition(d.id, { name: e.target.value })}
                  placeholder="name"
                />
                <span className="equals">=</span>
                <MathInput
                  value={d.latex}
                  onChange={(latex) => updateDefinition(d.id, { latex })}
                />
                <span className="shape-badge">
                  {shape === undefined ? '?' : formatShape(shape)}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    patch({ definitions: definitions.filter((x) => x.id !== d.id) })
                  }
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>

        {built.unresolved.length > 0 && (
          <ul className="errors">
            {built.unresolved.map((e, i) => (
              <li key={i}>
                <span className="code">{e.code}</span> {e.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>
          Expression
          <span className="shape-badge">
            {diagnostics.shape === null ? 'error' : formatShape(diagnostics.shape)}
          </span>
        </h2>
        <div className="expression">
          <MathInput value={expression} onChange={(latex) => patch({ expression: latex })} />
        </div>
      </section>

      <section className="panel">
        <h2>
          Transforms
          <span className="panel-actions">
            <select value={op} onChange={(e) => patch({ op: e.target.value as TransformOp })}>
              {OPS.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <button type="button" onClick={saveCase} disabled={diagnostics.errors.length > 0}>
              Save case
            </button>
          </span>
        </h2>

        <ul className="results">
          {results.map(({ name, result }) => (
            <li key={name} className={name === op ? 'selected' : ''}>
              <span className="op-badge">{name}</span>
              {result.ok ? (
                <>
                  <MathInput value={result.value} readOnly />
                  <code className="raw">{result.value}</code>
                </>
              ) : (
                <span className="error">
                  <span className="code">{result.errors[0].code}</span>{' '}
                  {result.errors[0].message}
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>Diagnostics</h2>
        <Diagnostics data={diagnostics} />
      </section>

      <CaseList
        cases={cases}
        currentActual={replay}
        onLoad={(c) =>
          patch({ definitions: c.definitions, expression: c.expression, op: c.op })
        }
        onUpdate={(id, next) =>
          patch({ cases: cases.map((c) => (c.id === id ? { ...c, ...next } : c)) })
        }
        onRemove={(id) => patch({ cases: cases.filter((c) => c.id !== id) })}
        onImport={(imported) => patch({ cases: [...imported, ...cases] })}
      />
    </main>
  );
}

/** 타입만 쓰는 곳에서 `Env` 를 잃지 않게 (랩 확장 시 필요). */
export type { Env };
