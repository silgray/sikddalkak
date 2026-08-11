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
쓰지 않는다. **MathLive↔CE 경계는 오직 LaTeX 문자열만 건넌다** (`src/main.tsx`의
`MathfieldElement.computeEngine = null`, `src/editor/harness.ts` 참고).

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

### `src/algebra/` — 모양(shape) 기반 심볼릭 대수 (주 앱에 연결됨)

**`src/cellGraph.ts`/`src/cellEnv.ts`/`src/components/Cell.tsx` 가 이걸 쓴다** — 주 앱의
계산 코어.

만든 이유: 구 엔진(`src/engine/`, 제거됨)의 `transformSelection(latex, op)` 은 **문맥이
없어서** 심볼이 스칼라인지 행렬인지 모른다. 그래서 `ABA` 를 `A²B` 로 만드는 등 교환법칙을
잘못 적용한다. CE의 무타입 `Multiply` 위에 얹힌 구조라 우회로는 못 고친다.

⚠ **재구조화 진행 중** — 도메인 개념 단위로 폴더를 나누는 작업을 단계별로 하고 있다.
이름 규칙은 **폴더가 성격을 결정한다**: 자료를 담는 폴더는 파일명이 명사
(`literal/literal.ts`), 일을 하는 폴더는 동사(`parse/elaborate.ts`). 축약어는 안 쓴다.
아래 목록에서 아직 옮기지 않은 파일은 옛 이름 그대로다.

- **`shape/shape.ts`** — 모양 도메인. **모든 것이 `(rows, cols)` 이고 `(1,1)` 이 스칼라다.**
  벡터는 파생 술어. 이 한 선택으로 `v^Tv → 스칼라` 가 하드코딩 없이 나온다.
- **`literal/`** — 리터럴 도메인. 정규형이 깨지면 `exprKey` 가 흔들려 동류항 판정이 통째로
  무너지는 자리라, **정규형을 만드는 곳을 셋으로 나눠 각각 하나만 책임지게 했다.**
  - **`literal.ts`** — `Literal` 타입(정수/유리수/소수/복소수), 정규형을 스스로 강제하는
    생성자(`intLit`·`makeRational`), 술어(`isZero`·`asInteger`·`splitSign`…),
    지문(`literalKey`). `makeRational` 이 여기 있는 이유: 코덱의 `Rational` 경로와
    산술의 빠른 경로가 **둘 다** 써서, 두 곳이 같은 정규형을 내야 한다.
  - **`ceJson.ts`** — 리터럴 ↔ CE MathJSON 코덱. **CE 인스턴스가 없다** — 순수 번역이다.
    `fromCeJson` 이 리터럴이 생기는 유일한 문(門)이라 정규형 판정이 전부 여기 모인다.
    행렬도 자기 코덱을 따로 갖는다(`transform/matrixFold.ts`) — **각 도메인이 자기 타입의
    코덱을 갖는다**는 규칙.
  - **`arith.ts`** — 산술(`addLit`·`mulLit`·`divideByInt`·`recipLit`·`powLit`).
    정확한 유리·복소 산술은 CE에 위임하되, 정수·유리수 구간은 JS 빠른 경로로 먼저 친다
    (CE 왕복 ≈16µs 인데 `normalize` 가 곱마다 부른다). 실패는 `null` — 호출자는 접지 말고
    원래 트리를 유지한다.
- **`types-SyntaxNode.ts`** — Syntax IR 타입. `·`/`×`/병치를 **구분해 보존**한다
  (CE는 셋 다 `Multiply` 로 뭉갠다). 어느 쪽이 내적/스칼라곱인지는 이 층에서 안 정한다
  (그건 elaborate 몫).
- **`expr/`** — Typed IR 도메인.
  - **`node.ts`** — `TypedExpr` / `Env` / `FunctionDef` 타입.
  - **`builders.ts`** — **스마트 생성자.** 노드를 만들면서 모양 검사를 같이 한다
    (`buildMul`·`buildAdd`·`buildFrac`·`buildTranspose`·`buildDeriv`…).
    `elaborate` 와 재작성이 **같은 함수**를 쓴다 — 조립 규칙이 두 벌이면 모양·연산
    판정이 어긋난다. 덕분에 재작성이 만든 트리도 자동으로 검사된다.
    ⚠ **이 파일은 잎이다** — import 가 `shape/`·`result/`·`expr/node` 셋뿐이어야 한다
    (`Env` 도 `SyntaxNode` 도 모른다). 넷째가 붙었다면 여기 있으면 안 되는 코드가
    섞여 들어온 것이다.
  - **`traversal.ts`** — `mapChildren`. 자식에 `f` 를 적용하고 **빌더로 다시 조립**한다.
    재작성이 모양을 깨뜨리면 조립 단계에서 오류가 나므로 잘못된 트리가 조용히 못 빠져나간다.
    빌더 10개를 전부 쓰기 때문에 `transform/` 이 아니라 여기 있다.
  - **`key.ts`** — `exprKey`(구조 지문, **단사여야 한다**)와 `constantInteger`.
    동류항 판정·치환 고정점·캐시 지문이 전부 이 키 위에서 돈다. 다항식과 무관한
    범용 유틸이라 `normal.ts` 에서 떼어냈다.
