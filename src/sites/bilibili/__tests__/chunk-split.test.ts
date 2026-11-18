import { describe, expect, it, vi } from "vitest";
import { analyzeVideo } from "../analysis/analyzer";
import { splitAnalysisChunk } from "../analysis/chunk-split";
import { LlmError, type LlmClient } from "../../../core/ports/llm/client";
import { makeDeps } from "../../../../tests/helpers/analysis";

describe("splitAnalysisChunk", () => {
  it("有台词时按台词字数拆成首尾相接的两块", () => {
    const chunk = {
      index: 0,
      start: 0,
      end: 300,
      cues: [
        { start: 10, end: 15, text: "一二三四五" },
        { start: 20, end: 25, text: "一二三四五" },
        { start: 30, end: 35, text: "一二三四五" },
        { start: 40, end: 45, text: "一二三四五" }
      ]
    };
    const split = splitAnalysisChunk(chunk);
    expect(split).not.toBeNull();
    const [first, second] = split as [typeof chunk, typeof chunk];
    expect(first.start).toBe(0);
    expect(first.end).toBe(30);
    expect(first.cues?.map((cue) => cue.start)).toEqual([10, 20]);
    expect(second.start).toBe(30);
    expect(second.end).toBe(300);
    expect(second.cues?.map((cue) => cue.start)).toEqual([30, 40]);
  });

  it("没有台词时按时间中点拆", () => {
    const split = splitAnalysisChunk({ index: 1, start: 0, end: 300 });
    expect(split).toEqual([
      { index: 1, start: 0, end: 150 },
      { index: 2, start: 150, end: 300 }
    ]);
  });

  it("时间跨度太小就拆不动", () => {
    expect(splitAnalysisChunk({ index: 0, start: 10, end: 10.5 })).toBeNull();
  });
});

describe("输出耗尽后的自动拆分", () => {
  it("第一块输出耗尽时拆成两个子块继续，不中断对话", async () => {
    let calls = 0;
    const llm: LlmClient = {
      complete: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new LlmError("推理耗尽输出额度", "truncated");
        return '{"segments":[]}';
      })
    };
    const onProgress = vi.fn();
    const result = await analyzeVideo(
      { bvid: "BV1test", page: 1 },
      makeDeps({ llm, onProgress })
    );

    expect(llm.complete).toHaveBeenCalledTimes(4);
    expect(result.warnings).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(onProgress.mock.calls.at(-1)).toEqual([3, 3]);

    const firstSplitPrompt = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[1]?.[0];
    const secondSplitPrompt = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[2]?.[0];
    expect(firstSplitPrompt?.at(-1)?.content).toContain("210.0s");
    expect(secondSplitPrompt?.at(-1)?.content).toContain("210.0s");
    expect(secondSplitPrompt?.at(-1)?.content).toContain("300.0s");
  });
});
