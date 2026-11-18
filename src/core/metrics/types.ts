/** 本机累计的跳过统计；只保留用户能直接看懂的三项。 */
export interface SkipTotals {
  /** 累计跳过的广告段数，含自动跳、手动跳与平台广告。 */
  skippedSegments: number;
  /** 累计跳过的秒数，不扣撤销；撤销只单独计次。 */
  savedSeconds: number;
  /** 累计撤销次数。 */
  undoCount: number;
}

export const EMPTY_SKIP_TOTALS: SkipTotals = {
  skippedSegments: 0,
  savedSeconds: 0,
  undoCount: 0
};
