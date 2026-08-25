/**
 * `crypto.randomUUID()`는 보안 컨텍스트(HTTPS·localhost)에서만 있다. 폰으로 LAN IP에
 * 평문 HTTP로 접속하면(모바일 테스트, `http://192.168.x.x:5173`) 없다 — 실측:
 * `TypeError: crypto.randomUUID is not a function`. `crypto.getRandomValues()`는 그
 * 제약이 없으므로 있으면 우선 쓰고, 없으면 그걸로 UUID v4를 직접 조립한다.
 */
export function makeId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