- **`preprocess.ts`** / **`parseSymbol.ts`** / **`translateToTree.ts`** — CE 프런트엔드.
  `preprocess`가 `\cdot`/`\times` 를 마커 심볼로 바꿔 CE 파싱에서 살아남게 하고
  (CE는 파싱하면서 뭉개버린다, 실측), `parseSymbol`이 축소 정규화 폼(`Number`만)으로
  CE에 파싱을 맡긴 뒤, `translateToTree`가 그 MathJSON을 Syntax IR로 번역한다(우선순위
  후위 > 병치 > `·`/`×` > `+`, **모호성 → 오류** 판정 포함). CE quirk 우회는 이 세
  파일 안에 갇힌다. `parseCeJson`(=`translateToTree`)은 재작성이 CE 결과를 되받을 때도 쓴다.
- **`elaborate.ts`** — **설계의 심장.** 연산자 해석 + 차원 검사 + 모양 계산을 **한 패스로**
  한다 (`·` 가 내적인지 스칼라곱인지는 모양을 알아야 정해지고, 결과 모양은 연산자가
  정해져야 나오는 상호 의존이라 나눌 수 없다). 단 **노드를 실제로 만들고 모양을 검사하는
  일은 `expr/builders.ts` 몫이고**, 여기 남는 건 Syntax 를 보고 어느 빌더를 부를지 정하는
  부분과 그러려면 `Env` 가 있어야 하는 것들(사용자 정의 함수 판정, 바운드 변수)이다.
  정규화는 하지 않는다 — 곱을 둘씩만 중첩해서 담아둔다 (`normalize.ts` 몫). `\frac{p}{q}` 는 `p·q^{-1}` 로 풀어버리지 않고
  전용 `frac` 노드로 남긴다 — 그래야 `\frac{x^2+2x+1}{x+1}` 이 원문 형태로 렌더된다.
  **`apply`(사용자 정의 함수 호출) 도 여기서 해소한다** — `name(args)` 가 함수 적용인지
  곱(행렬곱)인지는 `env.functions` 를 봐야 아는데, 그건 elaborate만 갖고 있다(`cdot`/
  `juxt` 판정과 같은 이유). 함수면 `instantiateFunction` 이 매개변수에 **그 호출의
  실제 인수 모양**을 걸고 본문을 다시 elaborate한다(모양 다형 — `f(x)=x^2` 는 인수가
  스칼라면 스칼라, 정사각 행렬이면 그 행렬 거듭제곱, 그 밖엔 오류). 아니면 병치로
  되돌려 기존 행렬곱 해석에 맡긴다(§아래 실측 함정의 `tightPostfix`도 이 언저리).
- **`normalize.ts`** — elaborate 직후에 도는 별도 정규화 패스. 평탄화·스칼라 호이스팅·
  `neg`/숫자 접기·정렬·항등원 제거. **이웃 인수를 거듭제곱으로 자동으로 접지는 않는다**
  (`AA` 는 `AA` 로 남는다) — 사용자가 쓴 곱의 모양을 임의로 바꾸지 않는다는 결정.
- **`opers.ts`** — 대수 성질 **표**(교환/결합/분배). 코드 분기가 아니라 데이터.
- **`normal.ts`** — 다항식 정규형. 단항식 = (수치 계수, 스칼라 인수 **집합**,
  비스칼라 인수 **열**). 비스칼라 열의 순서를 지키는 게 비가환을 지키는 지점.
  (구조 지문 `exprKey` 는 여기 있었지만 다항식과 무관해서 `expr/key.ts` 로 옮겼다.)
- **`rewrite.ts`** — expand/simplify/factor/substitute. **순수 스칼라 부분식만** CE에 위임.
- **`render.ts`** — Typed IR → LaTeX. 계약은 **렌더 멱등성**(낸 걸 다시 읽어 또 내면 같다).
  **이 파일엔 CE가 없다** — 잎 심볼 이름 사전만 `ce/symbolName.ts` 에 위임한다.
