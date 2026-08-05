import { MathfieldElement } from 'mathlive';

// 폰트는 저장소 루트 public/mathlive/fonts 에 복사돼 있다 (scripts/copy-mathlive-assets.mjs).
MathfieldElement.fontsDirectory = `${import.meta.env.BASE_URL}mathlive/fonts`;
MathfieldElement.soundsDirectory = null;
MathfieldElement.locale = 'en';
// ⚠ mathlive는 CE 0.58을 따로 물고 있다. 우리 0.90과 섞이면 안 되므로 붙이지 않는다.
MathfieldElement.computeEngine = null;

// 정적 설정이 끝난 뒤에 test.ts가 평가되도록 동적 import로 순서를 강제한다
// (정적 import는 호이스팅돼 위 대입보다 먼저 실행될 수 있다).
void import('./test');
