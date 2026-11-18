import type { AnalysisChunk } from "../../../core/analysis/planner";

/** 按台词字数找中点；每边至少留一句。 */
function halfCutIndex(cues: NonNullable<AnalysisChunk["cues"]>): number {
  if (cues.length <= 1) return 0;
  const total = cues.reduce((sum, cue) => sum + cue.text.length, 0);
  if (total === 0) return Math.max(1, Math.floor(cues.length / 2));
  let used = 0;
  for (let index = 0; index < cues.length - 1; index += 1) {
    used += cues[index]?.text.length ?? 0;
    if (used >= total / 2) return index + 1;
  }
  return cues.length - 1;
}

/**
 * 输出耗尽时把当前块拆成两个首尾相接的子块。
 * 有台词按台词分组拆，没有台词按时间中点拆；拆不动返回 null。
 *
 * 子块的边界取第二块第一句台词的起点，和初始分块器同一口径：
 * 边界时刻的内容归后一块，相邻两轮不丢不重。
 */
export function splitAnalysisChunk(
  chunk: AnalysisChunk
): [AnalysisChunk, AnalysisChunk] | null {
  const cues = chunk.cues;
  if (cues && cues.length >= 2) {
    const cut = halfCutIndex(cues);
    const firstCues = cues.slice(0, cut);
    const secondCues = cues.slice(cut);
    const boundary = secondCues[0]?.start;
    if (boundary === undefined || boundary <= chunk.start || boundary >= chunk.end) {
      return null;
    }
    return [
      { index: chunk.index, start: chunk.start, end: boundary, cues: firstCues },
      { index: chunk.index + 1, start: boundary, end: chunk.end, cues: secondCues }
    ];
  }

  const span = chunk.end - chunk.start;
  if (!(span > 1)) return null;
  const boundary = chunk.start + span / 2;
  return [
    { index: chunk.index, start: chunk.start, end: boundary },
    { index: chunk.index + 1, start: boundary, end: chunk.end }
  ];
}
