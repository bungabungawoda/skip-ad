import { describe, expect, it } from "vitest";
import { advancePlatformAd, type PlatformAdState } from "../controller";
import type { PlatformAdObservation } from "../types";

/** 状态机纯逻辑测试：DOM 之外锁相位迁移与快进条件。 */

const NO_ACTION = { fastForward: () => ({ acted: false }) };

function state(overrides: Partial<PlatformAdState> = {}): PlatformAdState {
  return {
    phase: "no_ad",
    attempts: 0,
    appearance: 0,
    lastActionAt: null,
    sawAd: false,
    ...overrides
  };
}

function obs(showingAd: boolean): PlatformAdObservation {
  return { showingAd };
}

describe("平台广告状态机", () => {
  it("无广告 → 快进 → 等待 → 次数用尽 → 放弃", () => {
    let current = state();
    let actions = 0;
    const step = (observation: PlatformAdObservation | null, now: number, act = true): string => {
      const result = advancePlatformAd(current, observation, now, {
        settleMs: 300,
        maxAttempts: 5,
        fastForward: () => {
          if (act) actions += 1;
          return { acted: act };
        }
      });
      current = result.state;
      return current.phase;
    };

    // 首轮动作：进入验证窗口。
    expect(step(obs(true), 0, true)).toBe("fast_forwarding");
    expect(actions).toBe(1);
    // 验证窗口内不重复动作。
    expect(step(obs(true), 200)).toBe("fast_forwarding");
    expect(actions).toBe(1);
    // 窗口过后广告仍在：再次快进。
    expect(step(obs(true), 400)).toBe("fast_forwarding");
    expect(actions).toBe(2);
    // 无可执行动作时不烧次数，进入等待。
    expect(step(obs(true), 800, false)).toBe("waiting");
    expect(actions).toBe(2);
    // 达到上限后放弃，本条广告出现期间不再动作。
    for (let at = 900; at <= 2100; at += 400) step(obs(true), at, true);
    expect(actions).toBe(5);
    expect(current.attempts).toBe(5);
    expect(step(obs(true), 3000)).toBe("given_up");
    expect(step(obs(true), 9999)).toBe("given_up");
    expect(actions).toBe(5);

    // 广告结束：回到无广告并清零。
    expect(step(obs(false), 10_000)).toBe("no_ad");
    // 新的出现次数：从头开始计数。
    expect(step(obs(true), 10_100)).toBe("fast_forwarding");
    expect(actions).toBe(6);
  });

  it("状态未知（播放器缺失）保持相位，不动作也不重置出现计数", () => {
    const current = state({
      phase: "fast_forwarding",
      attempts: 1,
      appearance: 1,
      lastActionAt: 100,
      sawAd: true
    });
    const result = advancePlatformAd(current, null, 5_000, {
      settleMs: 300,
      maxAttempts: 5,
      ...NO_ACTION
    });
    expect(result.state).toEqual(current);
    expect(result.acted).toBe(false);
  });

  it("观察异常前的相位不会因为 ad 结束丢掉出现序号", () => {
    const current = state({ appearance: 2 });
    const result = advancePlatformAd(current, obs(false), 0, {
      settleMs: 300,
      maxAttempts: 5,
      ...NO_ACTION
    });
    expect(result.state.appearance).toBe(2);
  });

  it("pod 内预算连续：showingAd 一直为真时不重置次数，由预算覆盖整个 pod", () => {
    const current = state({ phase: "given_up", attempts: 5, appearance: 1, sawAd: true });
    let actions = 0;
    const result = advancePlatformAd(current, obs(true), 2_000, {
      settleMs: 300,
      maxAttempts: 5,
      fastForward: () => {
        actions += 1;
        return { acted: true };
      }
    });
    // 上限已用尽：pod 内不再动作，快进状态由站点适配器自己维持。
    expect(result.state.phase).toBe("given_up");
    expect(actions).toBe(0);
  });

  it("快进动作给出秒数时原样透传，没给就不带", () => {
    const withSeconds = advancePlatformAd(state(), obs(true), 0, {
      settleMs: 300,
      maxAttempts: 5,
      fastForward: () => ({ acted: true, seconds: 12.5 })
    });
    expect(withSeconds.acted).toBe(true);
    expect(withSeconds.seconds).toBe(12.5);

    const withoutSeconds = advancePlatformAd(state(), obs(true), 0, {
      settleMs: 300,
      maxAttempts: 5,
      fastForward: () => ({ acted: true })
    });
    expect(withoutSeconds.seconds).toBeUndefined();
  });
});
