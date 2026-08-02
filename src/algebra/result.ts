/**
 * 이 모듈의 결과·오류 표현.
 *
 * **모호하거나 모양이 안 맞으면 계산하지 않고 오류를 낸다**는 게 모듈의 원칙이라
 * 거의 모든 공개 함수가 `Result` 를 돌려준다. 예외를 던지지 않는 이유는 오류가
 * "예외 상황"이 아니라 **정상적인 결과의 한 종류**이기 때문이다 — 사용자가 아직
 * 완성하지 않은 식은 늘 있다.
 *
 * `code` 는 안정된 식별자라 테스트가 이걸로 단언한다. `message` 는 사람이 읽는 문장이고
 * UI에 그대로 나가므로 **영어**로 쓴다 (MathLive 폰트가 한글 글리프를 렌더하지 못한다).
 */

export type ErrorCode =
  /** 괄호 없이 순서가 모호하다 (혼합 곱, 비결합 반복) */
  | 'ambiguous-order'
  /** 연산에 필요한 모양 조건을 만족하지 못한다 */
  | 'shape-mismatch'
  /** 모양이 확정되지 않아 연산을 고를 수 없다 */
  | 'unknown-shape'
  /** 구조가 깨졌다 (피연산자 없는 연산자 등) */
  | 'malformed'
  /** 아직 다루지 않는 구성 */
  | 'unsupported';

export type AlgebraError = {
  readonly code: ErrorCode;
  /** 사용자에게 보이는 문장 (영어) */
  readonly message: string;
  /** 문제가 된 부분식 — 어디가 틀렸는지 짚어주기 위한 것 */
  readonly where?: string;
};

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly AlgebraError[] };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const fail = <T>(
  code: ErrorCode,
  message: string,
  where?: string,
): Result<T> => ({ ok: false, errors: [{ code, message, where }] });

export const failWith = <T>(errors: readonly AlgebraError[]): Result<T> => ({ ok: false, errors });

/** 여러 결과를 모은다. 하나라도 실패하면 **모든** 오류를 합쳐서 돌려준다 (한 번에 다 보여주려고). */
export function all<T>(results: readonly Result<T>[]): Result<T[]> {
  const values: T[] = [];
  const errors: AlgebraError[] = [];
  for (const r of results) {
    if (r.ok) values.push(r.value);
    else errors.push(...r.errors);
  }
  return errors.length > 0 ? failWith(errors) : ok(values);
}
