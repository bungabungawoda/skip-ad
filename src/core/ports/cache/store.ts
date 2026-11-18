import type { AnalysisResult } from "../../analysis/types";
import type { VideoKey } from "../../plugin/types";
import { videoKeyString } from "../../lib/video-key";
import { errorText } from "../../lib/error";
import { logWarn } from "../../lib/log";
import { createSerializedQueue } from "../serialized-queue";

export interface CacheEntry {
  result: AnalysisResult;
  createdAt: number;
}

export interface CacheStore {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, entry: CacheEntry): Promise<void>;
  /** 返回是否成功删掉缓存数据和索引；重新分析据此决定要不要继续。 */
  delete(key: string): Promise<boolean>;
  /** 返回是否成功清掉缓存数据和索引。 */
  clear(): Promise<boolean>;
  /**
   * 清掉过期的缓存条目，返回删掉的条数。
   * 由后台启动与每次写入后调用：过期条目不能只靠「同 key 再读一次」删除。
   */
  trimExpired(): Promise<number>;
}

const CACHE_TTL_MS = 5 * 60 * 1_000;
export const CACHE_PREFIX = "skipad-cache:";
/** 索引键：cacheKey → 创建时间。清理靠它，不必扫整个 storage。 */
export const CACHE_INDEX_KEY = "skipad-cache-index";

/**
 * 缓存键最终形态：
 * site / videoId / partId / analyzerId / analyzerVersion / model / promptVersion。
 * 用户改写的类型描述通过 effectivePromptVersion 折进 promptVersion。
 * 字幕与弹幕不参与键，5 分钟内的刷新按同一份证据处理。
 */
export function makeCacheKey(input: {
  key: VideoKey;
  analyzerId: string;
  analyzerVersion: string;
  model: string;
  promptVersion: string;
}): string {
  return `${videoKeyString(input.key)}:${input.analyzerId}:${input.analyzerVersion}:${input.model}:${input.promptVersion}`;
}

function isExpired(entry: CacheEntry, now: number, ttlMs = CACHE_TTL_MS): boolean {
  return !Number.isFinite(entry.createdAt) || now - entry.createdAt > ttlMs;
}

export interface StorageAreaLike {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { result?: unknown; createdAt?: unknown };
  return (
    typeof record.createdAt === "number" &&
    typeof record.result === "object" &&
    record.result !== null
  );
}

/** 索引必须是「cacheKey → 数字」的表才可信；坏了就按没有索引处理。 */
function readIndex(value: unknown): Record<string, number> | null {
  if (typeof value !== "object" || value === null) return null;
  const out: Record<string, number> = {};
  for (const [key, createdAt] of Object.entries(value as Record<string, unknown>)) {
    if (typeof createdAt !== "number") return null;
    out[key] = createdAt;
  }
  return out;
}

/**
 * 分析结果缓存：TTL 5 分钟，一条视频一个键。
 *
 * 过期条目除了「同 key 再读」也会在每次写入后与后台启动时批量清掉。
 * 写入时把 key 与创建时间一起记进一个小索引键，清理只读索引。
 */
export function createStorageCache(
  area: StorageAreaLike,
  now: () => number = Date.now,
  ttlMs = CACHE_TTL_MS
): CacheStore {
  const storageKey = (key: string): string => `${CACHE_PREFIX}${key}`;
  /** 索引的串行读改写：两个标签页同时写缓存时不能互相覆盖。 */
  const serialize = createSerializedQueue();
  /** 索引只在后台 Service Worker 里维护，一个进程一份内存副本。 */
  let index: Record<string, number> | null = null;

  const ensureIndex = async (): Promise<Record<string, number>> => {
    if (index) return index;
    const stored = await area.get(CACHE_INDEX_KEY);
    const parsed = readIndex(stored[CACHE_INDEX_KEY]);
    if (parsed) {
      index = parsed;
      return index;
    }
    index = {};
    return index;
  };

  const commitIndex = async (next: Record<string, number>): Promise<void> => {
    await area.set({ [CACHE_INDEX_KEY]: next });
    index = next;
  };

  const dropFromIndex = async (keys: string[]): Promise<void> => {
    const current = await ensureIndex();
    const next = { ...current };
    let changed = false;
    for (const key of keys) {
      if (key in next) {
        delete next[key];
        changed = true;
      }
    }
    if (changed) await commitIndex(next);
  };

  /** 按索引删过期条目；索引里没有的记录一律不动。 */
  const purgeExpired = async (): Promise<number> => {
    const current = await ensureIndex();
    const nowValue = now();
    const expired = Object.keys(current).filter((key) => {
      const createdAt = current[key];
      return !Number.isFinite(createdAt) || nowValue - (createdAt ?? 0) > ttlMs;
    });
    if (expired.length === 0) return 0;
    // 先删数据再改索引：删除失败时索引还在，下一轮还能重试。
    await area.remove(expired.map(storageKey));
    const next = { ...current };
    for (const key of expired) delete next[key];
    await commitIndex(next);
    return expired.length;
  };

  return {
    async get(key) {
      const cacheKey = storageKey(key);
      try {
        const stored = await area.get(cacheKey);
        const entry = stored[cacheKey];
        if (!isCacheEntry(entry)) return null;
        if (isExpired(entry, now(), ttlMs)) {
          await serialize(async () => {
            await area.remove(cacheKey);
            await dropFromIndex([key]);
          }).catch((error: unknown) => {
            logWarn("过期缓存清理失败", { cacheKey, error: errorText(error) });
          });
          return null;
        }
        return entry;
      } catch (error) {
        // 缓存是可选加速层：storage 不可用时按未命中处理，不能让分析整体失败。
        logWarn("缓存读取失败，按未命中继续", { cacheKey, error: errorText(error) });
        return null;
      }
    },
    async set(key, entry) {
      await serialize(async () => {
        try {
          const current = await ensureIndex();
          current[key] = entry.createdAt;
          // 条目与索引一次写入：两个键同一次 storage.set，不会只写一半。
          await area.set({ [storageKey(key)]: entry, [CACHE_INDEX_KEY]: current });
          // 写完顺手清一次过期条目：索引小，批量删除不会随缓存条数变贵。
          await purgeExpired();
        } catch (error) {
          logWarn("缓存写入失败，结果仍可用", {
            cacheKey: storageKey(key),
            error: errorText(error)
          });
        }
      });
    },
    async delete(key) {
      return serialize(async () => {
        try {
          await area.remove(storageKey(key));
          await dropFromIndex([key]);
          return true;
        } catch (error) {
          logWarn("缓存删除失败", { cacheKey: storageKey(key), error: errorText(error) });
          return false;
        }
      });
    },
    async clear() {
      return serialize(async () => {
        try {
          const current = await ensureIndex();
          const keys = [...Object.keys(current).map(storageKey), CACHE_INDEX_KEY];
          await area.remove(keys);
          index = {};
          return true;
        } catch (error) {
          logWarn("缓存清空失败", errorText(error));
          return false;
        }
      });
    },
    async trimExpired() {
      try {
        return await serialize(purgeExpired);
      } catch (error) {
        logWarn("缓存过期清理失败", errorText(error));
        return 0;
      }
    }
  };
}
