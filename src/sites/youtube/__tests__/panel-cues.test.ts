// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { buildPanelParams, parsePanelCues } from "../panel-cues";

/** 按真实响应复制结构：面板段在很深的嵌套里，深度守卫写浅了会整段跳过。 */
function panelResponse(segments: Array<[string, string]>): unknown {
  return {
    content: {
      engagementPanelSectionListRenderer: {
        content: {
          sectionListRenderer: {
            contents: [
              {
                itemSectionRenderer: {
                  contents: [
                    {
                      macroMarkersPanelItemViewModel: {
                        item: {
                          timelineItemViewModel: {
                            contentItems: segments.map(([timestamp, simpleText]) => ({
                              transcriptSegmentViewModel: { timestamp, simpleText }
                            }))
                          }
                        }
                      }
                    }
                  ]
                }
              }
            ]
          }
        }
      }
    }
  };
}

describe("buildPanelParams", () => {
  it("真实样例：合成值与页面上的 params 一致", () => {
    // 四支视频在真机上抓到的原始 params（与页面描述区按钮上的值对比过）。
    expect(buildPanelParams("EwtcDviZg68")).toBe("qgkPCgtFd3RjRHZpWmc2OBgC");
    expect(buildPanelParams("dQw4w9WgXcQ")).toBe("qgkPCgtkUXc0dzlXZ1hjURgC");
    expect(buildPanelParams("9bZkp7q19f0")).toBe("qgkPCgs5YlprcDdxMTlmMBgC");
    // 这一支页面上最后一位是 B（内层 field 3 = 1），合成为 C（= 2）；
    // 实测两种都返回同一份 3 段字幕，所以固定用 2 不影响结果。
    expect(buildPanelParams("jNQXAC9IVRw")).toBe("qgkPCgtqTlFYQUM5SVZSdxgC");
  });

  it("解码后是 {149: {1: videoId, 3: 2}}，参数由 videoId 唯一决定", () => {
    const binary = atob(buildPanelParams("EwtcDviZg68"));
    const bytes = [...binary].map((char) => char.charCodeAt(0));
    expect(bytes.slice(0, 2)).toEqual([0xaa, 0x09]);
    expect(bytes[2]).toBe(bytes.length - 3);
    expect(bytes.slice(3)).toEqual([
      0x0a,
      "EwtcDviZg68".length,
      ..."EwtcDviZg68".split("").map((char) => char.charCodeAt(0)),
      0x18,
      0x02
    ]);
    expect(buildPanelParams("EwtcDviZg69")).not.toBe(buildPanelParams("EwtcDviZg68"));
  });
});

describe("parsePanelCues", () => {
  it("新 UI：起点取 timestamp，结尾取下一条起点，末尾 +2s", () => {
    const cues = parsePanelCues(panelResponse([["0:00", "开头"], ["0:08", "第二段"]]));
    expect(cues).toEqual([
      { start: 0, end: 8, text: "开头" },
      { start: 8, end: 10, text: "第二段" }
    ]);
  });

  it("按起点排序，超出视频时长的段原样保留（截断由客户端决定）", () => {
    const cues = parsePanelCues(
      panelResponse([["1:30", "超出"], ["0:00", "开头"], ["0:09", "中间"]])
    );
    expect(cues).toEqual([
      { start: 0, end: 9, text: "开头" },
      { start: 9, end: 90, text: "中间" },
      { start: 90, end: 92, text: "超出" }
    ]);
  });

  it("兼容旧 UI 的 transcriptSegmentRenderer：startMs 与 snippet.runs", () => {
    const cues = parsePanelCues(
      {
        items: [
          {
            transcriptSegmentRenderer: {
              startMs: "8000",
              snippet: { runs: [{ text: "旧" }, { text: "结构" }] }
            }
          },
          {
            transcriptSegmentRenderer: {
              startMs: "12000",
              snippet: { simpleText: "第二条" }
            }
          }
        ]
      }
    );

    expect(cues).toEqual([
      { start: 8, end: 12, text: "旧结构" },
      { start: 12, end: 14, text: "第二条" }
    ]);
  });

  it("旧 UI 段缺起点或空文本时跳过，只留能用的", () => {
    const cues = parsePanelCues(
      {
        items: [
          { transcriptSegmentRenderer: { startMs: "坏", snippet: { simpleText: "坏起点" } } },
          { transcriptSegmentRenderer: { startMs: "1000", snippet: {} } },
          { transcriptSegmentRenderer: { startMs: "2000", snippet: { simpleText: "留下" } } }
        ]
      }
    );

    expect(cues).toEqual([{ start: 2, end: 4, text: "留下" }]);
  });

  it("没有有效段时返回空数组", () => {
    expect(parsePanelCues({ content: {} })).toEqual([]);
    expect(parsePanelCues(null)).toEqual([]);
  });
});
