import { describe, expect, it } from "vitest";
import {
  createSkipState,
  observePlayback,
  toSkipSegment,
  undoSkip
} from "../segment-skipper";
import { sponsorSegment as segment } from "../../../../tests/helpers/segments";

function observation(currentTime: number, now = 0, overrides = {}) {
  return {
    currentTime,
    duration: 600,
    paused: false,
    seeking: false,
    now,
    ...overrides
  };
}

describe("skip engine", () => {
  it("skips when natural playback crosses the start", () => {
    const target = toSkipSegment(segment(10, 20));
    const step = observePlayback(createSkipState(9.9), observation(10.1), [target]);
    expect(step.action).toMatchObject({ type: "seek", to: 20.05 });
    expect(step.state.lastTime).toBe(20.05);
    expect(step.state.skipped[target.key]).toBe(true);
  });

  it("skips when playback reaches exactly the segment start", () => {
    const target = toSkipSegment(segment(10, 20));
    const step = observePlayback(createSkipState(9.9), observation(10), [target]);
    expect(step.action.type).toBe("seek");
  });

  it("does not skip when playback starts exactly at the segment start", () => {
    const target = toSkipSegment(segment(10, 20));
    const step = observePlayback(createSkipState(10), observation(10.1), [target]);
    expect(step.action.type).toBe("none");
  });

  it("treats a 1.5 second gap as playback and a larger gap as a seek", () => {
    const target = toSkipSegment(segment(10, 20));
    const natural = observePlayback(createSkipState(9.9), observation(11.4), [target]);
    expect(natural.action.type).toBe("seek");
    const seek = observePlayback(createSkipState(9.9), observation(11.41), [target]);
    expect(seek.action.type).toBe("none");
  });

  it("does not skip when the user jumps into a segment", () => {
    const target = toSkipSegment(segment(10, 20));
    const step = observePlayback(createSkipState(5), observation(15), [target]);
    expect(step.action.type).toBe("none");
    expect(step.state.lastTime).toBe(15);
  });

  it("does not skip while paused or seeking", () => {
    const target = toSkipSegment(segment(10, 20));
    const paused = observePlayback(createSkipState(9.9), observation(10.1, 0, { paused: true }), [
      target
    ]);
    expect(paused.action.type).toBe("none");
    const seeking = observePlayback(createSkipState(9.9), observation(10.1, 0, { seeking: true }), [
      target
    ]);
    expect(seeking.action.type).toBe("none");
  });

  it("does not skip while suspended by a platform ad and only syncs lastTime", () => {
    const target = toSkipSegment(segment(10, 20));
    const step = observePlayback(
      createSkipState(9.9),
      observation(10.1, 0, { suspended: true }),
      [target]
    );
    expect(step.action.type).toBe("none");
    expect(step.state.lastTime).toBe(10.1);
  });

  it("honors the guard window after a skip", () => {
    const target = toSkipSegment(segment(10, 20));
    const first = observePlayback(createSkipState(9.9), observation(10.1, 0), [target]);
    const guarded = observePlayback(first.state, observation(21, 500), [target]);
    expect(guarded.action.type).toBe("none");
  });

  it("keeps the segment dismissed after undo until the user rewinds before its start", () => {
    const target = toSkipSegment(segment(10, 20));
    const first = observePlayback(createSkipState(9.9), observation(10.1, 0), [target]);
    const undo = undoSkip(first.state, target, 1_000);
    expect(undo.action).toMatchObject({ type: "seek", to: 10.01 });
    expect(undo.state.skipped[target.key]).toBe(true);

    // 撤销后继续在片段内播放：不自动跳。
    const before = observePlayback({ ...undo.state, lastTime: 9.9 }, observation(10.1, 5_000), [
      target
    ]);
    expect(before.action.type).toBe("none");

    // 拖回片段起点之前再进入：重新武装，恢复自动跳。
    const rewound = observePlayback({ ...undo.state, lastTime: 10.1 }, observation(9, 6_000), [
      target
    ]);
    expect(rewound.state.skipped[target.key]).toBeUndefined();
    const after = observePlayback({ ...rewound.state, lastTime: 9 }, observation(10.1, 7_000), [
      target
    ]);
    expect(after.action.type).toBe("seek");
  });

  it("chains an adjacent next segment into the same seek", () => {
    const first = toSkipSegment(segment(10, 20));
    const second = toSkipSegment(segment(20.1, 30));
    const step = observePlayback(createSkipState(9.9), observation(10.1, 0), [first, second]);
    expect(step.action).toMatchObject({ type: "seek", to: 30.05 });
    expect(step.state.skipped[first.key]).toBe(true);
    expect(step.state.skipped[second.key]).toBe(true);
  });

  it("chains a next segment that starts within the 1.5 second gap", () => {
    const first = toSkipSegment(segment(10, 20));
    const second = toSkipSegment(segment(21.4, 30));
    const step = observePlayback(createSkipState(9.9), observation(10.1, 0), [first, second]);
    expect(step.action).toMatchObject({ type: "seek", to: 30.05 });
  });

  it("keeps a next segment beyond the gap for the following crossing", () => {
    const first = toSkipSegment(segment(10, 20));
    const second = toSkipSegment(segment(21.6, 30));
    const step = observePlayback(createSkipState(9.9), observation(10.1, 0), [first, second]);
    expect(step.action).toMatchObject({ type: "seek", to: 20.05 });
    expect(step.state.skipped[second.key]).toBeUndefined();

    // 按真实播放节奏往后走，第二段的起点在保护窗口之后被自然跨过。
    let state = step.state;
    let action = "none";
    for (let time = 20.3; time <= 22; time += 0.25) {
      const next = observePlayback(state, observation(time, time * 1_000), [first, second]);
      state = next.state;
      if (next.action.type === "seek") {
        action = "seek";
        expect(next.action.to).toBe(30.05);
        break;
      }
    }
    expect(action).toBe("seek");
  });

  it("does not lose a crossing that happens inside the guard window", () => {
    const first = toSkipSegment(segment(10, 20));
    const second = toSkipSegment(segment(20.2, 30));
    // 先跳到 20.05，落点离第二段 0.15 秒：第一段不在合并范围里。
    const skipped = observePlayback(createSkipState(9.9), observation(10.1, 0), [first]);
    expect(skipped.action).toMatchObject({ type: "seek", to: 20.05 });

    // 保护窗口内到达 20.15：不跳，但 lastTime 必须停在 20.05。
    const guarded = observePlayback(skipped.state, observation(20.15, 100), [first, second]);
    expect(guarded.action.type).toBe("none");
    expect(guarded.state.lastTime).toBe(20.05);

    // 窗口过后 20.45：第二段的起点已经被越过，仍然要跳。
    const after = observePlayback(guarded.state, observation(20.45, 400), [first, second]);
    expect(after.action).toMatchObject({ type: "seek", to: 30.05 });
  });

  it("starts from a zero default and handles undo at zero", () => {
    expect(createSkipState().lastTime).toBe(0);
    const target = toSkipSegment(segment(0, 5));
    const undo = undoSkip(createSkipState(0), target, 0);
    expect(undo.action).toMatchObject({ type: "seek", to: 0.01 });
  });

  it("handles two segments separately", () => {
    const first = toSkipSegment(segment(10, 20));
    const second = toSkipSegment(segment(30, 40));
    const step = observePlayback(createSkipState(29.9), observation(30.1), [first, second]);
    expect(step.action).toMatchObject({ type: "seek", to: 40.05 });
  });

  it("re-arms a skipped segment after the user rewinds before its start", () => {
    const target = toSkipSegment(segment(10, 20));
    const first = observePlayback(createSkipState(9.9), observation(10.1, 0), [target]);
    expect(first.state.skipped[target.key]).toBe(true);

    // 用户拖回 5 秒：第一次 timeupdate 只同步位置，第二次才按正常播放节奏判断。
    const rewound = observePlayback(first.state, observation(5, 2_000), [target]);
    const settled = observePlayback(rewound.state, observation(5.2, 2_050), [target]);
    expect(settled.state.skipped[target.key]).toBeUndefined();

    const near = observePlayback(settled.state, observation(9.9, 2_900), [target]);
    const again = observePlayback(near.state, observation(10.1, 3_000), [target]);
    expect(again.action).toMatchObject({ type: "seek", to: 20.05 });
  });

  it("keeps the skip armed while the playhead stays inside the segment", () => {
    const target = toSkipSegment(segment(10, 20));
    const first = observePlayback(createSkipState(9.9), observation(10.1, 0), [target]);
    const inside = observePlayback(first.state, observation(20.5, 2_000), [target]);
    expect(inside.state.skipped[target.key]).toBe(true);
  });
});

