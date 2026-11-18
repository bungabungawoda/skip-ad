import { describe, expect, it, vi } from "vitest";
import {
  CACHE_INDEX_KEY,
  CACHE_PREFIX,
  createStorageCache,
  makeCacheKey,
  type CacheEntry,
  type StorageAreaLike
} from "../store";
import type { AnalysisResult } from "../../../analysis/types";
import type { VideoKey } from "../../../plugin/types";

function result(bvid = "BV1"): AnalysisResult {
  const video: VideoKey = { site: "bilibili", videoId: bvid, partId: "1" };
  return {
    videoKey: bvid,
    video,
    mode: "full",
    segments: [],
    warnings: [],
    durationSec: 0
  };
}

function entry(createdAt = 0): CacheEntry {
  return { result: result(), createdAt };
}

describe("cache store", () => {
  it("builds stable cache keys", () => {
    expect(
      makeCacheKey({ key: { site: "bilibili", videoId: "BV1", partId: "2" }, analyzerId: "bilibili", analyzerVersion: "1", model: "m", promptVersion: "v1" })
    ).toBe("bilibili:BV1:2:bilibili:1:m:v1");
  });

  it("stores, deletes, and clears storage entries", async () => {
    const data = new Map<string, unknown>();
    const area: StorageAreaLike = {
      async get(keys) {
        if (keys === null) return Object.fromEntries(data);
        const list = Array.isArray(keys) ? keys : [keys ?? ""];
        return Object.fromEntries(list.filter((key) => data.has(key)).map((key) => [key, data.get(key)]));
      },
      async set(items) {
        for (const [key, value] of Object.entries(items)) data.set(key, value);
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
      }
    };
    const now = 0;
    const cache = createStorageCache(area, () => now);
    await cache.set("k", entry(now));
    expect(await cache.get("k")).not.toBeNull();
    await cache.delete("k");
    expect(await cache.get("k")).toBeNull();
    await cache.set("k2", entry(now));
    await cache.clear();
    expect(await cache.get("k2")).toBeNull();
  });

  it("缓存 5 分钟后过期", async () => {
    const data = new Map<string, unknown>();
    const area: StorageAreaLike = {
      async get(keys) {
        if (keys === null) return Object.fromEntries(data);
        const list = Array.isArray(keys) ? keys : [keys ?? ""];
        return Object.fromEntries(list.filter((key) => data.has(key)).map((key) => [key, data.get(key)]));
      },
      async set(items) {
        for (const [key, value] of Object.entries(items)) data.set(key, value);
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
      }
    };
    let now = 0;
    const cache = createStorageCache(area, () => now);
    await cache.set("k", entry(now));
    now = 5 * 60 * 1_000;
    expect(await cache.get("k")).not.toBeNull();
    now = 5 * 60 * 1_000 + 1;
    expect(await cache.get("k")).toBeNull();
  });
});

describe("缓存过期清理", () => {
  function areaOf(data: Map<string, unknown>): StorageAreaLike {
    return {
      async get(keys) {
        if (keys === null) return Object.fromEntries(data);
        const list = Array.isArray(keys) ? keys : [keys ?? ""];
        return Object.fromEntries(
          list.filter((key) => data.has(key)).map((key) => [key, data.get(key)])
        );
      },
      async set(items) {
        for (const [key, value] of Object.entries(items)) data.set(key, value);
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
      }
    };
  }

  it("写入时顺便清掉过期条目，不用等同键再读", async () => {
    const data = new Map<string, unknown>();
    const area = areaOf(data);
    let now = 0;
    const cache = createStorageCache(area, () => now);
    await cache.set("a", entry(now));
    now = 6 * 60 * 1_000;
    // 触发写入，让清理发生；"a" 从来没有被读过。
    await cache.set("b", entry(now));
    expect(data.has(`${CACHE_PREFIX}a`)).toBe(false);
    expect(data.has(`${CACHE_PREFIX}b`)).toBe(true);
  });

  it("trimExpired 只删索引里的过期项", async () => {
    const data = new Map<string, unknown>();
    const area = areaOf(data);
    let now = 0;
    const cache = createStorageCache(area, () => now);
    await cache.set("a", entry(now));
    now = 6 * 60 * 1_000;
    expect(await cache.trimExpired()).toBe(1);
    expect(data.has(`${CACHE_PREFIX}a`)).toBe(false);
    expect(data.get(CACHE_INDEX_KEY)).toEqual({});
    // 再清一次没有可删的。
    expect(await cache.trimExpired()).toBe(0);
  });

  it("没有索引时只按索引清理，不扫整个 storage 补建", async () => {
    const data = new Map<string, unknown>();
    data.set(`${CACHE_PREFIX}legacy`, entry(0));
    const area = areaOf(data);
    const cache = createStorageCache(area, () => 6 * 60 * 1_000);
    expect(await cache.trimExpired()).toBe(0);
    // 没有索引的遗留条目不动：清理只走索引，避免每次启动扫全部 storage。
    expect(data.has(`${CACHE_PREFIX}legacy`)).toBe(true);
    expect(data.has(CACHE_INDEX_KEY)).toBe(false);
  });

  it("清空会连索引一起删掉", async () => {
    const data = new Map<string, unknown>();
    const area = areaOf(data);
    const cache = createStorageCache(area, () => 0);
    await cache.set("a", entry(0));
    await cache.clear();
    expect([...data.keys()]).toEqual([]);
  });

  it("删除数据失败时保留索引，返回 false", async () => {
    const data = new Map<string, unknown>();
    const remove = vi.fn(async () => {
      throw new Error("storage 删除失败");
    });
    const areaWithFailure = { ...areaOf(data), remove };
    const cache = createStorageCache(areaWithFailure, () => 0);
    await cache.set("a", entry(0));
    await expect(cache.delete("a")).resolves.toBe(false);
    expect(data.get(CACHE_INDEX_KEY)).toEqual({ a: 0 });
    expect(data.has(`${CACHE_PREFIX}a`)).toBe(true);
  });

  it("清空失败时保留索引和数据", async () => {
    const data = new Map<string, unknown>();
    const remove = vi.fn(async () => {
      throw new Error("storage 清空失败");
    });
    const areaWithFailure = { ...areaOf(data), remove };
    const cache = createStorageCache(areaWithFailure, () => 0);
    await cache.set("a", entry(0));
    await expect(cache.clear()).resolves.toBe(false);
    expect(data.get(CACHE_INDEX_KEY)).toEqual({ a: 0 });
    expect(data.has(`${CACHE_PREFIX}a`)).toBe(true);
  });

  it("清理过期条目失败时保留索引，下一轮还能重试", async () => {
    const data = new Map<string, unknown>();
    let now = 0;
    const remove = vi.fn(async () => {
      throw new Error("storage 清理失败");
    });
    const cache = createStorageCache({ ...areaOf(data), remove }, () => now);
    await cache.set("a", entry(now));
    now = 6 * 60 * 1_000;
    await expect(cache.trimExpired()).resolves.toBe(0);
    expect(data.get(CACHE_INDEX_KEY)).toEqual({ a: 0 });
    expect(data.has(`${CACHE_PREFIX}a`)).toBe(true);
  });
});