- **`numeric.ts`** — 수치 평가기. 재작성 전후 값 대조 **전용**(역행렬은 일부러 뺐다).
- **`debug.ts`** — Syntax/Typed IR → 사람이 읽는 s-식. 테스트 기대값과 랩 진단 패널이 공유.
- **`ce/`** — CE와 말 섞는 **공통 규약**만. 실제로 CE에 뭘 시키는 코드(분수 산술·정리·
  미적분·역행렬)와 자기 타입의 MathJSON 코덱은 각 도메인에 남는다.
  - **`engine.ts`** — 인스턴스를 얻는 **유일한 창구**. `new ComputeEngine()` 이 이 파일
    밖에 있으면 안 된다. 버전 격리 규칙의 근거도 여기. 자유 함수(`expand`/`factor`/
    `simplify`)가 도는 **기본 엔진**은 `defaultEngine()` 이 준다 — 상한을 거기 걸어야
    해서다.
  - **`budget.ts`** — CE 호출의 **시간 예산**. 바깥 진입점(`evaluate`/`transform`)이 예산을
    한 번 깔고(`withCeBudget`) 안쪽 CE 호출들이 나눠 쓴다(`guardCe`). 호출당이 아니라
    연산당인 게 요점 — 원소별 적분처럼 CE를 n번 부르는 경로에서 상한이 n배로 불어나면 안 된다.
  - **`symbolName.ts`** — 심볼 이름 → LaTeX(`Pi`→`\pi`). CE를 **사전으로만** 쓰는 자리.
- **`transform/functions.ts`** — `evaluate` 의 한 단계. `apply` 노드를 실제 값으로 편다
  (`foldCalculus`와 같은 규율: 인수를 먼저 완전히 계산 → 함수 정의를 그 값으로 인스턴스화
  → 재귀 `evaluate`). 실패하면 원래 `apply` 노드를 그대로 돌려준다. `foldMatrices` 보다
  **먼저** 돈다 — `A·f(x)` 에서 `f(x)` 가 행렬 리터럴로 펴져야 `foldMatrices` 가 이웃과
  묶을 수 있다.
- **`result/result.ts`** — `Result<T>` / `AlgebraError` 등 공용 결과 타입과 생성자
  (`ok`/`fail`/`failWith`/`all`).
- **`index.ts`** — 공개 API (`parse`/`transform`/`buildEnv`/`analyze`/`solveFor` 자리).

⚠ **CE 0.90 실측 함정** (전부 테스트에 핀으로 고정돼 있다):
- `Add`/`Power` 정규화 폼은 항을 재배열하고 `A^{-1}` 을 `\frac{1}{A}` 로 바꾼다 → `Number` 만 쓴다
- 이름 + 괄호(`f(v)`, 홑 대문자만이 아니라 소문자·첨자도)를 **`apply` 후보로 옮긴다** —
  함수인지 곱(행렬곱)인지는 `elaborate` 가 `env.functions` 를 보고 정한다(§사용자 정의
  함수). `\begin{pmatrix}...\end{pmatrix}` 는 `\left(\right)` 로 감싸도 그 델리미터를
  CE가 흡수해버려(실측) `Matrix` 노드가 바로 오므로 `Delimiter` 뿐 아니라 `Matrix` 도
  적용 후보로 받는다.
- **후위(`^n`,`^T`)가 이름+괄호 바로 뒤에 붙는지, 아니면 사용자가 한 번 더 괄호를 쳤는지에
  따라 CE JSON 모양이 달라진다**(실측: `f(x)^2` 는 `Power` 가 곱셈 인수열 안쪽에, 반면
  `(f(x))^2` 는 `Power` 가 그 바깥의 `Delimiter` 를 잡는다) — 그런데 `translateToTree`
  를 거치면 **똑같은** `pow(apply(...), exp)` 꼴이 되어 이 구분이 사라진다. 함수가
  아닐 때 후위가 어디로 가야 하는지(마지막 인수 안 vs 전체를 감쌈, 설계 §3)가 이 구분에
  달려 있어서, `pow` Syntax 노드에 `tightPostfix` 필드로 남겨둔다(퍼즈가 잡음).
- **`.latex` 직렬화에 버그가 있다** — `Power(Divide(X,a),2)` → `\frac{1}{a}(X)^2` 로 지수 범위가
  바뀐다. 그래서 CE 결과는 **MathJSON으로 받는다**
- **심볼릭 적분이 안 끝나는 입력이 있다** — `\int_{-\pi}^{\pi}\frac{1}{2}e^{3x}\sin(2x)dx` 는
  `.evaluate()` 에서 안 돌아온다 (`e^{x}` 면 111ms). 우리 호출은 전부 동기라 곧 앱 프리즈다 →
  `ceLimit.ts` 가 시간 예산을 걸고, 걸리면 미평가로 남긴다

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
  드래그 재정렬. `evaluateCells`(`src/cellGraph.ts`) 호출 지점.
