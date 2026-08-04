# CLAUDE.md

식딸깍(sikddalkak) — 수식을 입력하면 정리·계산해 주는 심볼릭 계산기 노트 웹앱.
셀 스택 형태로 식을 쌓고, 이름 기반 의존성으로 셀끼리 변수를 공유한다.

## 스택

- **Vite 8** + **React 19** + **TypeScript 5.9** (ESM, `"type": "module"`)
- **mathlive 0.110.0** — 수식 입력/렌더 웹 컴포넌트 (`<math-field>`)
- **@cortex-js/compute-engine 0.90.0** (CE) — 파싱·계산·정리
- **vitest 4** — 단위 테스트(jsdom) + 브라우저 테스트(playwright/Chromium)

⚠ **버전 격리**: mathlive는 내부에 CE 0.58을 따로 물고 있다. 우리 0.90과 섞이면
안 되므로 `MathfieldElement.computeEngine`을 설정하지 않고 `mf.getValue('math-json')`도
쓰지 않는다. **MathLive↔CE 경계는 오직 LaTeX 문자열만 건넌다** (`src/engine/ce.ts` 참고).

## 표현 형식과 변환 경계

식은 세 가지 형식으로 존재하고, 각 경계에서만 변환된다:

- **LaTeX 문자열** — 문서의 정본. `FormulaObject.latex`, localStorage, 실행취소
  스냅샷이 전부 이 형식. **저장·전달의 유일한 통화.**
- **MathLive atom 트리** — `<math-field>` 셰도우 DOM 안(우리 코드 밖). 렌더·편집·캐럿.
- **CE Expression (MathJSON)** — 계산 중 메모리에만. evaluate/simplify/expand/factor.

변환 지점:
① 입력 = atom→LaTeX(`mf.value`)
② 계산 = LaTeX→MathJSON(`ce.parse`)→LaTeX
③ 선택 변환 = 선택 atom→LaTeX→변환→LaTeX→atom(`mf.insert`). localStorage엔 LaTeX만 저장.

## 프로젝트 구조

### `src/engine/` — 계산 로직 (UI 의존성 없음, 순수 함수)

- **`ce.ts`** — 앱 전역 단일 CE 인스턴스. 버전 격리 규칙의 근거.
- **`evaluate.ts`** — 핵심 평가기. `evaluateGraph(inputs)`가 셀들을 받아
  `freeVariables`로 의존성 그래프를 만들고 위상 정렬 → `subs`로 치환 →
  `simplify().evaluate()`. 두 단계 캐시(구조/결과)로 바뀐 노드만 재계산.
  정의(`a=3`) 감지, 관계식(`=`,`<`) 불리언 판정, 순환/중복 정의 에러.
- **`matrixPipeline.ts`** — 행렬 전용 경로. CE가 곱셈을 교환법칙으로 재배열하는
  걸 막는 축소 정규화 파싱(`ORDER_PRESERVING_FORMS`), Transpose/Power 사전 접기
  (`foldMatrixFns`), 1×1→스칼라, 벡터 내적/외적 마커 처리. evaluate·transform 공용.
- **`transform.ts`** — 선택 영역 구문 변환. `transformSelection(latex, op)`,
  op ∈ expand/simplify/factor. 다변수·비다항 공통인자 추출(CE factor 보강),
  행렬 선택 변환, 부동소수점 부스러기 chop.

### `src/algebra/` — 모양(shape) 기반 심볼릭 대수 (신규, 아직 주 앱 미연결)

`src/engine/` 의 후계로 만드는 중. **아직 어디서도 쓰이지 않는다** — 주 앱은 그대로
`src/engine/` 을 쓴다. 붙이는 건 별건.

만든 이유: `src/engine/transform.ts` 의 `transformSelection(latex, op)` 은 **문맥이 없어서**
심볼이 스칼라인지 행렬인지 모른다. 그래서 `ABA` 를 `A²B` 로 만드는 등 교환법칙을 잘못
적용한다. CE의 무타입 `Multiply` 위에 얹힌 구조라 우회로는 못 고친다.

- **`types-shape.ts`** — 모양 도메인. **모든 것이 `(rows, cols)` 이고 `(1,1)` 이 스칼라다.**
  벡터는 파생 술어. 이 한 선택으로 `v^Tv → 스칼라` 가 하드코딩 없이 나온다.
- **`types-SyntaxNode.ts`** — Syntax IR 타입. `·`/`×`/병치를 **구분해 보존**한다
  (CE는 셋 다 `Multiply` 로 뭉갠다). 어느 쪽이 내적/스칼라곱인지는 이 층에서 안 정한다
  (그건 elaborate 몫).
