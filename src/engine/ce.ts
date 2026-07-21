import { ComputeEngine } from '@cortex-js/compute-engine';

/**
 * 앱 전역에서 쓰는 단 하나의 Compute Engine 인스턴스.
 *
 * 주의: MathLive는 자기 의존성으로 compute-engine 0.58을 따로 들고 있고
 * 우리는 0.90을 쓴다. 두 버전이 섞이지 않도록
 *   - `MathfieldElement.computeEngine` 을 설정하지 않고
 *   - `mf.getValue('math-json')` 을 쓰지 않는다.
 * MathLive에서는 LaTeX 문자열(`mf.value`)만 받아서 여기서 파싱한다.
 */
export const ce = new ComputeEngine();
