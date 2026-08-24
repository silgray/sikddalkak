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

**이름 규칙** (7단계에서 확정, 어휘표는 `.claude/.glossary.txt`):

- **폴더가 성격을 결정한다** — 자료를 담는 폴더는 파일명이 명사(`literal/literal.ts`),
  일을 하는 폴더는 동사(`normalize/normalize.ts`). 폴더의 **주연 파일은 폴더명을
  되풀이해도 된다**.
- **축약어는 이 도메인에서 통하면 그대로 쓴다** — `mat`·`poly`·`mono`·`lit`·`eval`·
  `oper`·`expr`·`env`·`args`·`params`·`vars`·`Dim`. 뜻이 바로 안 통하는 것만 푼다
  (`recip` → `reciprocal`). 단 **폴더 이름은 풀네임**이다(`expression/`) — 폴더는
  식별자가 아니라 경로로 읽히는 자리라서다.
- **함수는 동사로 시작**한다. 예외는 일곱 가족뿐: `is*`/`can*`(술어),
  `to*`/`from*`(코덱 짝), `as*`(타입 좁히기), `*Of`(파생값 뽑기), `*Key`(지문),
  순수 명사(상수·값 생성), `with*`(덧씌운 스코프).
- **한 단어는 한 가지만 가리킨다** — `factor`=곱의 인수 또는 인수분해,
  `literal`=정확한 수, `numeric`=JS 부동소수점, `matrix`=진짜 행렬 리터럴,
  `scalar`/`nonScalar`=모양이 `(1,1)`인 것/그 밖. `constant`·`callee` 는 안 쓴다.

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
- **`expression/`** — Typed IR 도메인.
  - **`node.ts`** — `TypedExpr` / `Env` / `FunctionDef` 타입.
  - **`builders.ts`** — **스마트 생성자.** 노드를 만들면서 모양 검사를 같이 한다
    (`buildMul`·`buildAdd`·`buildFrac`·`buildTranspose`·`buildDeriv`…).
    `elaborate` 와 재작성이 **같은 함수**를 쓴다 — 조립 규칙이 두 벌이면 모양·연산
    판정이 어긋난다. 덕분에 재작성이 만든 트리도 자동으로 검사된다.
    ⚠ **이 파일은 잎이다** — import 가 `shape/`·`result/`·`expression/node` 셋뿐이어야 한다
    (`Env` 도 `SyntaxNode` 도 모른다). 넷째가 붙었다면 여기 있으면 안 되는 코드가
    섞여 들어온 것이다.
  - **`traversal.ts`** — `mapChildren`. 자식에 `f` 를 적용하고 **빌더로 다시 조립**한다.
    재작성이 모양을 깨뜨리면 조립 단계에서 오류가 나므로 잘못된 트리가 조용히 못 빠져나간다.
    빌더 10개를 전부 쓰기 때문에 `transform/` 이 아니라 여기 있다.
  - **`key.ts`** — `exprKey`(구조 지문, **단사여야 한다**)와 `asKnownInteger`.
    동류항 판정·치환 고정점·캐시 지문이 전부 이 키 위에서 돈다. 다항식과 무관한
    범용 유틸이라 다항식 쪽에서 떼어냈다.
    `compareExpr` 는 같은 지문을 **문자열을 만들지 않고** 비교하는 짝이다 —
    `sortScalars`(여기)와 `normalize.ts` 의 `sortTerms` 가 정렬에 쓴다. **불변식:
    `compareExpr(a,b)===0 ⟺ exprKey(a)===exprKey(b)`**(`key.test.ts` 가 무작위로 대조한다).
    순서 자체(부호)까지 `exprKey` 사전순과 같을 필요는 없다 — "같다" 판정만 일치하면 된다.
- **`parse/`** — LaTeX → Syntax IR → Typed IR. **입력을 해석하는 코드가 전부 여기 있다.**
  둘로 갈려 있던 `syntax/`·`elaborate/` 를 합친 폴더다 — 공개 `parse()`(`index.ts`)가
  `parseSyntax` → `elaborate` → `normalize` 를 한 줄로 부르는 데서 보듯 앞의 둘은 늘
  한 세트로 돈다.
  - **`node.ts`** — Syntax IR 타입. `·`/`×`/병치를 **구분해 보존**한다 (CE는 셋 다
    `Multiply` 로 뭉갠다). 어느 쪽이 내적/스칼라곱인지는 이 층에서 안 정한다 (그건
    elaborate 몫).
  - **`preprocess.ts`** / **`parse.ts`** / **`translate.ts`** — CE 프런트엔드.
    `preprocess` 가 `\cdot`/`\times` 를 마커 심볼로 바꿔 CE 파싱에서 살아남게 하고
    (CE는 파싱하면서 뭉개버린다, 실측), `parse.ts` 의 `parseSyntax` 가 축소 정규화 폼
    (`Number` 만)으로 CE에 파싱을 맡긴 뒤, `translate.ts` 의 `translateToTree` 가 그
    MathJSON을 Syntax IR로 번역한다(우선순위 후위 > 병치 > `·`/`×` > `+`, **모호성 →
    오류** 판정 포함). **CE quirk 우회는 이 세 파일 안에 갇힌다.**
    `parseCeJson`(=`translateToTree`)은 재작성이 CE 결과를 되받을 때도 쓴다.
  - **`elaborate.ts`** — **설계의 심장.** 연산자 해석 + 차원 검사 + 모양 계산을 **한 패스로**
    한다 (`·` 가 내적인지 스칼라곱인지는 모양을 알아야 정해지고, 결과 모양은 연산자가
    정해져야 나오는 상호 의존이라 나눌 수 없다). 단 **노드를 실제로 만들고 모양을 검사하는
    일은 `expression/builders.ts` 몫이고**, 여기 남는 건 Syntax 를 보고 어느 빌더를 부를지 정하는
    부분과 그러려면 `Env` 가 있어야 하는 것들(사용자 정의 함수 판정, 바운드 변수)이다.
    정규화는 하지 않는다 — 곱을 둘씩만 중첩해서 담아둔다 (`normalize.ts` 몫). `\frac{p}{q}` 는 `p·q^{-1}` 로 풀어버리지 않고
    전용 `frac` 노드로 남긴다 — 그래야 `\frac{x^2+2x+1}{x+1}` 이 원문 형태로 렌더된다.
    **`apply`(사용자 정의 함수 호출) 도 여기서 해소한다** — `name(args)` 가 함수 적용인지
    곱(행렬곱)인지는 `env.functions` 를 봐야 아는데, 그건 elaborate만 갖고 있다(`cdot`/
    `juxt` 판정과 같은 이유). 함수면 `instantiateFunction` 이 매개변수에 **그 호출의
    실제 인수 모양**을 걸고 본문을 다시 elaborate한다(모양 다형 — `f(x)=x^2` 는 인수가
    스칼라면 스칼라, 정사각 행렬이면 그 행렬 거듭제곱, 그 밖엔 오류). 아니면 병치로
    되돌려 기존 행렬곱 해석에 맡긴다(§아래 실측 함정의 `tightPostfix`도 이 언저리).

    ⚠ **`apply` 처리를 별도 파일로 떼지 말 것.** 순환 import 가 된다 —
    `instantiateFunction`/`elaborateApplyNode`/`elaboratePowOverApply` 가 `elaborate` 와
    `elaboratePow` 를 부르고, `elaborate` 본체는 반대로 그 셋을 부른다. 파일을 잘못 가른
    게 아니라 알고리즘 자체가 상호 재귀다(모양 다형이라 본문을 호출부마다 다시 elaborate
    해야 하는 데서 나온다).
