import { describe, expect, it } from "vitest";
import { parseDanmakuXml } from "../api/danmaku";

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<i>
  <maxlimit>1000</maxlimit>
  <d p="9.5,1,25,16777215,1600000000,0,abc,123,10">第二条 &amp; 测试</d>
  <d p="1.5,1,25,16777215,1600000000,0,abc,124,10">第一条 &lt;广告&gt;</d>
  <d p="2.0,4,25,16777215,1600000000,0,abc,125,10"><![CDATA[第三条]]></d>
  <d p="3.0,1,25,16777215,1600000000,0,abc,126,10">带控制字符\u0000的弹幕</d>
  <d p="4.0,1,25,16777215,1600000000,0,abc,127,10"/>
</i>`;

describe("parseDanmakuXml", () => {
  it("parses items, decodes entities, and strips control characters", () => {
    const result = parseDanmakuXml(xml);
    expect(result.items).toHaveLength(4);
    expect(result.items.map((item) => item.time)).toEqual([1.5, 2, 3, 9.5]);
    expect(result.items[0]?.text).toBe("第一条 <广告>");
    expect(result.items[1]?.text).toBe("第三条");
    expect(result.items[2]?.text).toBe("带控制字符的弹幕");
    expect(result.items[3]?.text).toBe("第二条 & 测试");
  });

  it("returns empty data when there are no items", () => {
    expect(parseDanmakuXml("<i><maxlimit>10</maxlimit></i>")).toEqual({ items: [] });
    expect(parseDanmakuXml("not xml").items).toEqual([]);
  });

  it("handles single-quoted attributes and skips invalid rows", () => {
    const result = parseDanmakuXml(
      "<i><d p='1,1,25,0,0,0,x,1,10'>单引号</d><d p='bad'>坏行</d><d p=\"2,1,25,0,0,0,x,2,10\"/></i>"
    );
    expect(result.items).toEqual([{ time: 1, mode: 1, text: "单引号" }]);
  });

  it("cleans illegal XML characters and decodes entities", () => {
    const result = parseDanmakuXml(
      '<i><d p="1,1,25,0,0,0,x,1,10">a\u0000b\u0008c &amp;&lt;&gt;&quot;&apos;&#65;&#x42;</d></i>'
    );
    expect(result.items[0]?.text).toBe("abc &<>\"'AB");
  });

  it("过滤高级弹幕与代码弹幕", () => {
    const result = parseDanmakuXml(
      '<i><d p="1,1,25,0,0,0,x,1,10">普通</d><d p="2,7,25,0,0,0,x,2,10">{"x":1}</d><d p="3,8,25,0,0,0,x,3,10">script</d></i>'
    );
    expect(result.items.map((item) => item.text)).toEqual(["普通"]);
  });

  it("越界数字实体只丢掉那一个字符，不让整段弹幕解析失败", () => {
    const result = parseDanmakuXml(
      '<i><d p="1,1,25,0,0,0,x,1,10">正常</d><d p="2,1,25,0,0,0,x,2,10">甲&#x110000;乙&#99999999;丙</d></i>'
    );
    expect(result.items.map((item) => item.text)).toEqual(["正常", "甲乙丙"]);
  });
});
