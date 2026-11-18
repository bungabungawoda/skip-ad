import type { StorageAreaLike } from "../ports/cache/store";
import { createSerializedQueue } from "../ports/serialized-queue";
import { isRecord, readNumber } from "../lib/record";
import { logWarn } from "../lib/log";
import { errorText } from "../lib/error";
import { EMPTY_SKIP_TOTALS, type SkipTotals } from "./types";

const STATS_KEY = "skipad-skip-totals";

function readTotals(value: unknown): SkipTotals {
  if (!isRecord(value)) return { ...EMPTY_SKIP_TOTALS };
  return {
    skippedSegments: Math.max(0, readNumber(value.skippedSegments)),
    savedSeconds: Math.max(0, readNumber(value.savedSeconds)),
    undoCount: Math.max(0, readNumber(value.undoCount))
  };
}

export interface MetricsStore {
  read(): Promise<SkipTotals>;
  recordSkip(seconds: number): Promise<SkipTotals>;
  recordUndo(): Promise<SkipTotals>;
  clear(): Promise<void>;
}

/** 单键累计计数：读改写串行，避免两个标签页同时写时互相覆盖。 */
export function createMetricsStore(area: StorageAreaLike): MetricsStore {
  const serial = createSerializedQueue();

  const update = (change: (totals: SkipTotals) => SkipTotals): Promise<SkipTotals> =>
    serial(async () => {
      const stored = await area.get(STATS_KEY);
      const next = change(readTotals(stored[STATS_KEY]));
      await area.set({ [STATS_KEY]: next });
      return next;
    });

  return {
    async read() {
      try {
        const stored = await area.get(STATS_KEY);
        return readTotals(stored[STATS_KEY]);
      } catch (error) {
        logWarn("读取统计失败", errorText(error));
        return { ...EMPTY_SKIP_TOTALS };
      }
    },
    recordSkip(seconds) {
      return update((totals) => ({
        ...totals,
        skippedSegments: totals.skippedSegments + 1,
        savedSeconds: totals.savedSeconds + Math.max(0, seconds)
      }));
    },
    recordUndo() {
      return update((totals) => ({
        ...totals,
        undoCount: totals.undoCount + 1
      }));
    },
    async clear() {
      await serial(() => area.remove(STATS_KEY));
    }
  };
}