- **`normalize/`** — elaborate 직후에 도는 별도 정규화 패스. 평탄화·스칼라 호이스팅·
  `neg`/숫자 접기·정렬·항등원 제거, 그리고 **거듭제곱 접기**(`AA`→`A²`, 항상 켜져 있다).
  분배는 **하지 않는다** — `(A+B)C+(A+B)C` 는 `2(A+B)C` 로 남는다.
  ⚠ 여기서 말하는 "정렬" 은 **노드 동일성용 정규 순서**뿐이다(`compareExpr`, 같은 값이면
  같은 트리가 나오게 하는 것 — 동류항 판정·캐시 지문이 이 위에 걸려 있다). **사람이 읽기
  좋은 순서**(상수는 뒤로, 무거운 항 먼저 같은 규칙)는 `transform/prettify.ts` 로 뺐다 —
  출력 한 번에만 필요한 값을 정규화가 도는 내내 모든 부분식마다 치를 이유가 없어서다.
  - **`normalize.ts`** — 디스패처. 케이스 16개지만 성격이 여섯이라 덩치 큰 둘을 뺐고,
    짧은 넷(덧셈·모양 연산·거듭제곱·잎/불투명)만 여기 남았다.
  - **`product.ts`** — 곱 계열. `toMonomial` 이 곱을 (계수, 스칼라들, 비스칼라들)로 **분해**한다.
    조립하는 `fromMonomial` 은 `polynomial/convert.ts` 에 있다 — `Monomial` 이 다항식의
    타입이고 다항식 경로(`fromPolynomial`)도 **같은 조립기**를 쓰기 때문이다. 이 짝은
    `toPolynomial`↔`fromPolynomial` 과 같은 코덱 가족이다.
  - **`frac.ts`** — 유리수 접기와 역수 하강.
    덧셈(동류항 합치기·항 정렬)은 `normalize.ts` 안에 있다 — 자식이 이미 정규화됐다는
    걸 쓰면 `toMonomial`+`combineLikeTerms`+`fromMonomial` 로 끝나서 파일을 나눌 만큼
    크지 않다. (예전엔 `add.ts` 가 따로 있었고, 다항식으로 왕복하느라 그만큼 컸다.)

  ⚠ **핸들러는 `normalize` 를 import 하지 않는다.** 자식 재귀가 필요하면 `recur` 를 인자로
  받는다 — 그래야 `normalize ↔ product` 순환이 안 생긴다. (`parse/` 의 `apply` 를 못
  떼어낸 것과 갈리는 지점: 저쪽은 공개 시그니처라 인자를 못 늘렸다.)
- **`opers.ts`** — 대수 성질 **표**(교환/결합/분배). 코드 분기가 아니라 데이터.
- **`polynomial/`** — 다항식 정규형. 단항식 = (수치 계수, 스칼라 인수 **집합**,
  비스칼라 인수 **열**). 비스칼라 열의 순서를 지키는 게 비가환을 지키는 지점.
  `polynomial.ts`(타입·`polyMul`) / `convert.ts`(`toPolynomial`↔`fromPolynomial` 왕복,
  그리고 **단항식 조립기 `fromMonomial`** — 정규화도 이걸 쓴다) /
  `combine.ts`(동류항·숫자 합치기).
  `fromMonomial` 의 `foldPowers` 가 두 경로를 가른다: 정규화는 `true`(`AA`→`A²`),
  다항식은 `false`(인수분해가 `x^2` 을 `[x, x]` 로 흩어진 채 봐야 한다).
  ⚠ **평탄 조립은 인수 열 안의 스칼라 접힘을 못 본다** — `r u r`(`r`=(1,3), `u`=(3,1))은
  앞 두 개가 (1,1)로 접히는데 `matMul(r,u,r)` 로 이으면 렌더 `rur` 이 `(ru)r` 로 다시
  읽혀 트리가 갈라진다. `splitScalarRuns` 가 조립 전에 그 구간을 끊는다.
  **`normalize/product.ts` 도 같은 `Monomial` 타입을 쓴다** — 곱 하나를 셋으로 가르는 일이
  단항식과 정확히 같은 모양이라, 예전엔 `Collected` 라는 쌍둥이 타입이 따로 있었다.
  다만 `toMonomial` 이 주는 `scalars` 는 **정렬 전**이다(`monomialKey` 를 뽑기 전에 정렬해야
  한다 — `Monomial` 문서의 경고).
