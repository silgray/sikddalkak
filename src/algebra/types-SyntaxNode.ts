
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
  | { readonly kind: 'pow'; readonly base: SyntaxNode; readonly exponent: SyntaxNode }
  | { readonly kind: 'frac'; readonly numerator: SyntaxNode; readonly denominator: SyntaxNode }
  | { readonly kind: 'call'; readonly name: string; readonly args: readonly SyntaxNode[] }
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