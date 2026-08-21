import { useState } from 'react';
import { getActiveMathField } from '../editor/activeField';
import { feedKey, type KeyStroke } from '../editor/feedKey';

/**
 * 자체 키 팔레트 (실험: mobile-kbd-palette). MathLive 자체 가상 키보드 대신 이걸
 * 쓴다 — 버튼이 `mf.insert()`가 아니라 `feedKey`로 **물리 키 입력과 같은 경로**를
 * 탄다(`feedKey.ts` 문서 참고). 그래서 여기 실린 다중 글자 키(`sqrt`, `sin`…)는
 * 문자 하나하나가 인라인 숏컷 엔진을 통과해 `\sqrt`·`\sin`으로 스스로 바뀐다 —
 * 이 파일이 라텍스를 직접 아는 곳은 한 군데도 없다.
 *
 * 항목은 `rules.ts`/`keyOps.ts`와 같은 **레지스트리 패턴** — 키 하나 = `PaletteKey`
 * 하나. `strokes`는 README `## Input`에 실린, 실제로 이 앱 파서가 읽는 표기만
 * 골랐다(`chars()`가 문자열을 글자별 `KeyStroke` 열로 편다).
 */

type PaletteKey = {
  /** 버튼에 보이는 글자. */
  label: string;
  /** 순서대로 흘려보낼 키 입력들. */
  strokes: KeyStroke[];
  title?: string;
  /** 두 칸 폭(스페이스바 등). */
  wide?: boolean;
};

/** 평범한 문자열을 한 글자씩 `KeyStroke`로 편다 — 인라인 숏컷 버퍼가 노리는 그대로. */
function chars(text: string): KeyStroke[] {
  return [...text].map((key) => ({ key }));
}

/** 특수 키 하나. `code`는 `/`→분수처럼 코드 기반 키바인딩에만 필요하다(feedKey.ts 참고). */
function key(k: string, code?: string): KeyStroke[] {
  return [{ key: k, code }];
}

const NUM_LAYER: PaletteKey[] = [
  { label: '7', strokes: chars('7') },
  { label: '8', strokes: chars('8') },
  { label: '9', strokes: chars('9') },
  { label: '(', strokes: chars('(') },
  { label: ')', strokes: chars(')') },
  { label: '4', strokes: chars('4') },
  { label: '5', strokes: chars('5') },
  { label: '6', strokes: chars('6') },
  { label: '+', strokes: chars('+') },
  { label: '-', strokes: chars('-') },
  { label: '1', strokes: chars('1') },
  { label: '2', strokes: chars('2') },
  { label: '3', strokes: chars('3') },
  { label: '×', strokes: chars('*'), title: 'multiply' },
  { label: '÷', strokes: key('/', 'Slash'), title: 'fraction (/)' },
  { label: '0', strokes: chars('0') },
  { label: '.', strokes: chars('.') },
  { label: ',', strokes: chars(',') },
  { label: 'x²', strokes: chars('^'), title: 'superscript (^)' },
  { label: 'x₂', strokes: chars('_'), title: 'subscript (_)' },
];

const ABC_ROWS: string[] = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

const ABC_LAYER: PaletteKey[] = ABC_ROWS.flatMap((row) =>
  [...row].map((ch) => ({ label: ch, strokes: chars(ch) })),
);

/** README `## Input`에 실린 것 중 자주 쓸 법한 부분집합. `chars()`로 흘리면
 * 인라인 숏컷이 스스로 라텍스로 바꾼다 — 여기엔 라텍스 문자열이 없다. */
const SYM_LAYER: PaletteKey[] = [
  { label: '√', strokes: chars('sqrt'), title: 'sqrt' },
  { label: 'π', strokes: chars('pi'), title: 'pi' },
  { label: 'sin', strokes: chars('sin') },
  { label: 'cos', strokes: chars('cos') },
  { label: 'tan', strokes: chars('tan') },
  { label: 'ln', strokes: chars('ln') },
  { label: 'log', strokes: chars('log') },
  { label: 'exp', strokes: chars('exp') },
  { label: 'Σ', strokes: chars('sum'), title: 'sum' },
  { label: '∫', strokes: chars('int'), title: 'integral' },
  { label: 'tr', strokes: chars('tr') },
  { label: 'z̄', strokes: chars('conj'), title: 'conjugate' },
  { label: 'α', strokes: chars('alpha') },
  { label: 'β', strokes: chars('beta') },
  { label: 'θ', strokes: chars('theta') },
  { label: '∞', strokes: chars('infinity') },
  { label: '∂', strokes: chars('del') },
];