- **`transform/`** — expand/simplify/factor/substitute. **순수 스칼라 부분식만** CE에 위임.
  연산마다 파일 하나다 — `expand.ts` / `simplify.ts` / `factor.ts`(공통인수 추출이라
  혼자 300줄이다) / `substitute.ts`.
  - **`prettify.ts`** / **`prettifyOrder.ts`** — 사람이 읽기 좋게 `add`/`scalarMul` 항을
    재정렬하는 별도 패스(`normalize/` 의 정렬과 다르다, 위 `normalize/` 항목 참고).
    **아직 아무 호출부에도 안 붙는다** — 자리만 마련해 둔 것이고, `expand`/`simplify`/
    `factor`/`evaluate` 뒤에 붙이는 배선은 다음 판이다. 정렬 기준(`prettifyOrder.ts`)도
    `src/algebra/test/` 랩에서 계속 다듬는 실험 중인 코드다.
  - **`delegate.ts`** — 셋이 함께 쓰는 **CE 위임 경계**. 통째로 넘겨도 되는지 보는
    `isPureScalar`, 왕복하는 `viaCe`, 다항식에서 계수만 골라 넘기는 `refineScalars`.
    `viaCe` 의 `fold` 인자가 expand/simplify(`true`)와 factor(`false`)를 가른다 —
    묶어서 넘기면 인수분해가 뽑아야 할 공통 인수가 블록 안에 갇힌다.
  - **`solve.ts`** — `solveFor(e, symbol, env)`. `e` 는 이미 `lhs - rhs` 로 접힌 식이다 —
    `=` 를 아는 IR 노드가 없어서(등식은 `cellGraph.ts` 층에만 있다) "이 식이 0" 이라는
    스칼라 식 하나만 받는다. `isPureScalar` 로 게이트하고 CE의 `solve` 자유 함수에
    위임한다(`viaCe` 와 같은 규율 — `render()` 로 LaTeX을 만들어 `{strict:true}` 로
    넘기고 MathJSON으로 받는다). **수식이냐 수치냐는 안 가른다** — 호출자가
    `substituteDeep` 로 정의된 심볼을 먼저 다 먹인 뒤 부르면 CE가 남은 심볼에 따라
    알아서 고른다(`ax=b`→수식, 전부 리터럴이면 수치, 닫힌 형이 없으면 근 찾기로 폴백).
    ⚠ **CE 0.90 실측 함정**: `.d.ts` 는 `solve()` 가 순수 MathJSON 배열을 준다고 적어놨지만
    실제로는 **`BoxedExpression` 인스턴스**를 준다 — `.json` 접근자로 한 번 더 벗겨야
    한다(`delegate.ts` 의 `result.json` 과 같은 이유, `.d.ts` 를 믿지 말 것).
    ⚠ **지금은 `src/features.ts` 의 `SOLVE_ENABLED=false` 로 꺼져 있다** — CE 0.90이
    닫힌 형 없는 초월식(`\cos(x)=x` 등)을 못 풀고(빈 배열), 뉴턴 시작점을 넘길 API도
    없어서다(아래 CE 실측 함정 목록 참고). 이 파일과 `cellGraph.ts`/`Cell.tsx` 의 등식
    플러밍(상태·영속·UI)은 그대로 살아 있다 — 더 나은 엔진을 찾으면 플래그만 뒤집으면 된다.
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
- **`index.ts`** — 공개 API (`parse`/`transform`/`buildEnv`/`analyze`, `solveFor` 는
  `transform/solve.ts` 재노출).

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
- **수치 근찾기(뉴턴/이분법)가 아예 없다** — `dist/types` 와 번들 JS를 다 뒤져도
  `nsolve`/`FindRoot`/`newton`/`bisect`/`initialGuess`/`x0`/`maxIterations` 류 식별자가
  하나도 없다. `solve()` 의 옵션은 `{strict?}` 뿐이라 **뉴턴 시작점을 넘길 자리 자체가
  없다**. 있는 수치 루틴(`durandKernerRoots`/`realPolynomialRoots`)은 다항식 전용이고
  자체 시작(self-starting)이라 시드를 안 받는다. 다항식은 실근을 **전부** 주지만
  (`x^3-6x^2+11x-6=0` → `[1,2,3]`, 실측), **닫힌 형이 없는 초월식은 근을 하나만 주는
  게 아니라 빈 배열**이다(`\cos(x)=x`, `xe^x=3`, `\ln(x)+x=5` 전부 `[]`, 실측) — 공학용
  계산기가 시드를 받는 게 바로 이 구간이다. 대신 `Solve(eq, ["Element", x,
  ["Interval", a, b]])` 는 **주기함수(sin/cos/tan 계열)의 근을 그 구간 안에서 전부**
  확장해 준다(실측: `\sin(x)=1/2` 에 `[0,20]` 을 주면 근 7개) — 수치해석이 아니라 CE의
  네이티브 기능이라 시드 없이도 된다. 단 `\cos(x)=x` 는 구간을 줘도 그대로 미평가로
  남는다. `src/algebra/transform/solve.ts` 는 이 한계 때문에 `SOLVE_ENABLED=false`
  로 꺼둔 상태다.

### `src/editor/` — MathLive 경계 레이어 (구조 안전성)

MathLive의 quirk를 흡수하고 "항상 정상 구조"를 강제하는 곳. **버전 업 시 재확인 지점.**

- **`internals.ts`** — MathLive 내부 API 접근 **단일 창구** (model, 숏컷 버퍼
  flush, dispose-포커스 크래시 패치, 콘텐츠 상자 `contentOf`, 원자 상자 캐시 비우기
  `clearAtomBoundsCache`, 히트테스트 `resolveOffsetAt`). 전부 try/catch 방어.
- **`latexScan.ts`** — 위치 붙은 LaTeX 토큰/그룹 스캐너. 재직렬화 없이 원본에
  대한 `Splice`만 만든다 (손대지 않은 부분은 바이트 보존).
- **`rules.ts`** — 구조 규칙 **레지스트리** (데이터). `{id, find, fix, examples}`.
  밑 없는 첨자·짝 없는 괄호·빈 첨자·평평한 괄호 통일 등. `repairLatex`(고정점 반복,
  멱등), `findViolations`. **규칙 추가 = 항목 하나 + 예시 몇 줄.**
- **`keyOps.ts`** — 키 연산 **레지스트리** (데이터). `{id, when, run, scenarios}`.
  파손을 애초에 막는 예방 층 — 괄호 쌍 생성/제거, 밑 없는 `^`/`_` 차단, 첨자 강등.
