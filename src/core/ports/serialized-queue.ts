/**
 * 把 storage 的「读整份 → 改一处 → 写回」排成一条队。
 *
 * 两个标签页同时写同一条键时，双方都读到旧值，后写的会覆盖先写的。
 * 队列保证一次只有一个读改写；前一个任务失败也不会卡住后面的任务，
 * 因为失败只落进内部的尾部 Promise，真正的错误仍然返回给调用方。
 */
export function createSerializedQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task, task);
    tail = next.catch(() => undefined);
    return next;
  };
}
