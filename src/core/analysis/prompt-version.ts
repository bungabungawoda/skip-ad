import type { SegmentKind } from "../plugin/types";
import { SEGMENT_KINDS } from "../plugin/types";

/**
 * 用户改写了类型描述时，把它们折进缓存键使用的 promptVersion，
 * 保证改描述之后的分析不会命中改之前缓存的结果。
 * 由各站分析器在算缓存键时调用，这里只提供纯函数。
 */
export function effectivePromptVersion(
  promptVersion: string,
  overrides?: Partial<Record<SegmentKind, string>>
): string {
  const entries = SEGMENT_KINDS.map((kind) => [kind, (overrides?.[kind] ?? "").trim()] as const)
    .filter(([, text]) => text.length > 0);
  if (entries.length === 0) return promptVersion;
  const source = entries.map(([kind, text]) => `${kind}:${text}`).join("|");
  let hash = 5381;
  for (let i = 0; i < source.length; i += 1) {
    hash = ((hash * 33) ^ source.charCodeAt(i)) >>> 0;
  }
  return `${promptVersion}:${hash.toString(16).padStart(8, "0")}`;
}
