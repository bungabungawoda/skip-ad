import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  KIND_PROMPT_MAX_LENGTH,
  allowedPolicies,
  evaluateSegments,
  normalizeKindOrder,
  normalizeKindPromptOverrides,
  normalizePolicy,
  resolveOverlapsByKindOrder
} from "../../policy/policy";
import { SEGMENT_KINDS, type EvidenceFamily, type Segment, type SegmentKind } from "../../plugin/types";
import type { AnalysisPolicy } from "../../analysis/types";

function segment(
  kind: SegmentKind,
  start = 10,
  end = 20,
  confidence = 0.9,
  families: EvidenceFamily[] = []
): Segment {
  return {
    start,
    end,
    kind,
    confidence,
    evidence: ["原文"],
    reason: "",
    families
  };
}

function policy(overrides: Partial<AnalysisPolicy> = {}): AnalysisPolicy {
  return { ...DEFAULT_POLICY, perKind: { ...DEFAULT_POLICY.perKind }, ...overrides };
}

describe("policy", () => {
  it("uses the default type policy", () => {
    const result = evaluateSegments(
      [
        segment("sponsor"),
        segment("self_promo", 30, 35),
        segment("topic", 40, 50),
        segment("unknown", 60, 65)
      ],
      100,
      policy(),
      "full"
    );
    expect(result.auto.map((item) => item.kind)).toEqual(["sponsor", "self_promo"]);
    expect(result.mark.map((item) => item.kind)).toEqual(["unknown"]);
    expect(result.off.map((item) => item.kind)).toEqual(["topic"]);
  });

  it("allows auto skipping up to 60% by default", () => {
    const allowed = evaluateSegments([segment("sponsor", 0, 60)], 100, policy(), "full");
    expect(allowed.guardTriggered).toBe(false);
    expect(allowed.auto).toHaveLength(1);

    const blocked = evaluateSegments([segment("sponsor", 0, 61)], 100, policy(), "full");
    expect(blocked.guardTriggered).toBe(true);
    expect(blocked.auto).toEqual([]);
  });

  it("accepts confidence exactly at the threshold", () => {
    const result = evaluateSegments([segment("sponsor", 10, 20, 0.7)], 100, policy(), "full");
    expect(result.auto).toHaveLength(1);
  });

  it("returns segments in time order", () => {
    const result = evaluateSegments(
      [segment("sponsor", 50, 60), segment("sponsor", 10, 20)],
      100,
      policy(),
      "full"
    );
    expect(result.auto.map((item) => item.start)).toEqual([10, 50]);
  });

  it("does not guard when coverage is exactly at the limit", () => {
    const result = evaluateSegments(
      [segment("sponsor", 0, 25, 0.9)],
      100,
      policy({ maxAutoCoverage: 0.25 }),
      "full"
    );
    expect(result.guardTriggered).toBe(false);
    expect(result.auto).toHaveLength(1);
  });

  it("requires the confidence threshold", () => {
    const result = evaluateSegments([segment("sponsor", 10, 20, 0.69)], 100, policy(), "full");
    expect(result.auto).toEqual([]);
    expect(result.mark).toHaveLength(1);
  });

  it("requires three evidence families in danmaku mode", () => {
    const weak = evaluateSegments(
      [segment("sponsor", 10, 20, 0.9, ["jump_coordinate", "ad_word"])],
      100,
      policy(),
      "danmaku"
    );
    expect(weak.auto).toEqual([]);
    const strong = evaluateSegments(
      [segment("sponsor", 10, 20, 0.9, ["jump_coordinate", "ad_word", "divergent_term"])],
      100,
      policy(),
      "danmaku"
    );
    expect(strong.auto).toHaveLength(1);
    const noStrong = evaluateSegments(
      [segment("sponsor", 10, 20, 0.9, ["divergent_term", "chapter", "transcript"])],
      100,
      policy(),
      "danmaku"
    );
    expect(noStrong.auto).toEqual([]);
  });

  it("can disable danmaku auto skipping", () => {
    const result = evaluateSegments(
      [segment("sponsor", 10, 20, 0.9, ["jump_coordinate", "ad_word", "divergent_term"])],
      100,
      policy({ danmakuAutoEnabled: false }),
      "danmaku"
    );
    expect(result.auto).toEqual([]);
  });

  it("downgrades everything when auto coverage is too high", () => {
    const result = evaluateSegments(
      [segment("sponsor", 0, 15, 0.9), segment("promo", 20, 40, 0.9)],
      100,
      policy({ maxAutoCoverage: 0.25 }),
      "full"
    );
    expect(result.guardTriggered).toBe(true);
    expect(result.auto).toEqual([]);
    expect(result.mark).toHaveLength(2);
  });

  it("normalizes partial policy input", () => {
    const normalized = normalizePolicy({
      perKind: { sponsor: "off", self_promo: "auto", topic: "auto" },
      confidenceThreshold: 2,
      maxAutoCoverage: 0
    });
    expect(normalized.perKind.sponsor).toBe("off");
    expect(normalized.perKind.self_promo).toBe("auto");
    // 主题内容不允许自动跳（界面也只给「只标记 / 关闭」），存储层要把它夹回 off。
    expect(normalized.perKind.topic).toBe("off");
    expect(normalized.perKind.unknown).toBe(DEFAULT_POLICY.perKind.unknown);
    expect(normalized.confidenceThreshold).toBe(1);
    expect(normalized.maxAutoCoverage).toBe(0.01);
    expect(normalized.danmakuAutoEnabled).toBe(true);
    expect(normalizePolicy({ danmakuAutoEnabled: false }).danmakuAutoEnabled).toBe(false);
    expect(normalizePolicy({ perKind: { sponsor: "bad" } }).perKind.sponsor).toBe("auto");
  });
});

