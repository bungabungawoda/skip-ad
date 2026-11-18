import type { AnalysisWarning } from "./types";

/**
 * 「完整成功」判定：只有完整成功的结果才进缓存。
 * 失败、被取消、有分块被校验丢弃都会让结果不完整，写进去会让用户改好配置后
 * 仍然命中旧错误；没有任何证据的结果是阴性缓存，同样不写。
 * 两个站点分析器共用这一条规则，口径改动只改这里。
 */
export function isCompleteAnalysis(input: {
  durationSec: number;
  cancelled?: boolean;
  authFailed?: boolean;
  failedChunks: number;
  droppedChunks: number;
  hasEvidence: boolean;
}): boolean {
  return (
    input.durationSec > 0 &&
    input.cancelled !== true &&
    input.authFailed !== true &&
    input.failedChunks === 0 &&
    input.droppedChunks === 0 &&
    input.hasEvidence
  );
}

/** 结果里出现过失败或未读完的警告：界面要标「不完整」，不能当成「无广告」。 */
export function hasIncompleteWarnings(warnings: readonly AnalysisWarning[]): boolean {
  return warnings.some(
    (warning) => warning.code === "partial" || warning.code === "llm_failed"
  );
}
