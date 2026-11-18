import { describe, expect, it, vi } from "vitest";
import { analyzeVideo } from "../analysis/analyzer";
import type { LlmClient } from "../../../core/ports/llm/client";
import type { LlmMessage } from "../../../core/ports/llm/types";
import { DEFAULT_POLICY } from "../../../core/policy/policy";
import { evaluateSessionPolicy } from "../../../core/ui/session-policy";
import { FILLER, cues, makeClient, makeDeps, makeVideo } from "../../../../tests/helpers/analysis";

/** 按调用顺序返回不同响应，并把每轮真正送出去的 messages 留下来核对。 */
function sequenceLlm(responses: string[]) {
  const calls: LlmMessage[][] = [];
  let index = 0;
  const llm: LlmClient = {
    complete: vi.fn(async (messages: LlmMessage[]) => {
      calls.push([...messages]);
      const response = responses[Math.min(index, responses.length - 1)] ?? '{"segments":[]}';
      index += 1;
      return response;
    }),
  };
  return { llm, calls };
}

const segmentJson = (raw: Record<string, unknown>): string =>
  JSON.stringify({ segments: [raw] });

const adStart = {
  start: 270,
  end: 300,
  status: "open",
  kind: "insert",
  confidence: 0.98,
  evidence: ["海力生鱼油"],
  reason: "广告开始"
};

const adFinished = {
  start: 270,
  end: 409,
  status: "closed",
  kind: "promo",
  confidence: 0.99,
  evidence: ["海力生鱼油", "点击下方链接"],
  reason: "完整口播"
};

const TABLE_WITH_AD = segmentJson(adFinished);
const NO_ADS = '{"segments":[]}';

describe("连续对话：一个视频一个对话", () => {
  it("系统提示只发一次，每轮把「证据 / 整表」问答追加进同一份历史", async () => {
    const { llm, calls } = sequenceLlm([NO_ADS, NO_ADS]);
    await analyzeVideo({ bvid: "BV1test", page: 1 }, makeDeps({ llm }));

    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveLength(2); // system + 第 1 轮证据
    expect(calls[1]).toHaveLength(4); // system + user + assistant + 第 2 轮证据
    expect(calls[0]?.[0]?.role).toBe("system");
    expect(calls[1]?.[0]?.content).toBe(calls[0]?.[0]?.content);
    // assistant 回写的是规范化后的紧凑整表，不是带 <think> 的模型原文。
    expect(calls[1]?.[2]).toEqual({ role: "assistant", content: '{"segments":[]}' });
    expect(calls[0]?.[1]?.content).toContain("第 1 / 2 段内容");
    expect(calls[1]?.[3]?.content).toContain("第 2 / 2 段内容");
    expect(calls[1]?.[3]?.content).not.toContain("上一轮你给出的完整片段表");
    expect(calls[1]?.[3]?.content).toContain("请输出「到此为止的完整片段表」");
  });

  it("系统提示要求整表可修订，并用 open/closed 区分有没有看到结尾", async () => {
    const { llm, calls } = sequenceLlm([NO_ADS]);
    await analyzeVideo({ bvid: "BV1test", page: 1 }, makeDeps({ llm }));
    const system = calls[0]?.[0]?.content ?? "";
    expect(system).toContain("连续对话");
    expect(system).toContain('"status":"open"');
    expect(system).toContain('"status":"closed"');
    expect(system).toContain("end 不得超过该时间点");
  });

  it("严格按时间顺序，播放位置不重排分块", async () => {
    const { llm, calls } = sequenceLlm([NO_ADS]);
    await analyzeVideo({ bvid: "BV1test", page: 1, currentTime: 590 }, makeDeps({ llm }));
    expect(calls[0]?.[1]?.content).toContain("第 1 / 2 段内容");
    expect(calls[0]?.[1]?.content).toContain("00:00 (0.0s) - 05:00 (300.0s)");
    expect(calls[1]?.[3]?.content).toContain("05:00 (300.0s) - 10:00 (600.0s)");
  });

  it("相邻两轮证据不重叠：同一条台词不会在两轮里重复出现", async () => {
    const { llm, calls } = sequenceLlm([NO_ADS]);
    await analyzeVideo({ bvid: "BV1test", page: 1 }, makeDeps({ llm }));
    const first = calls[0]?.[1]?.content ?? "";
    const second = calls[1]?.[3]?.content ?? "";
    expect(first).toContain("接下来是广告时间");
    expect(first).not.toContain("今天就聊到这里");
    expect(second).toContain("今天就聊到这里");
    expect(second).not.toContain("接下来是广告时间");
  });
});

