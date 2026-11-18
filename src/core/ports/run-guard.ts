/**
 * 内容脚本的会话竞态守卫：把「这次异步回写还属不属于当前会话」
 * 集中成纯函数，避免 runToken 判断散落在各处、漏掉某一处就串台。
 */

export interface RunSnapshot {
  /** 当前会话的令牌，每次开始分析或取消分析都会自增。 */
  runToken: number;
  analyzing: boolean;
  cancelled: boolean;
  /** 发起分析时绑定的 video 元素；分 P 或 SPA 切换时可能复用同一个元素。 */
  video: unknown;
}

/** 异步结果能否写回当前会话：令牌一致、未取消、video 元素仍是同一个。 */
export function canApplyResult(state: RunSnapshot, token: number, video: unknown): boolean {
  return token === state.runToken && !state.cancelled && state.video === video;
}

/** 旧分析的 finally 只能清理自己那一轮，不能把新分析的 analyzing 标志抹掉。 */
export function shouldClearRun(state: RunSnapshot, token: number): boolean {
  return token === state.runToken;
}

interface StartAnalysisInput {
  analyzing: boolean;
  cancelled: boolean;
  resultPresent: boolean;
  nextAnalysisAt: number;
  now: number;
}

/** tick 到点是否要发起分析：正在跑、已取消、已有完整结果、未到退避时间都不发。 */
export function shouldStartAnalysis(input: StartAnalysisInput): boolean {
  if (input.analyzing || input.cancelled) return false;
  if (input.resultPresent) return false;
  return input.now >= input.nextAnalysisAt;
}