- **`selection.ts`** — 선택을 "한 레벨 연속 형제 열"로 강제. `normalizeSelection`
  (게이트), shift+화살표·Ctrl+D 확장 로직, 그리고 **형제 열 스냅 두 짝**:
  - **`siblingRunRange`** — [a,b]를 **포함하는** 최소 형제 열(양끝 확장).
    `normalizeSelection` 전용이다. MathLive가 만든 선택까지 이 게이트를 지나므로
    **절대 좁히면 안 된다** — 좁히면 게이트가 멀쩡한 선택을 지운다.
  - **`caretRunRange`** — 손가락이 만든 선택의 **파생**용. 최소 공통 부모까지는
    같고 **끝만 안쪽으로 당긴다**: 끝 캐럿이 어떤 자식 *안*이면 그 자식을 뺀다.
    시작은 여전히 바깥으로 넓히는 **비대칭이 의도**다 — 양끝을 다 당기면 "온전히
    들어온 자식이 없는" 상태가 잦아져 드래그 중 선택이 깜빡인다. 당긴 결과가
    시작을 넘어 아무 것도 안 남으면 **그 끝만 확장으로 되돌린다**(순수 폴백).
    ⚠ 결과가 `siblingRunRange` 를 **멱등하게** 통과해야 게이트가 도로 안 넓힌다 —
    첨자(subsup) 보정을 양쪽이 같이 갖는 이유가 이것이다.

    두 함수는 사설 `runRange(…, shrinkEnd)` 한 벌을 공유한다. ⚠ 구조가 식 **맨
    앞**에 있으면 둘의 결과가 같다(당길 자리가 없다, 실측) — 차이는 그 구조 앞에
    온전한 형제가 있을 때만 드러나므로 테스트도 `d+\frac{a}{bc}` 쪽을 쓴다.
- **`rawSelection.ts`** — **원시 캐럿** 두 개를 필드별로 기억한다(`WeakMap`).
  화면에 보이는 `mf.selection` 은 이 둘에서 `caretRunRange` 로 **파생**된 값일
  뿐이다 — 홀드 드래그로 상위 구조까지 스냅된 뒤에도, 원시 좌표를 따로 쥐고
  있으면 손가락을 되돌렸을 때 다시 좁아진다
  (스냅 **결과**를 다음 조작의 출발점으로 삼으면 못 되돌린다). `setRawSelection`
  이 유일한 쓰기 창구고, `rawSelection` 은 다른 경로(타이핑·Ctrl+D·팔레트·탭)가
  선택을 바꿔 캐시가 낡았으면 지금 보이는 범위로 조용히 씨를 다시 뿌린다.
  `touchGesture.ts` 의 홀드 드래그와 `SelectionHandles.tsx` 의 핸들 드래그
  둘 다 이걸 거친다. 두 캐럿의 **순서는 안 가린다** — 핸들이 반대쪽을 넘어가면
  그대로 넘겨도 되고, 넘어간 쪽이 새 시작이 된다.
- **`touchAim.ts`** — **손가락 좌표 → 히트테스트 좌표** 보정. 히트테스트
  (`resolveOffsetAt`)는 넘긴 점이 곧 찍고 싶은 자리라고 믿는데, 그게 참인 건
  **손가락으로 내용을 직접 짚는 손짓뿐**이다. 손짓마다 다른 그 차이를 값
  하나(`TouchAim`)로 굳혀 둔다 — 보정 규칙이 히트테스트 안으로 새어 들어가지
  않게 하려는 것이다(`resolveOffsetAt` 은 "이 점" 만 안다).
  - **`DIRECT_AIM`** — 보정 없음. **홀드 선택**(`touchGesture.ts`)이 쓴다. 손가락이
    내용을 직접 가리키는 손짓이라 어긋날 게 없고, 보정을 넣으면 짚은 자리와
    선택이 벌어져 그 자체가 버그다.
  - **`gripAim(fingerY, referenceY)`** — **손잡이 드래그**(`SelectionHandles.tsx`)가
    쓴다. 물방울 손잡이는 선택 줄 **아래**에 매달려 있어 손가락이 짚고 싶은
    글자보다 한참 밑이다. 쥔 **그 순간** 손가락↔선택 줄 한가운데 거리를 한 번
    재서 손짓 내내 그만큼 올려 판정한다. **고정 px 이 아닌 게 요점** — 글꼴
    크기·분수 높이가 바뀌면 상수는 곧바로 틀린다. 상대 이동도 보존되므로
    (`①` 쥔 순간은 정확히 기준선, `②` 이후 세로 이동은 1:1) 분수의 분자/분모를
    손잡이로도 넘나들 수 있다.
  ⚠ **클램프(`contentBox`)는 보정 뒤에 와야 한다** — 순서가 바뀌면 올려놓은
  판정점이 다시 상자 밖으로 나간다.
  ⚠ 한 줄짜리 식으로는 이 보정을 **테스트할 수 없다** — 콘텐츠 상자가 줄에 딱
  붙어 있어 클램프가 y를 도로 줄 안으로 끌어와 보정이 없어도 같은 답이 나온다.
  분수처럼 상자가 높은 식을 써야 답이 갈린다(`selectionHandles.browser.test.tsx`).
  손짓을 하나 더 만들면 그 손짓이 쓸 `TouchAim` 을 여기 하나 더 만든다.
- **`touchGesture.ts`** — **모바일 터치 제스처 층.** 한 손짓을 다섯으로 가른다:
  짧은 탭=캐럿, 짧은 터치 후 가로 드래그=**셀 수식 가로 스크롤**, 홀드=손가락 밑
  **항** 선택(`expandSelectionSemantic` 2칸), 홀드 후 드래그=그 항을 품은 채 확장
  (`rawSelection.ts` 를 거쳐 원시 캐럿으로 남긴다), 세로 드래그=**페이지 스크롤**
  (`stopPropagation` 만 하고 `preventDefault` 는 안 한다 — 걸면 브라우저의 세로
  패닝(`touch-action: pan-y`)까지 죽는다). 한번 세로로 정해지면 손 뗄 때까지
  그 모드다(중간에 가로로 꺾여도 안 바뀐다) — `stopPropagation` 을 안 하면
  MathLive의 히스테리시스(20px)를 넘기는 순간 저쪽이 선택을 만든다(실측).
  MathLive는 pointerdown을 잡는 순간부터 드래그를 선택으로만 쓰고 `.ML__content` 는
  `overflow: hidden` 이라, 이게 없으면 넘치는 식을 손으로 옮길 방법이 아예 없다.
  **pointerdown은 삼키지 않는다** — 포커스·캐럿 배치·placeholder 특례를 MathLive가
  그대로 하게 두고 그 뒤의 pointermove만 capture로 가로챈다(그 로직이 두 벌이 되면
  어긋난다). 겹치는 구간이 없는 근거는 아래 실측 함정의 히스테리시스 항목.
  데스크톱은 안 건드린다 — `pointerType==='touch' && isMobileViewport()` 게이트.
  **스크롤로는 선택이 안 풀린다**: MathLive는 pointerdown 하나로 선택을 접는데
  (우리가 그 처리를 일부러 통과시키므로), capture라 먼저 보는 김에 선택을 찍어뒀다가
  손짓이 스크롤(가로 패닝·세로 이탈)로 판명되면 되돌린다. 탭이면 안 되돌린다 —
  그건 정말로 캐럿을 옮긴 것이다.
  **홀드 메뉴 차단은 document capture 한 곳**에서 한다(참조 세기). 셀의 빈 자리를
  꾹 누르면 뜨는 건 MathLive가 아니라 브라우저 네이티브 콜아웃이라 필드에 건
  리스너로는 안 잡힌다(사용자 보고). 예외는 `input`/`textarea` 뿐(탭 이름 바꾸기).