describe("起点为 0 的片段（片头带货）", () => {
  it("从 0 秒自然播放时会自动跳", () => {
    const target = toSkipSegment(segment(0, 30));
    // 视频从头播放：lastTime 初始 0，currentTime 自然涨过片段内部。
    // 跨越判定要求 lastTime < start，start=0 时 lastTime=0 永远不满足，
    // 片头片段会永远漏跳——这正是要修的缺口。
    const step = observePlayback(createSkipState(0), observation(0.3, 250), [target]);
    expect(step.action.type).toBe("seek");
  });
});

describe("起点为 0 的片段（片头带货）", () => {
  it("自动跳后拖回 0 重看，重新武装后再播会再次跳", () => {
    const target = toSkipSegment(segment(0, 30));
    // 第一次：从 0 自然播放，进入片头即跳。
    const first = observePlayback(createSkipState(0), observation(0.3, 250), [target]);
    expect(first.action).toMatchObject({ type: "seek", to: 30.05 });
    // 用户拖回 0：第一次 timeupdate 只同步位置。
    const rewound = observePlayback(first.state, observation(0, 2_000), [target]);
    const settled = observePlayback(rewound.state, observation(0.05, 2_050), [target]);
    // 重新武装后再次自然播放，应当再次跳过。
    const again = observePlayback(settled.state, observation(0.3, 2_300), [target]);
    expect(again.action).toMatchObject({ type: "seek", to: 30.05 });
  });
});