const LAYERS = [
  { id: 'num', label: '123', keys: NUM_LAYER },
  { id: 'abc', label: 'abc', keys: ABC_LAYER },
  { id: 'sym', label: 'ƒ(x)', keys: SYM_LAYER },
] as const;

/**
 * 모든 레이어 밑에 늘 있는 줄 — 삭제·이동·확정은 레이어를 안 갈아도 손 닿는 자리에.
 *
 * ⚠ **`code`를 반드시 채운다(실측 버그, `keyPalette.browser.test.tsx`에 핀).**
 * MathLive의 `mightProducePrintableCharacter`(mathlive.mjs 실측)는 `evt.code === ''`
 * 이면 **무조건 true**를 낸다 — 그래서 `code` 없이 Backspace를 보내면 "출력 가능한
 * 문자일 수도 있다"로 오판되어 삭제 대신 숏컷 버퍼에 문자열 `'Backspace'`가 그대로
 * 후보로 쌓이고 아무 일도 안 일어난다. `code`가 있어야 `getCommandForKeybinding`도
 * 제대로 `deleteBackward` 등을 찾는다(`feedKey.ts`의 `/` 주석과 같은 규율).
 */
const NAV_ROW: PaletteKey[] = [
  { label: '←', strokes: key('ArrowLeft', 'ArrowLeft'), title: 'move left' },
  { label: '→', strokes: key('ArrowRight', 'ArrowRight'), title: 'move right' },
  { label: '⌫', strokes: key('Backspace', 'Backspace'), title: 'backspace', wide: true },
  { label: '⏎', strokes: key('Enter', 'Enter'), title: 'evaluate', wide: true },
];

/** 버튼 하나 누름 = strokes를 순서대로 활성 필드에 흘린다. 대상이 없으면 no-op. */
function press(strokes: KeyStroke[]): void {
  const mf = getActiveMathField();
  if (mf === null) return;
  for (const s of strokes) feedKey(mf, s);
}

function PaletteButton({ k }: { k: PaletteKey }) {
  return (
    <button
      type="button"
      className={k.wide ? 'palette-key palette-key-wide' : 'palette-key'}
      title={k.title}
      // 포커스를 뺏지 않는다 — activeField가 이 버튼을 누르는 동안에도 그대로
      // "지금 편집 중인 필드"를 가리켜야 한다(SelectionToolbar와 같은 관행).
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => press(k.strokes)}
    >
      {k.label}
    </button>
  );
}

export function KeyPalette() {
  const [layerId, setLayerId] = useState<(typeof LAYERS)[number]['id']>('num');
  const layer = LAYERS.find((l) => l.id === layerId) ?? LAYERS[0];

  return (
    <div className="key-palette" role="group" aria-label="Symbol keyboard">
      <div className="key-palette-tabs" role="tablist">
        {LAYERS.map((l) => (
          <button
            key={l.id}
            type="button"
            role="tab"
            aria-selected={l.id === layerId}
            className={l.id === layerId ? 'palette-tab palette-tab-active' : 'palette-tab'}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => setLayerId(l.id)}
          >
            {l.label}
          </button>
        ))}
      </div>
      <div className="key-palette-keys">
        {/* 레이어 안 항목 순서가 고정 배열이라 인덱스를 key로 써도 안전하다. */}
        {layer.keys.map((k, i) => (
          <PaletteButton key={i} k={k} />
        ))}
      </div>
      <div className="key-palette-nav">
        {NAV_ROW.map((k) => (
          <PaletteButton key={k.label} k={k} />
        ))}
      </div>
    </div>
  );
}
