import { describe, expect, it } from "vitest";
import { createSerializedQueue } from "../serialized-queue";

function deferred(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("storage 读改写队列", () => {
  it("两个任务不交错：第二个等第一个写完才开始读", async () => {
    const queue = createSerializedQueue();
    const gate = deferred();
    const order: string[] = [];
    const writes: string[] = [];

    const first = queue(async () => {
      order.push("first:read");
      await gate.promise;
      writes.push("a");
      order.push("first:write");
      return writes.slice();
    });
    const second = queue(async () => {
      order.push("second:read");
      expect(writes).toEqual(["a"]);
      writes.push("b");
      order.push("second:write");
      return writes.slice();
    });

    gate.release();
    await expect(first).resolves.toEqual(["a"]);
    await expect(second).resolves.toEqual(["a", "b"]);
    expect(order).toEqual([
      "first:read",
      "first:write",
      "second:read",
      "second:write"
    ]);
  });

  it("前一个任务抛错不会让后面的任务跟着失败", async () => {
    const queue = createSerializedQueue();
    const failed = queue(async () => {
      throw new Error("storage 写失败");
    });
    await expect(failed).rejects.toThrow("storage 写失败");
    await expect(queue(async () => "still works")).resolves.toBe("still works");
  });
});
