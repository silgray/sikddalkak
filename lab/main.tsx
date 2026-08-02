import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MathfieldElement } from 'mathlive';
import { App } from './App';
import './lab.css';

// 폰트는 저장소 루트 public/mathlive/fonts 에 복사돼 있다 (scripts/copy-mathlive-assets.mjs).
MathfieldElement.fontsDirectory = `${import.meta.env.BASE_URL}mathlive/fonts`;
MathfieldElement.soundsDirectory = null;
MathfieldElement.locale = 'en';
// ⚠ mathlive는 CE 0.58을 따로 물고 있다. 우리 0.90과 섞이면 안 되므로 붙이지 않는다.
MathfieldElement.computeEngine = null;

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