describe("连续对话：跨 5:00 边界的广告不再被截短", () => {
  it("第 1 轮标 open，第 2 轮把同一片段修订到真实结尾 409，最终只有一条", async () => {
    const { llm, calls } = sequenceLlm([segmentJson(adStart), TABLE_WITH_AD]);
    const onPartial = vi.fn();
    const result = await analyzeVideo(
      { bvid: "BV1test", page: 1 },
      { ...makeDeps({ llm }), onPartial }
    );

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({
      start: 270,
      end: 409,
      kind: "promo",
      status: "closed"
    });
    // 上一轮的 open 表写回对话历史（assistant 消息），模型从这里知道该改哪一条。
    expect(calls[1]?.[2]?.content).toContain('"status":"open"');
    expect(calls[1]?.[2]?.content).toContain("270");

    const firstPartial = onPartial.mock.calls[0]?.[0];
    expect(firstPartial.segments[0]).toMatchObject({ start: 270, end: 300, status: "open" });
    // 就是这个 open 让 300.05 不会成为跳跃终点。
    const early = evaluateSessionPolicy({
      segments: firstPartial.segments,
      policy: DEFAULT_POLICY,
      mode: "full",
      durationSec: 600,
      ignoredKeys: new Set()
    });
    // open 片段按「读到结尾都是广告」处理，补到视频结尾并自动跳。
    expect(early.auto[0]?.end).toBe(600);
    expect(early.views[0]?.policy).toBe("auto");

    const finalDecision = evaluateSessionPolicy({
      segments: result.segments,
      policy: DEFAULT_POLICY,
      mode: "full",
      durationSec: 600,
      ignoredKeys: new Set()
    });
    expect(finalDecision.auto[0]?.end).toBe(409);
  });

  it("声称 closed 却越过已读边界时降级为 open，终点钉在已读边界", async () => {
    // 第 1 轮只读到 300s，模型却写出 409s 的结尾：不能采信没读过的部分。
    const hallucinated = segmentJson({ ...adFinished, reason: "编造的结尾" });
    const { llm } = sequenceLlm([hallucinated, NO_ADS]);
    const onPartial = vi.fn();
    await analyzeVideo({ bvid: "BV1test", page: 1 }, { ...makeDeps({ llm }), onPartial });

    expect(onPartial.mock.calls[0]?.[0].segments[0]).toMatchObject({
      start: 270,
      end: 300,
      status: "open"
    });
    const early = evaluateSessionPolicy({
      segments: onPartial.mock.calls[0]?.[0].segments,
      policy: DEFAULT_POLICY,
      mode: "full",
      durationSec: 600,
      ignoredKeys: new Set()
    });
    // 补到结尾后覆盖 330/600≈55%，未超上限，仍自动跳到视频结尾。
    expect(early.auto[0]?.end).toBe(600);
  });

  it("起点越过已读边界的片段直接丢弃，不写缓存", async () => {
    const { llm } = sequenceLlm([
      JSON.stringify({
        segments: [
          { ...adFinished, start: 270, end: 290 },
          { ...adFinished, start: 560, end: 590, reason: "凭空猜后文" }
        ]
      }),
      NO_ADS
    ]);
    const deps = makeDeps({ llm });
    const result = await analyzeVideo({ bvid: "BV1test", page: 1 }, deps);
    expect(result.segments).toHaveLength(0);
    expect(result.warnings.some((warning) => warning.message.includes("被校验丢弃"))).toBe(true);
    await expect(deps.cache.get(result.videoKey)).resolves.toBeNull();
  });

  it("一轮的片段全在归一化阶段被丢弃时，保留上一轮的表并中断", async () => {
    // 第二条响应里的片段 start=end，归一化阶段就会被丢掉。
    // accepted.segments 也是空数组，这里不能把它当成「模型返回了无广告」。
    const first = segmentJson({ ...adFinished, start: 100, end: 120 });
    const invalid = segmentJson({
      ...adFinished,
      start: 200,
      end: 200,
      reason: "空区间"
    });
    const { llm, calls } = sequenceLlm([first, invalid]);
    const deps = makeDeps({ llm });
    const result = await analyzeVideo({ bvid: "BV1test", page: 1 }, deps);

    expect(calls).toHaveLength(2);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ start: 100, end: 120 });
    expect(result.warnings.some((warning) => warning.message.includes("全部被校验丢弃"))).toBe(
      true
    );
    await expect(deps.cache.get(result.videoKey)).resolves.toBeNull();
  });

  it("最后一轮定稿：模型仍标 open 的片段按已读边界定成 closed，允许自动跳", async () => {
    // open 片段的 end 会被钉在已读边界，所以最后一轮 open 的 end 就是视频末尾。
    // 用尾部短片段，避免覆盖率守卫把 auto 降级干扰断言本身。
    const { llm } = sequenceLlm([
      NO_ADS,
      segmentJson({ ...adStart, start: 560, end: 600 })
    ]);
    const result = await analyzeVideo({ bvid: "BV1test", page: 1 }, makeDeps({ llm }));
    expect(result.segments[0]).toMatchObject({ start: 560, end: 600, status: "closed" });
    const decision = evaluateSessionPolicy({
      segments: result.segments,
      policy: DEFAULT_POLICY,
      mode: "full",
      durationSec: 600,
      ignoredKeys: new Set()
    });
    expect(decision.auto).toHaveLength(1);
  });
});

