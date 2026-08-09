
/**
 * Syntax IR — **사용자가 쓴 것을 그대로 보존**하는 층. 모양을 모른다.
 *
 * 요점은 `·`(cdot) / `×`(times) / 병치(juxt)를 **구분해서 유지**하는 것이다. CE는 셋 다
 * `Multiply` 로 뭉개버려(실측) 의미가 사라지므로, 여기서 살려낸다. 어느 것이 내적이고
 * 어느 것이 스칼라곱인지는 **모양을 알아야** 정해지므로 이 층에서는 판단하지 않는다
 * (그 판단은 elaborate가 한다 — 연산자 결정과 모양 추론은 같은 패스여야 한다).
 *
 * CE에는 LaTeX에서 `Cross` 로 가는 경로가 없어(조사 확인) 마커 심볼로 우회하는데,
 * **그 우회는 이 파일 안에만 갇힌다.** 바깥 층은 마커의 존재를 모른다.
 */

import type { Literal } from './types-Literal';

export type SyntaxNode =
  | { readonly kind: 'num'; readonly value: Literal }
  | { readonly kind: 'sym'; readonly name: string }
  | { readonly kind: 'matrix'; readonly rows: readonly (readonly SyntaxNode[])[] }
  | { readonly kind: 'juxt'; readonly left: SyntaxNode; readonly right: SyntaxNode }
  | { readonly kind: 'cdot'; readonly left: SyntaxNode; readonly right: SyntaxNode }
  | { readonly kind: 'times'; readonly left: SyntaxNode; readonly right: SyntaxNode }
  | { readonly kind: 'add'; readonly terms: readonly SyntaxNode[] }
  | { readonly kind: 'neg'; readonly operand: SyntaxNode }
  /**
   * `tightPostfix` — **이 후위가 `base` 에 `apply`(§사용자 정의 함수) 하나만 놓고
   * 곧장 붙었는가**(괄호로 한 번 더 감싸이지 않고). CE 실측: `f\left(x\right)^2` 는
   * `Power` 가 곱셈 인수열 **안쪽**(이름 바로 뒤)에 오지만, `\left(f\left(x\right)\right)^2`
   * 처럼 사용자가 **명시적으로 한 번 더 괄호를 쳤으면** `Power` 가 그 바깥을 감싼
   * `Delimiter` 를 잡는다 — 둘 다 `translateToTree` 를 거치면 **같은 모양의**
   * `pow(apply(...), exp)` 가 되어버려(구분 정보가 그냥 두면 사라진다) 이 필드로
   * 남겨둔다.
   *
   * `elaborate` 가 이걸로 갈라 쓴다: `true`(꽉 묶임)면 `callee` 가 함수가 아닐 때
   * 후위를 **마지막 인수 안으로** 밀어 넣는다(`A(X)^T`=`A·(X^T)`, 설계 §3).
   * `false`/미정(느슨함)이면 `base` 를 통째로 elaborate한 **뒤에** 후위를 씌운다
   * (`(A(X))^T` 는 `A(X)` 가 뭐로 풀리든 **그 전체**의 전치다 — 사용자가 괄호로
   * 그렇게 못박았다). 함수로 판명되면 어느 쪽이든 항상 "apply 전체를 감싼다"로
   * 수렴하므로 갈림은 **함수가 아닐 때만** 관찰된다.
   */
  | { readonly kind: 'pow'; readonly base: SyntaxNode; readonly exponent: SyntaxNode; readonly tightPostfix?: boolean }
  | { readonly kind: 'frac'; readonly numerator: SyntaxNode; readonly denominator: SyntaxNode }
  | { readonly kind: 'call'; readonly name: string; readonly args: readonly SyntaxNode[] }
  /**
   * `name\left(arg_1,arg_2,...\right)` — **사용자가 이름 뒤에 괄호 묶음을 썼다**는
   * 사실만 담는다. 함수 적용인지 곱셈(`A(v)` = 행렬곱)인지는 여기서 안 정한다 — `name`
   * 이 정의된 함수인지는 **모양 문맥(`env`)이 있어야** 알 수 있으므로 `elaborate` 가
   * 정한다(`cdot`/`juxt` 가 내적·스칼라곱·외적 중 뭔지도 elaborate가 정하는 것과 같은
   * 이유 — 파일 서두 참고). `call`(내장 스칼라 함수 전용, 이름이 고정 테이블에 있다)과
   * 다른 종류로 두는 이유도 같다 — 사용자 함수는 함수인지조차 문맥 없이는 모른다.
   *
   * 후위(`^2`,`^T`)는 **항상 바깥을 감싼다** — `pow(apply(f,[x]), 2)`. CE 실측: 홑
   * 대문자(`F(x)^2`→`Power(["F","x"],2)`)와 소문자(`f(x)^2`→`InvisibleOperator(f,
   * Power(Delimiter(x),2))`)가 후위 결합 위치는 다르게 주지만 감싸는 연산자(`Power`/
   * `Transpose`)는 같다 — `translateToTree`가 두 경로 모두 여기 "바깥" 꼴로 정규화해
   * 들여보낸다. `elaborate`가 곱으로 되돌릴 때(함수가 아닌 것으로 판명될 때) 이 후위를
   * 다시 안으로 밀어 넣어 기존 `A(X)^T` = `A·(X^T)` 규칙(설계 §3)을 복원한다.
   */
  | { readonly kind: 'apply'; readonly callee: string; readonly args: readonly SyntaxNode[] }
  /**
   * `\dfrac{\mathrm{d}}{\mathrm{d}x}(...)` 계열. `vars` 는 미분 변수(다변수면 길이 >1),
   * `order` 는 몇 번 미분했는지 — `\dfrac{\mathrm{d}^3}{\mathrm{d}x^3}` 는 `vars:['x'],order:3`.
   * CE가 같은 변수의 중첩 `D` 를 접어서 주므로(실측) 여기서 한 번에 접어 담는다.
   */
  | { readonly kind: 'diff'; readonly body: SyntaxNode; readonly vars: readonly string[]; readonly order: number }
  | {
      readonly kind: 'sum';
      readonly body: SyntaxNode;
      readonly variable: string;
      readonly lower: SyntaxNode | null;
      readonly upper: SyntaxNode | null;
    }
  | {
      readonly kind: 'prod';
      readonly body: SyntaxNode;
      readonly variable: string;
      readonly lower: SyntaxNode | null;
      readonly upper: SyntaxNode | null;
    }
  | {
      readonly kind: 'int';
      readonly body: SyntaxNode;
      readonly variable: string;
      readonly lower: SyntaxNode | null;
      readonly upper: SyntaxNode | null;
    };