- **`preprocess.ts`** / **`parseSymbol.ts`** / **`translateToTree.ts`** — CE 프런트엔드.
  `preprocess`가 `\cdot`/`\times` 를 마커 심볼로 바꿔 CE 파싱에서 살아남게 하고
  (CE는 파싱하면서 뭉개버린다, 실측), `parseSymbol`이 축소 정규화 폼(`Number`만)으로
  CE에 파싱을 맡긴 뒤, `translateToTree`가 그 MathJSON을 Syntax IR로 번역한다(우선순위
  후위 > 병치 > `·`/`×` > `+`, **모호성 → 오류** 판정 포함). CE quirk 우회는 이 세
  파일 안에 갇힌다. `parseCeJson`(=`translateToTree`)은 재작성이 CE 결과를 되받을 때도 쓴다.
- **`elaborate.ts`** — **설계의 심장.** 연산자 해석 + 차원 검사 + 모양 계산을 **한 패스로**
  한다 (`·` 가 내적인지 스칼라곱인지는 모양을 알아야 정해지고, 결과 모양은 연산자가
  정해져야 나오는 상호 의존이라 나눌 수 없다). 정규화는 하지 않는다 — 곱을 둘씩만
  중첩해서 담아둔다 (`normalize.ts` 몫). `\frac{p}{q}` 는 `p·q^{-1}` 로 풀어버리지 않고
  전용 `frac` 노드로 남긴다 — 그래야 `\frac{x^2+2x+1}{x+1}` 이 원문 형태로 렌더된다.
- **`normalize.ts`** — elaborate 직후에 도는 별도 정규화 패스. 평탄화·스칼라 호이스팅·
  `neg`/숫자 접기·정렬·항등원 제거. **이웃 인수를 거듭제곱으로 자동으로 접지는 않는다**
  (`AA` 는 `AA` 로 남는다) — 사용자가 쓴 곱의 모양을 임의로 바꾸지 않는다는 결정.
- **`opers.ts`** — 대수 성질 **표**(교환/결합/분배). 코드 분기가 아니라 데이터.
- **`normal.ts`** — 정규형. 단항식 = (수치 계수, 스칼라 인수 **집합**, 비스칼라 인수 **열**).
  비스칼라 열의 순서를 지키는 게 비가환을 지키는 지점.
- **`rewrite.ts`** — expand/simplify/factor/substitute. **순수 스칼라 부분식만** CE에 위임.
- **`render.ts`** — Typed IR → LaTeX. 계약은 **렌더 멱등성**(낸 걸 다시 읽어 또 내면 같다).
- **`numeric.ts`** — 수치 평가기. 재작성 전후 값 대조 **전용**(역행렬은 일부러 뺐다).
- **`debug.ts`** — Syntax/Typed IR → 사람이 읽는 s-식. 테스트 기대값과 랩 진단 패널이 공유.
- **`types-result.ts`** — `Result<T>` / `AlgebraError` 등 공용 결과 타입.
- **`index.ts`** — 공개 API (`parse`/`transform`/`buildEnv`/`analyze`/`solveFor` 자리).

⚠ **CE 0.90 실측 함정** (전부 테스트에 핀으로 고정돼 있다):
- `Add`/`Power` 정규화 폼은 항을 재배열하고 `A^{-1}` 을 `\frac{1}{A}` 로 바꾼다 → `Number` 만 쓴다
- 홑 대문자 + 괄호(`A(v)`)를 **함수 호출로 읽는다** → 병치로 되돌린다 (후위가 붙어도)
- **`.latex` 직렬화에 버그가 있다** — `Power(Divide(X,a),2)` → `\frac{1}{a}(X)^2` 로 지수 범위가
  바뀐다. 그래서 CE 결과는 **MathJSON으로 받는다**

### `src/editor/` — MathLive 경계 레이어 (구조 안전성)

MathLive의 quirk를 흡수하고 "항상 정상 구조"를 강제하는 곳. **버전 업 시 재확인 지점.**

- **`internals.ts`** — MathLive 내부 API 접근 **단일 창구** (model, 숏컷 버퍼
  flush, dispose-포커스 크래시 패치). 전부 try/catch 방어.
- **`latexScan.ts`** — 위치 붙은 LaTeX 토큰/그룹 스캐너. 재직렬화 없이 원본에
  대한 `Splice`만 만든다 (손대지 않은 부분은 바이트 보존).
- **`rules.ts`** — 구조 규칙 **레지스트리** (데이터). `{id, find, fix, examples}`.
  밑 없는 첨자·짝 없는 괄호·빈 첨자·평평한 괄호 통일 등. `repairLatex`(고정점 반복,
  멱등), `findViolations`. **규칙 추가 = 항목 하나 + 예시 몇 줄.**
