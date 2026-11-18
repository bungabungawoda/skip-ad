import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../policy/policy";
import { evaluateSessionPolicy } from "../session-policy";
import { segment } from "../../../../tests/helpers/segments";

describe("会话策略：展示与自动跳的唯一入口", () => {
  const policy = DEFAULT_POLICY;

  it("重叠裁剪后的视图仍带原始片段 key，命令能找回原片段", () => {
    // sponsor 排名靠前，promo 被裁成 100-150；展示用裁剪区间，key 仍指原始 promo。
    const decision = evaluateSessionPolicy({
      segments: [segment("sponsor", 0, 100), segment("promo", 50, 150)],
      policy,
      mode: "full",
      durationSec: 600,
      ignoredKeys: new Set()
    });
    const promoView = decision.views.find((view) => view.segment.kind === "promo");
    expect(promoView?.segment).toMatchObject({ start: 100, end: 150 });
    expect(promoView?.key).toBe(segment("promo", 50, 150).start.toFixed(2) + "-" + segment("promo", 50, 150).end.toFixed(2));
  });

  it("open 片段按「读到结尾都是广告」跳到结尾；关闭的类型不出现", () => {
    const decision = evaluateSessionPolicy({
      // topic 默认关闭，即使 open 也不展示；sponsor 补到 1000 后覆盖 30%，不触发上限。
      segments: [segment("topic", 10, 20, { status: "open" }), segment("sponsor", 700, 710, { status: "open" })],
      policy,
      mode: "full",
      durationSec: 1000,
      ignoredKeys: new Set()
    });
    expect(decision.views.map((view) => view.segment.kind)).toEqual(["sponsor"]);
    expect(decision.views[0]?.policy).toBe("auto");
    expect(decision.views[0]?.segment.end).toBe(1000);
    expect(decision.auto[0]?.end).toBe(1000);
    expect(decision.invalid).toBeUndefined();
  });

  it("被类型优先级淘汰的片段不进入展示视图", () => {
    const decision = evaluateSessionPolicy({
      segments: [segment("topic", 100, 120), segment("sponsor", 105, 125)],
      policy,
      mode: "full",
      durationSec: 600,
      ignoredKeys: new Set()
    });
    expect(decision.views.map((view) => view.segment.kind)).toEqual(["sponsor"]);
    expect(decision.auto).toHaveLength(1);
  });

  it("覆盖率超限时改为一条整片广告标记并自动跳", () => {
    const segments = [segment("sponsor", 0, 100)];
    const long = evaluateSessionPolicy({
      segments,
      policy,
      mode: "full",
      durationSec: 900,
      ignoredKeys: new Set()
    });
    expect(long.views[0]?.policy).toBe("auto");
    expect(long.auto).toHaveLength(1);

    const short = evaluateSessionPolicy({
      segments,
      policy,
      mode: "full",
      // 100 / 150 超过 60% 上限，和上面的 100 / 900 形成对照。
      durationSec: 150,
      ignoredKeys: new Set()
    });
    expect(short.auto).toEqual([{ start: 0, end: 150, key: "0.00-150.00" }]);
    expect(short.views).toHaveLength(1);
    expect(short.views[0]).toMatchObject({
      policy: "auto",
      segment: { start: 0, end: 150 }
    });
    expect(short.invalid).toBeUndefined();
  });

  it("「不是广告」标记过滤片段与自动跳列表", () => {
    const target = segment("sponsor", 10, 20);
    const decision = evaluateSessionPolicy({
      segments: [target, segment("sponsor", 30, 40)],
      policy,
      mode: "full",
      durationSec: 600,
      ignoredKeys: new Set(["10.00-20.00"])
    });
    expect(decision.views).toHaveLength(1);
    expect(decision.auto).toHaveLength(1);
  });

  it("连续对话里未闭合片段补到结尾后仍自动跳", () => {
    const decision = evaluateSessionPolicy({
      segments: [
        segment("sponsor", 270, 300, { status: "open" }),
        segment("sponsor", 100, 120, { status: "closed" })
      ],
      policy,
      mode: "full",
      durationSec: 600,
      ignoredKeys: new Set()
    });
    // 20 + (600-270)=350，350/600≈58%，未超过 60% 上限。
    expect(decision.auto.map((item) => item.end)).toEqual([120, 600]);
    expect(decision.views).toHaveLength(2);
    expect(decision.invalid).toBeUndefined();
  });

  it("未闭合片段补到结尾后超限，按模型异常处理：不展示也不跳", () => {
    const decision = evaluateSessionPolicy({
      segments: [segment("sponsor", 20, 30, { status: "open" })],
      policy,
      mode: "full",
      // 补到 100 后覆盖 80/100=80%，超过上限。
      durationSec: 100,
      ignoredKeys: new Set()
    });
    expect(decision.auto).toEqual([]);
    expect(decision.views).toEqual([]);
    expect(decision.invalid).toContain("没有给出结尾");
  });

  it("未闭合片段同样受「不是广告」标记过滤", () => {
    const decision = evaluateSessionPolicy({
      segments: [segment("sponsor", 270, 300, { status: "open" })],
      policy,
      mode: "full",
      durationSec: 600,
      ignoredKeys: new Set(["270.00-300.00"])
    });
    expect(decision.views).toEqual([]);
    expect(decision.auto).toEqual([]);
  });

  it("时长缺失时既不自跳也不标记，避免用户看到标记却等不到跳转", () => {
    const decision = evaluateSessionPolicy({
      segments: [segment("sponsor", 0, 100)],
      policy,
      mode: "full",
      durationSec: 0,
      ignoredKeys: new Set()
    });
    expect(decision.auto).toHaveLength(0);
    expect(decision.views).toHaveLength(0);
    expect(decision.invalid).toBeDefined();
  });

  it("只展示会自动跳的片段，按起点排序；不会跳的低置信度片段不出现", () => {
    // 故意乱序入队，钉住排序比较器；低置信度片段不该出现。
    const decision = evaluateSessionPolicy({
      segments: [
        segment("sponsor", 200, 210),
        segment("sponsor", 50, 60),
        segment("sponsor", 100, 105),
        segment("sponsor", 120, 130),
        segment("sponsor", 120, 125),
        segment("sponsor", 300, 310, { confidence: 0.5 })
      ],
      policy,
      mode: "full",
      durationSec: 600,
      ignoredKeys: new Set()
    });
    expect(decision.views.map((view) => [view.segment.start, view.segment.end])).toEqual([
      [50, 60],
      [100, 105],
      [120, 125],
      [120, 130],
      [200, 210]
    ]);
    expect(decision.invalid).toBeUndefined();
  });

  it("低于置信度阈值的片段不展示也不自动跳", () => {
    const decision = evaluateSessionPolicy({
      segments: [segment("sponsor", 10, 20, { confidence: 0.5 })],
      policy,
      mode: "full",
      durationSec: 600,
      ignoredKeys: new Set()
    });
    expect(decision.views).toEqual([]);
    expect(decision.auto).toEqual([]);
  });
});
