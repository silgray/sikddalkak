import { describe, expect, it } from 'vitest';
import { DIRECT_AIM, aimedPoint, gripAim } from './touchAim';

/**
 * 손가락 좌표 → 히트테스트 좌표 보정(`touchAim.ts`)의 계약.
 *
 * 이 파일이 못박는 건 셋이다:
 *   ① 직접 짚는 손짓(홀드 선택)은 좌표를 **손대지 않는다**
 *   ② 쥐는 손짓(손잡이 드래그)은 쥔 순간이 정확히 기준선에 떨어진다
 *   ③ 그 뒤 세로 이동이 **1:1로 보존**된다 (분자/분모를 넘나들 수 있어야 한다)
 */

describe('DIRECT_AIM — 손가락이 내용을 직접 짚는 손짓', () => {
  it('좌표를 그대로 통과시킨다', () => {
    expect(aimedPoint(DIRECT_AIM, 120, 340)).toEqual({ x: 120, y: 340 });
  });
});

describe('gripAim — 손잡이를 쥐고 끄는 손짓', () => {
  // 선택 줄 한가운데가 y=100, 손가락은 물방울을 쥐어 y=124 (24px 아래).
  const LINE_MID_Y = 100;
  const GRAB_Y = 124;
  const aim = gripAim(GRAB_Y, LINE_MID_Y);

  it('쥔 순간의 판정은 정확히 선택 줄 한가운데다', () => {
    expect(aimedPoint(aim, 50, GRAB_Y).y).toBe(LINE_MID_Y);
  });

  it('가로는 손대지 않는다', () => {
    expect(aimedPoint(aim, 50, GRAB_Y).x).toBe(50);
  });

  it('세로 이동이 1:1로 보존된다 — 분자/분모를 넘나들 수 있어야 한다', () => {
    // 손가락을 10px 올리면 판정도 10px 올라간다 (뭉개서 기준선에 붙이지 않는다).
    expect(aimedPoint(aim, 50, GRAB_Y - 10).y).toBe(LINE_MID_Y - 10);
    expect(aimedPoint(aim, 50, GRAB_Y + 10).y).toBe(LINE_MID_Y + 10);
  });

  it('고정 px 이 아니다 — 줄 높이가 달라지면 보정도 달라진다', () => {
    // 같은 자리를 쥐어도 기준선이 더 위(작은 글꼴·위쪽 줄)면 더 많이 들어올린다.
    const higher = gripAim(GRAB_Y, LINE_MID_Y - 30);
    expect(higher.liftY).toBe(aim.liftY + 30);
  });

  it('손잡이를 어디쯤 쥐든 시작점은 늘 기준선이다', () => {
    for (const grabY of [LINE_MID_Y + 4, LINE_MID_Y + 24, LINE_MID_Y + 40]) {
      expect(aimedPoint(gripAim(grabY, LINE_MID_Y), 0, grabY).y).toBe(LINE_MID_Y);
    }
  });
});