- **`keyOps.ts`** — 키 연산 **레지스트리** (데이터). `{id, when, run, scenarios}`.
  파손을 애초에 막는 예방 층 — 괄호 쌍 생성/제거, 밑 없는 `^`/`_` 차단, 첨자 강등.
- **`selection.ts`** — 선택을 "한 레벨 연속 형제 열"로 강제. `normalizeSelection`
  (게이트), `siblingRunRange`, shift+화살표·Ctrl+D 확장 로직.
- **`wellformed.ts`** — 위 규칙들의 파사드 (`repairLatex`/`findViolations` 재노출).
- **`harness.ts`** — 브라우저 테스트용 실제 MathLive 구동 하네스.

### `src/state/` — 상태 관리

- **`workspace.ts`** — **유일한 전역 상태.** `workspaceReducer`(useReducer).
  Workspace{tabs, activeTabId} / Tab{objects, focus, history, ...}. 실행취소는
  키 입력마다 스냅샷을 쌓되 undo/redo **시점에** 키워드(cos/sin/변수) 단위로 그룹핑.
  `classifyEdit`·`tokenizeRun`이 그 판정. 상시 빈 셀 불변식.
- **`persist.ts`** — localStorage 직렬화(v2 스키마, v1 마이그레이션, 디바운스 저장).

### `src/components/` — UI (React, 로컬 상태만)

- **`Workspace.tsx`** — 최상위. reducer 보유, 전역 Ctrl+Z/Y, 탭 전환.
- **`CellStack.tsx`** — 셀 목록 + 평가 디바운스(타이핑 300ms/구조 변경 즉시) +
  드래그 재정렬. `evaluateGraph` 호출 지점.
- **`Cell.tsx`** — 셀 하나 (입력행 + 결과행). 선택 추적, 변환 버튼, 구분 기호 툴바.
- **`MathField.tsx`** — `<math-field>` React 래퍼. **UI↔에디터 경계.** input마다
  `repairLatex` 게이트, selection-change마다 `normalizeSelection` 게이트,
  keydown을 `dispatchKeyOp`로. uncontrolled(`new MathfieldElement()`).
- **`SelectionToolbar.tsx`** — 행렬 통째 선택 시 뜨는 구분 기호 플로팅 툴바.
- **`HelpPanel.tsx`** / **`TabBar.tsx`** — 도움말 패널, 탭 바.
- **`App.tsx`** / **`main.tsx`** — 진입점. main.tsx에서 MathLive 전역 설정
  (폰트/로케일/CE 비활성화).

### `lab/` — `src/algebra` 검증용 랩 (배포 안 함, ⚠ 당분간 미사용)

`npm run lab` (localhost:5174). 주 앱 빌드·Pages 워크플로와 **완전히 분리**돼 있다
(`vite.lab.config.ts`). 랩이 깨져도 제품은 영향 없다.

**지금은 이 워크플로를 안 쓰고 있다** — 코드는 지우지 않았지만 당분간 돌릴 일이 없다.
아래는 쓰던 때의 설계 의도이고, 재개 전까지 `src/algebra` 검증은 단위 테스트
(`*.test.ts`)와 퍼즈(`rewrite.fuzz.test.ts`)만으로 돈다: 자동 테스트가 보는 건
"값이 바뀌지 않았는가"뿐이라, 원래는 **정리된 꼴이 쓸 만한가**를 랩에서 사람이 눈으로
봤다 — 정의 패널(`v=벡터`, `A=행렬`, `a=3`)을 바꿔가며 같은 식이 다르게 해석되는지
확인하고, 진단 패널에서 Syntax IR → Typed IR → 노드별 모양 → CE 위임 여부를 보는 식.
판정(OK/NG/보류)은 케이스로 localStorage에 남고 JSON으로 내보낼 수 있다.

### 기타

- **`types.ts`** — `FormulaObject`(정본), `EvalResult`, `CellMode` 등 공용 타입.
- **`styles.css`** — 전역 CSS (라이트/다크 자동, CSS 변수).
- **`scripts/copy-mathlive-assets.mjs`** — 빌드 전 MathLive 폰트를 public으로 복사.

## UI ↔ 계산 경계

- **UI(components)는 계산을 모른다.** `CellStack`이 `evaluateGraph`에 `{id, latex, mode}`
  만 넘기고 `EvalResult`를 받는다. 엔진은 React·DOM에 의존하지 않는 순수 함수.
- **문서 정본은 LaTeX 문자열.** 편집 중인 draft는 mathfield DOM 안에만 있고,
  디바운스/blur/Enter 시점에 `onEdit`으로 문서에 flush된다.
