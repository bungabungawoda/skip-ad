import type { StorageAreaLike } from "../../src/core/ports/cache/store";

/** 测试用内存 storage：不进生产代码，供需要 CacheStore 的用例共享。 */
export function createMemoryStorageArea(): StorageAreaLike & {
  data: Map<string, unknown>;
} {
  const data = new Map<string, unknown>();
  return {
    data,
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
