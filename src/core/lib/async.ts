export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 等待期间收到 abort 立即拒绝：否则服务端给一个很大的 Retry-After，
 * 用户取消后请求还挂在后台。
 */
export function sleepUnlessAborted(
  ms: number,
  signal: AbortSignal | undefined,
  options: {
    sleep?: (ms: number) => Promise<void>;
    onAbort: () => Error;
  }
): Promise<void> {
  const wait = options.sleep ?? sleep;
  if (!signal) return wait(ms);
  if (signal.aborted) return Promise.reject(options.onAbort());
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(options.onAbort());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    wait(ms).then(
      () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
