import { MathfieldElement } from 'mathlive';

// 테스트 환경 노이즈 차단 — 폰트/사운드는 편집 동작과 무관하다.
MathfieldElement.fontsDirectory = null;
MathfieldElement.soundsDirectory = null;
MathfieldElement.computeEngine = null;

/**
 * 실제 MathfieldElement를 구동하는 시나리오 하네스.
 * `executeCommand`는 키보드 입력이 최종적으로 호출하는 실제 편집 연산이라
 * (deleteBackward, typedText, move…), 브라우저 프로브로 실측하던 동작을
 * 그대로 자동 테스트로 옮길 수 있다.
 *
 * 주의: MathLive의 input 이벤트는 rAF로 배칭된다 — 이벤트 열을 검사하려면
 * 조작 사이에 `settle()`을 기다려야 한다 (일회성 프로브 시절의 실측).
 */
export type FieldHarness = {
  mf: MathfieldElement;
  /** typedText로 한 글자씩 입력 (실제 타이핑 파이프라인 — 단, 인라인 숏컷은 미발동). */
  type: (text: string) => Promise<void>;
  command: (command: string | [string, ...unknown[]]) => Promise<void>;
  /** 지금까지 수집한 input 이벤트 열 (latex, 캐럿). */
  events: { latex: string; pos: number }[];
  value: () => string;
  settle: () => Promise<void>;
  dispose: () => void;
};

const settle = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 10));
  });

export async function createField(initialLatex = ''): Promise<FieldHarness> {
  const mf = new MathfieldElement();
  mf.mathVirtualKeyboardPolicy = 'manual';
  document.body.append(mf);
  if (initialLatex !== '') mf.setValue(initialLatex, { silenceNotifications: true });
  mf.focus();
  await settle();

  const events: { latex: string; pos: number }[] = [];
  mf.addEventListener('input', () => events.push({ latex: mf.value, pos: mf.position }));

  return {
    mf,
    events,
    value: () => mf.value,
    async type(text) {
      for (const ch of text) {
        mf.executeCommand(['typedText', ch, { simulateKeystroke: true }]);
        await settle();
      }
    },
    async command(command) {
      mf.executeCommand(command as Parameters<MathfieldElement['executeCommand']>[0]);
      await settle();
    },
    settle,
    dispose() {
      mf.remove();
    },
  };
}