- **`activeField.ts`** — **포커스의 단일 게이트.** 쓰는 곳은 `MathField.tsx` 의
  focusin/focusout/언마운트 셋뿐이고 나머지는 읽기만 한다(`repairLatex` 가 구조를,
  `normalizeSelection` 이 선택을 맡는 것과 같은 자리). **뜻이 다른 둘을 이름으로
  가른다**: `focused`(**지금** 포커스를 쥔 필드, 없으면 `null` — 키 팔레트를 접을지가
  여기 걸린다)와 `active`(**마지막** non-null 값, 안 지운다 — 팔레트 버튼은
  `pointerdown` 에서 `preventDefault` 해 포커스를 안 뺏으므로 클릭으로는 애초에
  focusout 이 안 나지만, "필드 밖을 눌렀다가 팔레트로 돌아온" 경우까지 버티려면
  끈끈해야 한다). `active` 는 `focused` 의 **파생**이다 — 예전엔 `focusin` 에서 따로
  갱신해 같은 사실을 두 곳이 각각 추적했다.
  ⚠ **blur 는 한 태스크 미뤄 확정한다.** 셀 간 이동은 focusout(A) → focusin(B) 가
  잇따르므로 즉시 놓으면 팔레트가 접혔다 펴지고, `--palette-h` 로 묶인 `.app` 바닥
  여백까지 함께 움직여 내용이 통째로 튄다. 창 포커스 전환(alt-tab)은
  `document.activeElement` 가 그대로 남는 것으로 가려내 **안 놓는다** — `focusout` 이
  `relatedTarget === null` 일 때 선택을 안 푸는 것과 같은 판단이다.
  ⚠ **`mf.remove()` 는 포커스된 필드에서도 focusout 을 안 쏜다**(실측, 그 통지를 빼면
  브라우저 테스트가 빨간불) — 언마운트 경로가 직접 알려야 사라진 필드가 "포커스 중"
  으로 남지 않는다. `active` 는 그때 **즉시** 지운다: 끈끈한 게 존재 이유지만 떨어져
  나간 필드까지 붙들면 팔레트가 detached 엘리먼트로 키를 흘린다.
  ⚠ **"포커스" 라는 말이 이 앱에 넷 있다. 여기 사는 건 위 둘뿐**이고 나머지는 합칠
  것이 아니다: `tab.focus`(`state/workspace.ts`)는 "여기로 **보내라**" 는 명령이고
  (토큰 일회성), `touchGesture.ts` 의 캐럿 이동단은 DOM Selection 의 anchor/focus
  어휘다(그래서 그쪽 지역변수는 `caret` 으로 부른다).
- **`wellformed.ts`** — 위 규칙들의 파사드 (`repairLatex`/`findViolations` 재노출).
- **`harness.ts`** — 브라우저 테스트용 실제 MathLive 구동 하네스.

⚠ **MathLive 0.110 실측 함정** (터치·포인터 쪽, `touchGesture.browser.test.tsx` 가 핀):
- **드래그 히스테리시스는 `500ms && 20px`** — 터치에서 그 안쪽 움직임을 통째로
  무시한다(`onPointerDown` 안의 `onPointerMove`). 우리 제스처 임계(`450ms / 8px`)가
  **둘 다 그 안쪽**이라, 모드가 정해지기 전엔 MathLive가 아무 것도 안 하고 정해진
  뒤엔 우리가 pointermove를 다 삼킨다 — 두 층이 선택을 동시에 만질 구간이 없다.
  **이 두 상수의 대소 관계가 깨지면 설계가 무너진다.**
- **`mf.getOffsetFromPoint(x, y, {bias})` 는 공개 API다** — 화면 좌표 → 모델 오프셋.
  짝인 **`mf.getElementInfo(offset).bounds` 는 뷰포트 좌표 DOMRect**를 주고, 그
  오프셋 **자리의** 원자를 가리킨다(실측: `1+xy` 에서 오프셋 4 = `y`).
  ⚠ **이 히트테스트는 `atomBoundsCache` 가 더러우면 튄다.** 호출 한 번이 트리를
  훑으며 원자 상자를 캐시에 쌓는데, 거기 `first` 센티넬 상자가 들어가면 **그 다음
  호출부터** 그 센티넬이 자기 branch 어디서나 이긴다(상자가 자기가 아니라 부모
  컨테이너 전체로 재진다). **MathLive 자신의 탭이 항상 정확한 건 탭마다 캐시를
  비우고 시작하기 때문**이고, 그래서 우리 드래그도 `internals.ts` 의
  `resolveOffsetAt` 을 써야 한다 — **매 호출 직전에** 비운다(한 번만 비우면 그 다음
  첫 호출이 다시 오염시킨다, 실측). 비우고 부르면 결과가 진짜 탭과 정확히 일치한다.
  아래는 그 캐시가 더러울 때 실제로 관찰됐던 증상이다:
  **`first` 센티넬로 튄다.** 센티넬 원자의 상자를 재면
  자기 자신이 아니라 **부모 컨테이너 전체**가 나오고(`getNodeBounds` 가 높이 0인
  노드에서 부모로 올라간다), MathLive의 `distance()` 는 점이 상자 안이면 0을 주므로
  그 센티넬이 자기 branch 어디서나 이겨버린다. 특히 원자 사이 **빈 자리**(연산자
  둘레 여백)에서는 유일한 승자다. 더 나쁜 건 이긴 센티넬이 **더 바깥 branch**의
  것일 수 있다는 점 — `x-\left(a+b\right)` 에서 `b` 오른쪽 빈 자리는 괄호 **안**
  인데도 root 센티넬(오프셋 0)을 준다(실측). 언제 걸리는지는 **레이아웃 타이밍을
  탄다**(span 높이가 0이어야 부모로 올라가므로, 민짜 하네스는 재현이 안 되고 실제
  `MathField` 렌더는 걸린다) — 그 "타이밍" 의 정체가 곧 캐시 상태였다.
  `resolveOffsetAt` 은 캐시를 비운 뒤에도 남는 가장자리를 위해 센티넬 보정도
  갖고 있지만, 캐시가 깨끗하면 거의 안 걸리는 2차 안전망이다.
