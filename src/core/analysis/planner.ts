import { CHUNK_CHARS_DEFAULT } from "../lib/limits";

export interface AnalysisChunk {
  index: number;
  start: number;
  end: number;
  /**
   * 本块实际包含的台词。按台词分块时由分组结果直接带出，
   * 调用方必须按它取台词，不要再按时间从全量里重筛：
   * 同起点台词会让时间区间互相重叠，重筛会把后一组整组漏掉。
   */
  cues?: Array<{ start: number; end: number; text: string }>;
}

/**
 * 没有台词时的兜底切块：按时间顺序切成首尾相接、不重叠的等长段。
 *
 * 连续对话必须从头往后读：第 N 轮的结论依赖前 N-1 轮已经读过的内容，
 * 所以这里的顺序不能被播放位置打乱。
 */
export function buildSequentialChunks(
  duration: number,
  chunkSeconds = 300
): AnalysisChunk[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const chunk = Math.max(1, chunkSeconds);
  const chunks: AnalysisChunk[] = [];
  let start = 0;
  let index = 0;
  while (start < duration) {
    const end = Math.min(duration, start + chunk);
    if (end <= start) break;
    chunks.push({ index, start, end });
    index += 1;
    if (end >= duration) break;
    start += chunk;
  }
  return chunks;
}

/**
 * 按台词长度取时间范围：累计台词到字符预算成组，块的范围就是这批台词
 * 覆盖（并延伸到下一块首句）的时间段。先切时间再裁台词会丢掉装不下的台词，
 * 而且弹幕还按整个时间窗过滤，出现「台词没发给模型、弹幕却发了」的错位；
 * 先按台词定范围，台词零裁剪，弹幕与台词永远对齐。
 * 块尾延到下一块首句起点（最后一块延到视频结尾），静音段的弹幕不丢不重。
 */
export function buildSequentialChunksFromCues(
  cues: Array<{ start: number; end: number; text: string }>,
  duration: number,
  chunkChars = CHUNK_CHARS_DEFAULT
): AnalysisChunk[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const sorted = [...cues].sort((left, right) => left.start - right.start);
  if (sorted.length === 0) return [];

  // 按字符预算把台词顺序分组；组内台词数不限，超预算就开新组。
  const groups: Array<Array<{ start: number; end: number; text: string }>> = [];
  let current: Array<{ start: number; end: number; text: string }> = [];
  let used = 0;
  for (const cue of sorted) {
    if (current.length > 0 && used + cue.text.length > chunkChars) {
      groups.push(current);
      current = [];
      used = 0;
    }
    current.push(cue);
    used += cue.text.length;
  }
  if (current.length > 0) groups.push(current);

  const chunks: AnalysisChunk[] = [];
  let start = 0;
  for (let index = 0; index < groups.length; index += 1) {
    const isLast = index === groups.length - 1;
    // 非最后一块的终点就是下一块首句起点：配合证据包的「非最后一块右开」，
    // 边界时刻与边界台词只属于下一块，相邻两轮不丢不重。
    // 最后一块直接取视频结尾，结尾前的弹幕全部归入。
    const boundary = isLast
      ? duration
      : Math.min(duration, groups[index + 1]?.[0]?.start ?? duration);
    // 台词时间戳可能并列（多条字幕同一秒）：保底块长为正，避免出现空块。
    const end = Math.max(boundary, start + 0.5);
    chunks.push({ index, start, end, cues: groups[index] ?? [] });
    start = end;
    if (end >= duration) break;
  }
  return chunks;
}