- **`Cell.tsx`** — 셀 하나 (입력행 + 결과행). 선택 추적, 변환 버튼, 구분 기호 툴바.
- **`MathField.tsx`** — `<math-field>` React 래퍼. **UI↔에디터 경계.** input마다
  `repairLatex` 게이트, selection-change마다 `normalizeSelection` 게이트,
  keydown을 `dispatchKeyOp`로. uncontrolled(`new MathfieldElement()`).
- **`SelectionToolbar.tsx`** — 행렬 통째 선택 시 뜨는 구분 기호 플로팅 툴바.
- **`HelpPanel.tsx`** / **`TabBar.tsx`** — 도움말 패널, 탭 바.
- **`App.tsx`** / **`main.tsx`** — 진입점. main.tsx에서 MathLive 전역 설정
  (폰트/로케일/CE 비활성화).

### `src/algebra/test` — 개발자 테스트

 - 정리된 꼴이 쓸 만한가를 사람이 눈으로 판단. 건들지 말것.
 - vitest 스위트가 아니라 **눈으로 보는 랩**이다 (`npm run algebra-test`, localhost:5175).
 - **`tsconfig.json` 의 `exclude` 로 타입체크에서 빠져 있다** — 실험 중인 코드라
   미사용 import 같은 게 `npm run build` 를 막지 않게. 랩은 vite/esbuild로 도므로
   제외돼도 그대로 뜬다. 여기 타입을 확인하고 싶으면 그 줄만 잠깐 빼고 돌리면 된다.

### 기타

- **`cellGraph.ts`** — 셀 사이 층. 이름 기반 의존성 그래프로 `src/algebra` 를 셀 목록에
  얹는다. 위상정렬은 순환 감지·캐시 지문 전파 전용, 실제 계산은 algebra의
  `substituteDeep`/`evaluate`. `evaluateCells`가
  결과와 선택 변환용 `Env` 를 한 번에 돌려준다. **함수 정의 셀**(`f(x)=x^2`)도 같은
  `defName` 필드를 쓰므로(매개변수는 `params`) 변수와 **한 이름 공간**을 자동으로
  공유한다 — 중복 정의 판정에 분기가 안 늘어난다. 매개변수 이름이 워크스페이스의 다른
  정의와 겹치면 오류, 서로 다른 함수끼리는 겹쳐도 된다. 함수 정의 셀의 결과 행은
  **계산하지 않고 본문을 그대로 되뇐다**(`computeFunctionNode`) — 인수가 없어 모양을
  모르니 계산할 수가 없다(모양 다형, `elaborate.ts` 참고).
- **`cellEnv.ts`** — 정의 판정(`splitDefinition`: `a=3` 의 좌변/우변 분리,
  `splitFunctionDefinition`: `f(x)=x^2` 의 이름/매개변수/우변 분리)과 `Env` 조립
  (`buildCellEnv`, algebra의 `buildEnv` 얇은 재노출 — 이제 `functions` 도 받는다).
  그래프 구성 자체는 안 한다 — 그건 `cellGraph.ts` 몫.
- **`types.ts`** — `FormulaObject`(정본), `EvalResult`, `CellMode` 등 공용 타입.
- **`styles.css`** — 전역 CSS (라이트/다크 자동, CSS 변수).
- **`scripts/copy-mathlive-assets.mjs`** — 빌드 전 MathLive 폰트를 public으로 복사.

## UI ↔ 계산 경계

- **UI(components)는 계산을 모른다.** `CellStack`이 `evaluateCells`(`cellGraph.ts`)에
  오브젝트 목록을 넘기고 `{results, env}`를 받는다. 엔진은 React·DOM에 의존하지 않는
  순수 함수.
- **문서 정본은 LaTeX 문자열.** 편집 중인 draft는 mathfield DOM 안에만 있고,
  디바운스/blur/Enter 시점에 `onEdit`으로 문서에 flush된다.
- **에디터 레이어(editor/)가 MathLive와 계산 사이의 완충.** 파손된 LaTeX이
  문서·계산으로 새지 않게 게이트가 교정한다.

## 상태 관리 방식

- **전역**: `workspaceReducer` 하나뿐. 탭·문서·실행취소·포커스 전부 여기. (`useReducer`)
- **로컬**: 컴포넌트별 UI 상태만 (선택 영역, 드래그, 도움말 열림 등 `useState`).
- **파생값**: 계산 결과는 상태가 아니라 `useMemo(evaluateCells)` — 엔진 캐시가 담당.

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