describe("界面可选策略", () => {
  it("topic 与 unknown 只给 mark/off，其余四类给 auto/mark/off", () => {
    expect(allowedPolicies("topic")).toEqual(["mark", "off"]);
    expect(allowedPolicies("unknown")).toEqual(["mark", "off"]);
    for (const kind of ["sponsor", "insert", "promo", "self_promo"] as const) {
      expect(allowedPolicies(kind)).toEqual(["auto", "mark", "off"]);
    }
  });
});

describe("类型优先级与描述改写", () => {
  it("kindOrder 去重、剔除非法值并补全缺失类型", () => {
    const order = normalizeKindOrder(["promo", "promo", "bogus", "sponsor"]);
    expect(order.slice(0, 2)).toEqual(["promo", "sponsor"]);
    expect([...order].sort()).toEqual([...SEGMENT_KINDS].sort());
  });

  it("只保留合法类型的非空描述，超长截断；全空返回 undefined", () => {
    expect(
      normalizeKindPromptOverrides({ sponsor: " 口播带货都跳 ", promo: "", bogus: "x" })
    ).toEqual({ sponsor: "口播带货都跳" });
    const long = "a".repeat(KIND_PROMPT_MAX_LENGTH + 50);
    expect(normalizeKindPromptOverrides({ insert: long })?.insert).toHaveLength(
      KIND_PROMPT_MAX_LENGTH
    );
    expect(normalizeKindPromptOverrides({ sponsor: "   " })).toBeUndefined();
    expect(normalizeKindPromptOverrides("nope")).toBeUndefined();
  });
});

describe("跨类型重叠按 kindOrder 取舍", () => {
  it("跨类型重叠：排名靠前的类型占住重叠区，排名靠后的保留剩余区间", () => {
    const sponsor = segment("sponsor", 0, 100);
    const promo = segment("promo", 50, 150);
    expect(resolveOverlapsByKindOrder([sponsor, promo], DEFAULT_POLICY.kindOrder)).toEqual([
      sponsor,
      { ...promo, start: 100, end: 150 }
    ]);
    expect(
      resolveOverlapsByKindOrder(
        [sponsor, promo],
        ["promo", "sponsor", "insert", "self_promo", "topic", "unknown"]
      )
    ).toEqual([{ ...sponsor, start: 0, end: 50 }, promo]);
    expect(
      resolveOverlapsByKindOrder(
        [sponsor, segment("sponsor", 50, 150)],
        DEFAULT_POLICY.kindOrder
      )
    ).toHaveLength(2);
  });

  it("一段短片盖住长片段时，不把长片段的剩余部分一起删掉", () => {
    const sponsor = segment("sponsor", 100, 105);
    const promo = segment("promo", 100, 160);
    expect(resolveOverlapsByKindOrder([sponsor, promo], DEFAULT_POLICY.kindOrder)).toEqual([
      sponsor,
      { ...promo, start: 105, end: 160 }
    ]);
  });

  it("完全被覆盖的片段整条丢弃，不足 1 秒的残段也保留", () => {
    const sponsor = segment("sponsor", 10, 20);
    expect(
      resolveOverlapsByKindOrder([sponsor, segment("promo", 10, 20)], DEFAULT_POLICY.kindOrder)
    ).toEqual([sponsor]);
    // 残段 0.5 秒也要保留：丢掉它等于这段时间既不标也不跳，覆盖统计里也不出现。
    const sliver = segment("promo", 9.5, 20);
    expect(
      resolveOverlapsByKindOrder([sponsor, sliver], DEFAULT_POLICY.kindOrder)
    ).toEqual([{ ...sliver, start: 9.5, end: 10 }, sponsor]);
  });

  it("多个更强片段一起裁剪同一个片段", () => {
    const promo = segment("promo", 0, 100);
    const first = segment("sponsor", 10, 20);
    const second = segment("sponsor", 30, 40);
    expect(
      resolveOverlapsByKindOrder([promo, first, second], DEFAULT_POLICY.kindOrder)
    ).toEqual([
      { ...promo, start: 0, end: 10 },
      first,
      { ...promo, start: 20, end: 30 },
      second,
      { ...promo, start: 40, end: 100 }
    ]);
  });
});