- **컨텍스트 메뉴는 호스트에 쏘는 cancelable `contextmenu` 로 열린다**
  (`acceptContextMenu`) — `preventDefault()` 면 안 뜬다. ⚠ 그 이벤트는
  **`bubbles: false`** 라 부모가 아니라 `math-field` **자신에게** 들어야 한다.
- **`mf.focus()` 는 내용을 통째로 선택한다** — 캐럿만 있는 상태를 만들려면
  `mf.position` 을 따로 정해야 한다(테스트에서 자주 걸린다).
- **호스트에 `user-select: none` 을 걸면 필드가 죽는다** — MathLive가
  `connectedCallback` 에서 그걸 보고 pointerdown 리스너를 아예 안 단다. 네이티브
  선택 콜아웃 억제는 `-webkit-touch-callout` 으로만 한다.
- **원자 화면 상자는 `atomBoundsCache` 에 뷰포트 좌표로 캐시된다**
  (`getAtomBounds`/`getOffsetFromPoint`/`getElementInfo` 가 다 이걸 거친다). 비우는
  곳은 원래 셋뿐이다: 재렌더 직전(rAF), 렌더 끝, 자기 `onPointerDown`. **패닝처럼
  렌더도 pointerdown도 없이 `scrollLeft` 만 옮기는 코드는 캐시를 안 비운다** —
  `clearAtomBoundsCache`(`internals.ts`)로 직접 비워야 한다. 매 프레임 부르면 안
  된다: 비면 히트테스트가 원자마다 `getBoundingClientRect` 를 다시 돈다.

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
  선택 해제(그룹 밖 pointerdown)는 **모바일에서만 손 뗄 때까지 기다린다** — 바깥을
  짚는 손짓 대부분이 페이지 스크롤이라, 누른 즉시 풀면 선택을 잡아둔 채 훑어보는 게
  불가능하다(사용자 보고). 거의 안 움직였으면(=탭) 그때 푼다. 데스크톱은 즉시.
- **`SelectionHandles.tsx`** — **모바일 선택 범위 양끝 드래그 핸들.** 홀드로 잡은
  선택(`editor/touchGesture.ts`)을 손가락으로 다듬는다. `MathField` 안에 오버레이로
  들어간다(`math-field` 는 이펙트가 append 하고, React 자식은 이 핸들뿐).
  위치는 `mf.getElementInfo(offset).bounds` 실측, 드래그는 `mf.getOffsetFromPoint`.
  **스냅을 자기가 계산하지 않는다** — 선택을 그냥 세팅하면 `MathField` 의
  selection-change 게이트(`normalizeSelection`)가 형제 열로 교정한다. 불변식의 단일
  게이트를 두 벌로 만들지 않으려는 것. **bias는 0 — 네이티브 탭과 같은 규칙**이라,
  원시 캐럿이 "그 자리를 탭했을 때 캐럿이 서는 자리" 와 정확히 일치한다. 예전엔
  ±1 로 손가락 밑 원자를 무조건 포함시켰는데, 그러면 탭 위치와 늘 한 경계씩
  어긋났다(사용자 보고 → 실측 확인). 대신 원자의 **어느 쪽 절반**을 짚었느냐로
  경계가 갈린다(중앙선 기준).
  **드래그는 `editor/rawSelection.ts` 의 원시 캐럿을 옮긴다** — 스냅된 선택 자체를
  옮기면, 홀드 드래그가 구조 경계를 넘어 상위로 스냅된 뒤엔 되돌릴 방법이 없다
  (스냅된 결과가 다음 조작의 출발점이 되어버리므로).
  **핸들이 반대쪽 캐럿을 넘어갈 수 있는지**는 `features.ts` 의 `HANDLE_CROSSING`
  으로 켜고 끈다(지금은 **꺼짐** — 조작감을 견줘보려고 남긴 스위치다). 켜면
  넘어간 쪽이 새 시작이 되고, 막는 건 교차가 아니라 **겹침**뿐이다(두 캐럿이 같은 자리면 선택할 게 없다): 그때만 가던
  방향으로 한 칸 더 보내고, 그쪽에 자리가 없으면(문서 양 끝) 반대로 한 칸 물려
  원자 하나를 남긴다. 넘어간 뒤에도 **쥔 노드가 손가락 쪽에 남아야** 하므로,
  렌더가 핸들의 **정체**(React 키·포인터 캡처가 걸린 노드)와 **화면상 위치**
  (물방울 좌우 거울상·핀 화살촉 방향)를 갈라 놓는다 — 안 그러면 교차하는 순간 쥔
  핸들이 반대편으로 순간이동한다.
  **모양은 안드로이드 물방울이다**(`styles.css`): 둘 다 선택 줄 **아래**에 매달리고
  (위/아래로 안 가른다 — 손가락이 늘 수식 아래라 잡는 자리가 한결같다), 네 모서리
  중 **하나만 뾰족해 그 꼭짓점이 경계를 짚는다**. 좌우가 거울상이라 몸통은 경계
  **바깥쪽**으로 비켜 있다(시작은 왼쪽·뾰족한 쪽이 오른쪽 위, 끝은 그 반대) —
  선택된 내용을 손잡이가 가리지 않는 게 이 모양의 요점이다.
  ⚠ 그 비켜선 배치는 **핀일 때만 되돌린다**(경계 위 가운데 맞춤) — 핀은 이미
  컨테이너 경계에 서 있어서 그대로 두면 몸통이 통째로 셀 밖으로 나간다.
  컨테이너 밖으로 나간 끝은
  숨기지 않고 그 경계에 **핀**으로 세운다(`.sel-handle-pinned`, 화살촉 모양) —
  언제든 잡아 안으로 끌어올 수 있다. 드래그 중엔 손가락 x를 콘텐츠 상자 안으로
  **클램프**해 핸들이 컨테이너 밖으로 못 나가게 하고, 클램프 전 위치가 경계 밖이면
  MathLive의 자체 드래그 선택과 같은 간격(32ms/16px, 실측)으로 자동 스크롤한다.
  ⚠ **MathLive는 원자 상자를 뷰포트 좌표로 캐싱한다**(`atomBoundsCache`, 실측) —
  비우는 곳이 원래 렌더 전후와 자기 `onPointerDown` 뿐이라, 렌더 없이 `scrollLeft`
  만 옮기는 우리 패닝·자동 스크롤 뒤엔 `editor/internals.ts` 의
  `clearAtomBoundsCache` 를 명시적으로 불러야 핸들이 스크롤을 따라간다.
  **드래그 한 번은 세 단계고, 셋의 방향이 다 다르다** (각 함수 주석에 ①②③으로
  달아뒀다): ① `resolveOffsetAt`(`editor/internals.ts`) = **픽셀 → 오프셋**,
  ② `caretRunRange`(`editor/selection.ts`, `setRawSelection` 이 부른다) =
  **오프셋 → 범위**, ③ `measure`(여기) = **오프셋 → 픽셀**.
  ⚠ **③은 범위를 만들지 않는다** — 입력이 원시 캐럿이 아니라 이미 스냅이 끝난
  `mf.selection` 이다. 그래서 ①②는 pointermove마다 돌지만 ③은 기하가 바뀌는
  신호(`selection-change`·스크롤·리사이즈)에만 붙는다. 원시 캐럿이 움직여도
  ②의 스냅 결과가 같으면 `mf.selection` 이 안 바뀌고 — MathLive가
  `deferNotifications` 에서 옛 선택과 비교해 같으면 `selection-change` 를 아예
  안 쏜다(실측, `mathlive.mjs` 의 `compareSelection`) — ③은 안 돈다. **버그가
  아니라 같은 픽셀을 다시 재지 않는 것뿐이다.**
