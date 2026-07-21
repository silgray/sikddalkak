import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MathfieldElement } from 'mathlive';
import App from './App';
import './styles.css';

// 폰트는 public/mathlive/fonts 로 복사해둔다 (scripts/copy-mathlive-assets.mjs).
MathfieldElement.fontsDirectory = '/mathlive/fonts';
// 계산기에 타이핑 효과음은 필요 없다.
MathfieldElement.soundsDirectory = null;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
