import { describe, expect, it } from "vitest";
import { createMemoryStorageArea } from "../../../../tests/helpers/memory-storage";
import { createMetricsStore } from "../store";
import { EMPTY_SKIP_TOTALS } from "../types";

describe("跳过统计存储", () => {
  it("没有记录时读出全零", async () => {
    const store = createMetricsStore(createMemoryStorageArea());
    await expect(store.read()).resolves.toEqual(EMPTY_SKIP_TOTALS);
  });

  it("跳过与撤销分别累计", async () => {
    const store = createMetricsStore(createMemoryStorageArea());
    await store.recordSkip(30);
    await store.recordSkip(45.5);
    await store.recordUndo();

    await expect(store.read()).resolves.toEqual({
      skippedSegments: 2,
      savedSeconds: 75.5,
      undoCount: 1
    });
  });

  it("负数时长按零计，避免手改存储把累计值拉低", async () => {
    const store = createMetricsStore(createMemoryStorageArea());
    await store.recordSkip(-20);
    await expect(store.read()).resolves.toMatchObject({
      skippedSegments: 1,
      savedSeconds: 0
    });
  });

  it("存储里的坏字段按零处理", async () => {
    const area = createMemoryStorageArea();
    await area.set({
      "skipad-skip-totals": { skippedSegments: "x", savedSeconds: null, undoCount: -3 }
    });
    const store = createMetricsStore(area);
    await expect(store.read()).resolves.toEqual(EMPTY_SKIP_TOTALS);
  });

  it("清空后回到全零", async () => {
    const area = createMemoryStorageArea();
    const store = createMetricsStore(area);
    await store.recordSkip(10);
    await store.clear();
    await expect(store.read()).resolves.toEqual(EMPTY_SKIP_TOTALS);
    expect([...area.data.keys()]).toEqual([]);
  });

  it("并发写入不丢计数", async () => {
    const store = createMetricsStore(createMemoryStorageArea());
    await Promise.all([
      store.recordSkip(10),
      store.recordSkip(20),
      store.recordUndo(),
      store.recordSkip(30)
    ]);
    await expect(store.read()).resolves.toEqual({
      skippedSegments: 3,
      savedSeconds: 60,
      undoCount: 1
    });
  });
});
