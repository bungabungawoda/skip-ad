import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SEGMENT_BAR_COLORS } from "../segment-colors";
import { KIND_META } from "../kinds";
import type { SegmentKind } from "../../plugin/types";

/**
 * 原生进度条不在 Shadow DOM 里，取不到 --seg-* 变量，色值只能复制一份到 TS。
 * 这个测试读 globals.css 的深色主题块，保证两份不会各改各的。
 */
const css = readFileSync(new URL("../../../styles/globals.css", import.meta.url), "utf8");
const darkBlock = css.slice(css.indexOf('[data-theme="dark"] {'));

function darkValue(variable: string): string | null {
  const match = darkBlock.match(new RegExp(`${variable}:\\s*(#[0-9a-fA-F]{6})`));
  return match?.[1]?.toLowerCase() ?? null;
}

describe("原生进度条色块颜色", () => {
  it("与 globals.css 深色主题的 --seg-* 一一对应", () => {
    const kinds = Object.keys(SEGMENT_BAR_COLORS) as SegmentKind[];
    for (const kind of kinds) {
      const variable = KIND_META[kind].cssVar;
      expect(darkValue(variable), `${kind} 对应的 ${variable} 没找到`).toBe(
        SEGMENT_BAR_COLORS[kind].toLowerCase()
      );
    }
  });
});
