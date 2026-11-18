import type { SegmentKind } from "../plugin/types";
import { SEGMENT_KINDS } from "../plugin/types";
import { kindLabel } from "../policy/kinds";

/**
 * 用户改写的类型描述：只保留合法类型的非空文本，追加到系统提示词末尾。
 * 两个站点共用同一段拼装逻辑，只有标题与行的排版不同。
 */
export function buildTypeOverrideSection(
  overrides: Partial<Record<SegmentKind, string>> | undefined,
  heading: string,
  formatLine: (label: string, kind: SegmentKind, text: string) => string
): string {
  const lines = SEGMENT_KINDS.map((kind) => {
    const text = (overrides?.[kind] ?? "").trim();
    return text ? formatLine(kindLabel(kind), kind, text) : "";
  }).filter((line) => line.length > 0);
  if (lines.length === 0) return "";
  return `\n\n${heading}\n${lines.join("\n")}`;
}