describe("连续对话：整表替换与增量下发", () => {
  it("可以删掉上一轮误判的片段，增量结果始终是完整表", async () => {
    const first = JSON.stringify({
      segments: [
        { ...adFinished, start: 100, end: 120, kind: "sponsor" },
        { ...adFinished, start: 270, end: 290, kind: "insert" }
      ]
    });
    const second = segmentJson({ ...adFinished, start: 100, end: 135, kind: "sponsor" });
    const { llm } = sequenceLlm([first, second]);
    const onPartial = vi.fn();
    const result = await analyzeVideo(
      { bvid: "BV1test", page: 1 },
      { ...makeDeps({ llm }), onPartial }
    );

    expect(onPartial).toHaveBeenCalledTimes(2);
    expect(onPartial.mock.calls[0]?.[0].segments).toHaveLength(2);
    expect(onPartial.mock.calls[1]?.[0].segments).toHaveLength(1);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({ start: 100, end: 135, kind: "sponsor" });
  });

  it("每轮增量都带上正片时长与证据形态，覆盖率守卫不会落回 0", async () => {
    const { llm } = sequenceLlm([NO_ADS]);
    const onPartial = vi.fn();
    const onProgress = vi.fn();
    await analyzeVideo(
      { bvid: "BV1test", page: 1 },
      { ...makeDeps({ llm }), onPartial, onProgress }
    );
    expect(onPartial.mock.calls.map((call) => call[0].done)).toEqual([1, 2]);
    for (const call of onPartial.mock.calls) {
      expect(call[0]).toMatchObject({ total: 2, durationSec: 600, mode: "full" });
    }
    expect(onProgress).toHaveBeenCalledWith(2, 2);
  });

  it("任一轮失败就中断，保留上一轮的整表且不写缓存", async () => {
    const llm: LlmClient = {
      complete: vi
        .fn()
        .mockResolvedValueOnce(TABLE_WITH_AD)
        .mockRejectedValueOnce(new Error("boom")),
    };
    const deps = makeDeps({ llm });
    const result = await analyzeVideo({ bvid: "BV1test", page: 1 }, deps);
    // 第 1 轮只读到 300 秒，409 的 closed 片段按设计截到已读边界并保留 status=open；
    // 第 2 轮中断后保留下来的正是这份保守表，而不是原始的 409。
    expect(llm.complete).toHaveBeenCalledTimes(2);
    expect(result.segments).toMatchObject([
      { start: 270, end: 300, status: "open" }
    ]);
    expect(
      result.warnings.some((warning) => warning.message.includes("连续对话在第 2 段中断"))
    ).toBe(true);
    await expect(deps.cache.get(result.videoKey)).resolves.toBeNull();
  });

  it("超过保留轮数后压缩历史：更早的轮次只留摘要行，片段表仍在 assistant 消息里", async () => {
    const { llm, calls } = sequenceLlm([NO_ADS, NO_ADS, NO_ADS, NO_ADS]);
    // 1200 秒视频配 4 组台词：按台词长度分块出 4 轮，才能触发第 1 轮的压缩。
    // 填充每段 1400 字符，6000 预算约每 4 段一组；收尾那句挤在中间，
    // 正好凑出 4 组台词让对话跑满 4 轮。
    const longCues = [
      ...cues.slice(0, 4),
      ...Array.from({ length: 15 }, (_, index) => ({
        start: 130 + index * 80,
        end: 132 + index * 80,
        text: FILLER
      })),
      { start: 1150, end: 1160, text: "今天就聊到这里" }
    ];
    const longVideoDeps = makeDeps({
      llm,
      client: makeClient({
        getVideo: vi.fn(async () => ({ ...makeVideo(), duration: 1200 })),
        getSubtitle: vi.fn(async () => longCues)
      })
    });
    await analyzeVideo({ bvid: "BV1test", page: 1 }, longVideoDeps);

    expect(calls).toHaveLength(4);
    // 第 4 轮：前 3 轮里只有第 1 轮被压缩（keepRounds = 2）。
    const fourth = calls[3] ?? [];
    expect(fourth).toHaveLength(8); // system + 摘要×1 + 完整对×2 + 第 4 轮 user
    expect(fourth[1]?.content).toContain("第 1 / 4 段已读完");
    expect(fourth[1]?.content).not.toContain("本段证据");
    // 第二、三轮完整留存；各自对应的片段表都在 assistant 消息里。
    expect(fourth[3]?.content).toContain("第 2 / 4 段内容");
    expect(fourth[4]?.role).toBe("assistant");
    expect(fourth[5]?.content).toContain("第 3 / 4 段内容");
    expect(fourth[7]?.content).toContain("第 4 / 4 段内容");
  });

  it("服务商有自动前缀缓存时保留完整历史，不改写旧轮消息", async () => {
    const { llm, calls } = sequenceLlm([NO_ADS, NO_ADS, NO_ADS, NO_ADS]);
    const longCues = [
      ...cues.slice(0, 4),
      ...Array.from({ length: 15 }, (_, index) => ({
        start: 130 + index * 80,
        end: 132 + index * 80,
        text: FILLER
      })),
      { start: 1150, end: 1160, text: "今天就聊到这里" }
    ];
    const longVideoDeps = makeDeps({
      llm,
      prefixCache: true,
      client: makeClient({
        getVideo: vi.fn(async () => ({ ...makeVideo(), duration: 1200 })),
        getSubtitle: vi.fn(async () => longCues)
      })
    });
    await analyzeVideo({ bvid: "BV1test", page: 1 }, longVideoDeps);

    expect(calls).toHaveLength(4);
    const fourth = calls[3] ?? [];
    // 没有摘要行：第 1 轮的证据原样留在第 4 轮的请求里，
    // 与上一轮请求逐 token 同前缀，服务商缓存才能命中。
    expect(fourth).toHaveLength(8); // system + 3 组完整问答 + 第 4 轮 user
    expect(fourth[1]?.content).toContain("第 1 / 4 段内容");
    expect(fourth[1]?.content).not.toContain("已读完");
    expect(fourth[3]?.content).toContain("第 2 / 4 段内容");
    expect(fourth[5]?.content).toContain("第 3 / 4 段内容");
  });
});