- **에디터 레이어(editor/)가 MathLive와 계산 사이의 완충.** 파손된 LaTeX이
  문서·계산으로 새지 않게 게이트가 교정한다.

## 상태 관리 방식

- **전역**: `workspaceReducer` 하나뿐. 탭·문서·실행취소·포커스 전부 여기. (`useReducer`)
- **로컬**: 컴포넌트별 UI 상태만 (선택 영역, 드래그, 도움말 열림 등 `useState`).
- **파생값**: 계산 결과는 상태가 아니라 `useMemo(evaluateGraph)` — 엔진 캐시가 담당.

## 코딩 컨벤션

- 주석·커밋·계획은 **한국어**, 코드 식별자·UI 문자열은 **영어**.
  (MathLive 폰트가 한글 글리프를 렌더 못 함)
- 파일명: 컴포넌트 `PascalCase.tsx`, 그 외 `camelCase.ts`. 테스트는 대상 옆에
  `*.test.ts`(단위) / `*.browser.test.tsx`(실 MathLive 구동).
- **레지스트리 패턴**: 늘어나는 규칙(구조 규칙·키 연산)은 코드 분기가 아니라
  선언 데이터 배열로 두고, 테스트가 `examples`/`scenarios`를 자동 순회.
- **실측 우선**: MathLive/CE 동작은 문서(부정확)가 아니라 브라우저에서 실측해
  확인하고, 그 결과를 브라우저 테스트에 "동작 핀"으로 고정한다.
- MathLive 내부 API는 `internals.ts`에만, 전부 try/catch 폴백.

## 명령어

### 실행

```bash
npm run dev            # 개발 서버 (Vite, localhost:5173)
npm run preview        # build 결과물 로컬 프리뷰
npm run lab            # src/algebra 검증용 랩 (localhost:5174, 배포 안 함, ⚠ 당분간 미사용)
```

### 테스트

```bash
npm test                              # 단위 테스트 전체 (vitest, jsdom)
npm run test:watch                    # 단위 테스트 watch 모드
npx vitest run src/state/workspace.test.ts   # 단위 테스트 단일 파일

npm run test:browser                  # 브라우저 테스트 전체 (playwright/Chromium, 실 MathLive 구동)
npx vitest run --config vitest.browser.config.ts src/editor/editor.browser.test.tsx  # 단일 파일

npx playwright install chromium       # 브라우저 테스트 최초 1회 필요 (헤드리스 크로미움 바이너리)

ALGEBRA_FUZZ_SAMPLES=10000 npx vitest run src/algebra   # 대수 퍼즈를 넓게 (기본 씨앗당 250)
```

- 단위 테스트는 `*.test.ts` — jsdom, MathLive 없이 순수 로직(엔진/리듀서/에디터 규칙) 검증.
  `workspace.fuzz.test.ts`처럼 랜덤 시드 fuzz 테스트도 여기 포함.
- **`rewrite.fuzz.test.ts` 는 대수 모듈의 안전망이다.** 무작위 식에 구체적인 수를 채워
  `값·모양이 재작성 전후로 같은가`와 `렌더가 멱등인가`를 확인한다. 여기서 잡힌 버그가
  표 테스트로는 안 잡히는 종류다 (교환법칙 오적용, 인수 순서 뒤집힘, CE 직렬화 버그).
  **대수 모듈을 건드렸으면 표본을 크게 잡고 한 번 돌려볼 것.**
- 브라우저 테스트는 `*.browser.test.tsx` — 실제 `<math-field>`를 띄워야 하는
  것(키 입력 시퀀스, 셀렉션, DOM 이벤트)만. jsdom보다 느리니 최소한으로.
- **배포 게이트**: 단위 + 브라우저 테스트 둘 다 통과해야 배포된다 (아래 참고).

### 빌드 / 타입체크

```bash
npm run typecheck       # tsc -b --noEmit
npm run build           # 타입체크 + vite build (predev/prebuild가 mathlive 폰트를 public/에 복사)
```

### 배포 확인

배포는 자동이라 로컬에서 실행할 명령은 없지만, push 후 상태 확인은 이렇게 한다
(이 환경엔 `gh` CLI가 없어 GitHub REST API로 폴링):

```bash
curl -s 'https://api.github.com/repos/<owner>/sikddalkak/actions/runs?per_page=1' \
  | grep -o '"status":"[a-z_]*"\|"conclusion":"[a-z_]*"' | head -2
```

main push → GitHub Actions(`npm test` → `playwright install` → `npm run test:browser`
→ `npm run build` → Pages 배포). 워크플로: `.github/workflows/deploy.yml`.