- **`SelectionToolbar.tsx`** — 행렬 통째 선택 시 뜨는 구분 기호 플로팅 툴바.
- **`KeyPalette.tsx`** — 자체 키 팔레트(MathLive 자체 가상 키보드 대신). 버튼이
  `mf.insert()` 가 아니라 `feedKey` 로 **물리 키 입력과 같은 경로**를 탄다. ⚠ **여기에
  LaTeX을 적지 않는다** — 트리거 글자를 흘리고 변환은 인라인 숏컷 엔진이 한다(예외는
  키 입력 경로가 없는 행렬뿐). 대상은 `editor/activeField.ts` 의 **끈끈한** `active`
  이고, **접을지 말지는 같은 모듈의 `focused`** 를 `useSyncExternalStore` 로 구독해
  정한다 — 포커스된 셀이 하나도 없으면 접힌다(모바일 분기가 아니다: 데스크톱은 CSS가
  어차피 늘 숨긴다). 컴포넌트는 `hidden` 만 걸고 접는 일은 CSS 몫이다(대원칙 3).
  ⚠ **`display` 만 꺼서는 안 된다** — `.app` 바닥 여백이 `--palette-h` 로 팔레트
  높이와 묶여 있어(`styles/base.css`) 그 높이만큼 빈 자리가 그대로 남는다.
  `styles/keyPalette.css` 가 변수도 함께 0으로 돌린다.
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
  **등식 셀**(`2x+1=7`, `splitRelation` 이 갈라낸다)은 `defName` 이 없어 아무것도
  정의하지 않는다 — `FormulaObject.solveFor` 가 골라졌을 때만
  `computeRelationNode` 가 `lhs-\left(rhs\right)` 를 만들어 algebra의 `solveFor`
  에 넘긴다(`transform/solve.ts`). 안 골랐으면(`solveFor===null`) 그래프에 아예
  안 들어간다 — 정의가 없으니 빼도 다른 셀에 영향이 없다. 부등호(`<`,`\leq` 등)는
  여전히 오류다.
- **`cellEnv.ts`** — 정의 판정(`splitDefinition`: `a=3` 의 좌변/우변 분리,
  `splitFunctionDefinition`: `f(x)=x^2` 의 이름/매개변수/우변 분리, `splitRelation`:
  둘 다 아닌 최상위 `=` 의 좌변/우변 분리 — `2x+1=7` 같은 등식)과 `Env` 조립
  (`buildCellEnv`, algebra의 `buildEnv` 얇은 재노출 — 이제 `functions` 도 받는다).
  그래프 구성 자체는 안 한다 — 그건 `cellGraph.ts` 몫. `splitRelation` 은
  `Cell.tsx` 도 같이 쓴다(solve 버튼 노출 판정 — 판정이 두 벌이면 어긋난다).
- **`types.ts`** — `FormulaObject`(정본), `EvalResult`, `CellMode` 등 공용 타입.
- **`mobile.ts`** — `isMobileViewport()`. 모바일 판정의 **단일 기준점**(위 대원칙 2).
- **`features.ts`** — 기능 플래그. `SOLVE_ENABLED`(등식 풀기, CE 한계로 꺼둠),
  `HANDLE_CROSSING`(핸들이 반대쪽 캐럿을 넘어갈 수 있는지, 지금은 꺼둠),
  `ATOM_BOX_DEBUG`(원자 상자 1px 테두리, **`?atombox`** 질의 문자열로 켠다 —
  실기기 확인은 폰에서 배포본을 여는 식이라 상수로는 못 켠다). 셰도우 CSS라
  `MathField.tsx` 의 `ATOM_BOX_CSS` 가 붙인다.
- **`styles.css` / `styles/`** — 전역 CSS. `styles.css` 는 `@import` 만 있는 입구이고
  (import 하는 4곳 — `main.tsx` 와 브라우저 테스트 셋 — 을 안 건드리려고 이름과 자리를
  그대로 뒀다), 규칙은 `src/styles/` 밑 **기능당 한 파일**에 있다. 각 파일이 자기
  데스크톱 규칙과 자기 `@media (max-width: 640px)` 블록을 **둘 다** 갖는다(위 대원칙 1).
  라이트/다크는 `tokens.css` 의 CSS 변수 — 그 안에서 라이트 `:root` 가 다크보다
  **먼저** 와야 한다(같은 프로퍼티라 순서가 이긴다). `--palette-h` 만은 `keyPalette.css`
  가 갖는다 — 팔레트 높이와 `.app` 바닥 여백을 한 값으로 묶는 자리라 팔레트가 주인이다.
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