describe("起点为 0 的片段（片头带货）", () => {
  it("用户向前拖进片段中间（没有重新武装）不会被弹开", () => {
    const target = toSkipSegment(segment(0, 30));
    // 从 5 秒开始播放（打开页面时视频已在播），自然步进到片段中间。
    const base = observePlayback(createSkipState(5), observation(5.2, 250), [target]);
    expect(base.action.type).toBe("none");
    // 向前拖到 20 秒：delta > 1.5 是拖动，不是自然播放，不应该触发跳过。
    const dragged = observePlayback(base.state, observation(20, 2_000), [target]);
    expect(dragged.action.type).toBe("none");
    // 拖定后自然播放，也不应该跳：用户主动看这段内容。
    const after = observePlayback(dragged.state, observation(20.2, 2_250), [target]);
    expect(after.action.type).toBe("none");
  });
});

describe("起点为 0 的片段（片头带货）", () => {
  it("回拖到 0 武装后又拖到片段之外，武装痕迹不能残留", () => {
    const target = toSkipSegment(segment(0, 30));
    // 自动跳一次。
    const first = observePlayback(createSkipState(0), observation(0.3, 250), [target]);
    expect(first.action.type).toBe("seek");
    // 拖回 0：重新武装。
    const rewound = observePlayback(first.state, observation(0, 2_000), [target]);
    // 又拖到 60 秒（片段之外）：武装应该作废。
    const away = observePlayback(rewound.state, observation(60, 2_300), [target]);
    expect(away.action.type).toBe("none");
    // 拖回片段内部（10 秒）：用户主动看这段内容，武装已作废，不能被弹开。
    const backInside = observePlayback(away.state, observation(10, 2_600), [target]);
    expect(backInside.action.type).toBe("none");
    // 拖定后自然播放也不跳。
    const later = observePlayback(backInside.state, observation(10.2, 2_850), [target]);
    expect(later.action.type).toBe("none");
  });
});
