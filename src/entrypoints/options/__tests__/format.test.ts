import { describe, expect, it } from "vitest";
import { formatSavedDetail, formatSavedTime } from "../format";

describe("省下时间的展示格式", () => {
  it("单位跟着量级走", () => {
    expect(formatSavedTime(0)).toEqual({ value: "0", unit: "秒" });
    expect(formatSavedTime(45)).toEqual({ value: "45", unit: "秒" });
    expect(formatSavedTime(125)).toEqual({ value: "2", unit: "分钟" });
    // 59.98 分钟进位成 1 小时，不显示「60 分钟」。
    expect(formatSavedTime(3_599)).toEqual({ value: "1", unit: "小时" });
    expect(formatSavedTime(3_600 * 12.34)).toEqual({ value: "12.3", unit: "小时" });
  });

  it("明细写法保留零头：小时带分钟、分钟带秒", () => {
    expect(formatSavedDetail(0)).toBe("0 秒");
    expect(formatSavedDetail(45)).toBe("45 秒");
    expect(formatSavedDetail(125)).toBe("2 分 5 秒");
    expect(formatSavedDetail(3_600 + 600)).toBe("1 小时 10 分");
  });
});