## ⚠ 모바일 작업의 대원칙 — 모바일에만 적용한다

**여기서 하는 변경은 가능한 한 전부 모바일 환경에서만 적용되어야 한다.**
데스크톱 동작·레이아웃은 건드리지 않는다.

이 규칙은 **이 파일이 놓인 브랜치와 거기서 갈라져 나가는 모든 브랜치**에 적용된다.
브랜치 이름은 적지 않는다 — 브랜치는 지워지고 이름은 곧 낡는다. 모바일 실험은
나란히 갈라져 서로 견줘 보는 식으로 진행되므로, 데스크톱이 한쪽에서 흔들리면
비교 자체가 무너진다. 그게 이 규칙이 있는 유일한 이유다.

지키는 방법은 넷이다:

1. **CSS는 기능별 파일에 쓰고, 모바일 규칙은 그 파일 **자기** `@media (max-width: 640px)`
   블록 안에만 쓴다.** `src/styles.css` 는 `@import` 만 있는 얇은 입구이고, 실제 규칙은
   `src/styles/` 밑 기능당 한 파일에 있다. 파일 이름은 그 기능을 그리는 컴포넌트를
   따른다 (`selectionHandles.css` ↔ `SelectionHandles.tsx`).

   - **한 기능의 데스크톱 기본값과 모바일 덮어쓰기는 같은 파일에 둔다.** 전역 규칙에는
     기본값(대개 `display: none`)만 두고 실제 배치는 그 파일 **맨 아래** 미디어 블록이
     정한다 — `.key-palette`·`.transform-popup`·`.sel-handle`·`.result-mode-label-compact`
     가 그 꼴이다. 예전엔 이 짝이 한 파일 안에서 300~950줄씩 떨어져 있어 규칙이 있는지
     자체를 못 봤다.
   - **미디어 블록 밖에 모바일 규칙을 쓰지 않는다.** 데스크톱을 안 건드린다는 보장은
     여전히 이 한 줄이 전부다.
   - **임계값 문자열은 한 벌이다.** 파일마다 미디어 블록이 생겨 640px 이 여러 곳
     적힌다 — `src/styles/mediaQuery.test.ts` 가 `src/styles/*.css` 를 전부 읽어
     `src/mobile.ts` 의 `MOBILE_QUERY` 와 대조한다. 기준을 바꾸려면 `mobile.ts` 를
     고치고 테스트가 짚어 주는 파일들을 따라 고친다.
   - **새 기능은 새 파일이다.** 남의 파일 맨 아래에 덧붙이지 않는다 — 나란히 도는
     실험 브랜치들이 **같은 자리**에 끼워 넣어 매번 충돌하던 걸 없애려고 가른 것이다.
     새 파일을 만들면 `styles.css` 에 `@import` 를 반드시 더한다(빠뜨리면 그 파일은
     조용히 안 실린다 — 위 테스트가 잡는다).
   - **`@import` 순서가 곧 캐스케이드 순서다.** 같은 셀렉터의 같은 프로퍼티가 두
     파일에 있으면 **뒤에 import 된 쪽이 이긴다**(`@media` 는 우선순위를 안 올린다).
     순서는 `토큰 → 뼈대 → 구조 → 위젯 → 오버레이` 다. **남의 요소를 숨기거나 그 위에
     얹는 기능일수록 뒤**에 온다 (`transformPopup`·`selectionHandles`·`keyPalette` 가
     맨 뒤인 이유).
2. **JS 분기가 꼭 필요하면 같은 640px 기준을 쓴다** (`window.matchMedia`). 그
   기준은 **`src/mobile.ts` 의 `isMobileViewport()` 하나뿐**이다 — 새로 만들지 말고
   이걸 쓴다. 지금 쓰는 곳은 터치 제스처 층(`editor/touchGesture.ts`) 하나다.
3. **컴포넌트에 모바일 전용 DOM을 넣어야 하면, 그리기만 하고 숨김은 CSS에 맡긴다.**
   예: 결과 토글의 `π`/`3.14` 라벨은 데스크톱 `formula`/`decimal` 라벨과 **둘 다**
   렌더되고, 어느 쪽을 보일지는 미디어쿼리가 정한다. 조건부 렌더로 가르지 않는다 —
   그러면 JS 분기 기준이 CSS와 어긋날 자리가 하나 더 생긴다.
4. **주석·문서에 그 결정이 사는 브랜치 이름을 적지 않는다** — 아래 코딩 컨벤션 참고.

예외를 둘 수밖에 없었던 곳은 그 자리에 이유를 적는다(현재: `MathField.tsx`의
`mathVirtualKeyboardPolicy`를 항상 `'manual'`로 둔 것 — MathLive 자체 가상 키보드는
데스크톱에서도 원래 안 썼으므로 실질 변화가 없다).

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
- **주석·문서에 브랜치 이름을 적지 않는다.** 브랜치는 지워지고 이름은 낡는다.
  그 결정이 왜 그런지는 결정이 **사는 파일**을 가리켜 적는다
  (`MathField.tsx` 의 `mathVirtualKeyboardPolicy`, `CLAUDE.md §모바일 대원칙`).

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
- **`transform/transform.fuzz.test.ts` 는 대수 모듈의 안전망이다.** 무작위 식에 구체적인 수를 채워
  `값·모양이 재작성 전후로 같은가`와 `렌더가 멱등인가`를 확인한다. 여기서 잡힌 버그가
  표 테스트로는 안 잡히는 종류다 (교환법칙 오적용, 인수 순서 뒤집힘, CE 직렬화 버그).
  **대수 모듈을 건드렸으면 표본을 크게 잡고 한 번 돌려볼 것.**
- 브라우저 테스트는 `*.browser.test.tsx` — 실제 `<math-field>`를 띄워야 하는
  것(키 입력 시퀀스, 셀렉션, DOM 이벤트)만. jsdom보다 느리니 최소한으로.
- **배포 게이트**: 단위 + 브라우저 테스트 둘 다 통과해야 배포된다 (아래 참고).

### 벤치

```bash
npm run bench           # vitest bench — src/algebra/normalize/normalize.bench.ts
```

정규화 처리량 기준선. `expression/key.ts` 의 `WeakMap` 캐시 경고가 재던 숫자가 바로
이 하네스로 잰 것 — 정렬·비교 로직을 건드릴 땐 여기서 전후를 비교한다.

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
