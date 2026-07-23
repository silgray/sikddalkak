import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MathfieldElement } from 'mathlive';
import App from './App';
import './styles.css';

// 폰트는 public/mathlive/fonts 로 복사해둔다 (scripts/copy-mathlive-assets.mjs).
// BASE_URL 기준 상대경로여야 서브경로 배포(GitHub Pages 등)에서도 폰트가 로드된다.
MathfieldElement.fontsDirectory = `${import.meta.env.BASE_URL}mathlive/fonts`;
// 계산기에 타이핑 효과음은 필요 없다.
MathfieldElement.soundsDirectory = null;
// UI는 영어로 통일 (MathLive 폰트가 한글 글리프를 렌더하지 못하는 제약과 일치).
// 브라우저 로케일을 따라가면 ☰ 메뉴가 한국어로 나온다.
MathfieldElement.locale = 'en';

// MathLive 자체 CAS를 끈다. 이걸 null로 두지 않으면 MathLive가 자기 번들의
// compute-engine 0.58 인스턴스를 몰래 만들고, ☰ 메뉴의 Evaluate/Simplify/Solve가
// 그걸로 계산해서 결과를 **입력 필드에 직접 덮어쓴다**.
//   "2\pi" -[메뉴 Simplify]-> "2\pi=2\pi" -[다시]-> "2\pi\error{\blacksquare}=2\pi"
// 우리 평가 경로(Enter -> ce 0.90)를 우회할 뿐 아니라 입력 정본을 오염시킨다.
// null이면 해당 메뉴 항목이 visible:false가 되고 실행돼도 no-op이 된다.
MathfieldElement.computeEngine = null;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
