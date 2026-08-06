import { MathfieldElement } from 'mathlive';

/**
 * `test.ts` 전용 최소 DOM 뷰어. `render(...)` 결과를 눈으로 보기 위한 것뿐이라
 * 디자인은 신경 쓰지 않는다. `latexs.forEach` 한 바퀴 = 박스 하나(`group`),
 * 그 안의 각 `render(...)` 호출 = 줄 하나(`show`). `show`에 값을 같이 주면 그 줄에
 * 마우스를 올렸을 때 `dump`(구 test.ts의 `inspect(..., {depth:null, colors:true})`)와
 * 같은 정신으로 — 색 입히고 깊이 제한 없이 — 트리를 호버박스로 띄운다.
 */


const COLOR = {
  key: '#9cdcfe',
  string: '#ce9178',
  number: '#b5cea8',
  boolean: '#569cd6',
  null: '#569cd6',
  punct: '#808080',
};

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function span(color: string, text: string): string {
  return `<span style="color:${color}">${esc(text)}</span>`;
}

/** 깊이 제한 없이 재귀. `TypedExpr`는 순환 없는 값 트리라 순환 방어는 안 한다. */
function colorize(value: unknown, indent: string): string {
  if (value === null) return span(COLOR.null, 'null');
  if (typeof value === 'number') return span(COLOR.number, String(value));
  if (typeof value === 'boolean') return span(COLOR.boolean, String(value));
  if (typeof value === 'string') return span(COLOR.string, JSON.stringify(value));
  if (Array.isArray(value)) {
    if (value.length === 0) return span(COLOR.punct, '[]');
    const next = `${indent}  `;
    const items = value.map((v) => `${next}${colorize(v, next)}`).join(',\n');
    return `${span(COLOR.punct, '[')}\n${items}\n${indent}${span(COLOR.punct, ']')}`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return span(COLOR.punct, '{}');
    const next = `${indent}  `;
    const items = entries
      .filter(([k, /* v */]) => k !== 'shape')
      .map(([k, v]) => `${next}${span(COLOR.key, k)}${span(COLOR.punct, ':')} ${colorize(v, next)}`)
      .join(',\n');
    return `${span(COLOR.punct, '{')}\n${items}\n${indent}${span(COLOR.punct, '}')}`;
  }
  return span(COLOR.punct, String(value));
}

let current: HTMLElement = document.body;

export function group(title: string, run: () => void): void {
  const box = document.createElement('section');
  box.style.border = '1px solid #888';
  box.style.margin = '12px';
  box.style.padding = '8px';

  const heading = document.createElement('div');
  heading.textContent = title;
  heading.style.fontFamily = 'monospace';
  heading.style.marginBottom = '8px';
  box.appendChild(heading);

  document.body.appendChild(box);

  const prev = current;
  current = box;
  try {
    run();
  } finally {
    current = prev;
  }
}

export function show(label: string, latex: string, value?: unknown): void {
  const wrap = document.createElement('div');
  wrap.style.margin = '4px 0';

  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.alignItems = 'center';
  row.style.gap = '8px';
  wrap.appendChild(row);

  const tag = document.createElement('span');
  tag.textContent = label;
  tag.style.minWidth = '110px';
  tag.style.fontFamily = 'monospace';
  row.appendChild(tag);

  const mf = new MathfieldElement();
  mf.value = latex;
  mf.readOnly = true;
  row.appendChild(mf);

  if (value !== undefined) {
    mf.style.cursor = 'pointer';

    const panel = document.createElement('pre');
    panel.style.display = 'none';
    panel.style.background = '#1e1e1e';
    panel.style.color = '#d4d4d4';
    panel.style.padding = '8px 10px';
    panel.style.margin = '4px 0 0 118px';
    panel.style.border = '1px solid #555';
    panel.style.borderRadius = '4px';
    panel.style.maxHeight = '60vh';
    panel.style.overflow = 'auto';
    panel.style.fontSize = '13px';
    // panel.innerHTML = dump(value);
    panel.innerHTML = colorize(value, '');
    wrap.appendChild(panel);

    mf.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });
  }

  current.appendChild(wrap);
}
