/**
 * 后台在途 LLM 请求的中止登记表：
 * 内容脚本取消分析时只带 requestId 发一条 llm.abort，后台据此中断对应 fetch。
 */
export interface LlmAbortRegistry {
  /** 为一次请求登记 AbortController；同 id 重复登记时先中止旧请求。 */
  create(requestId: string): AbortController;
  /** 中止指定请求；id 不存在返回 false。 */
  abort(requestId: string): boolean;
  /** 请求结束后释放登记，避免长期驻留。 */
  release(requestId: string): void;
}

export function createLlmAbortRegistry(): LlmAbortRegistry {
  const controllers = new Map<string, AbortController>();
  return {
    create(requestId) {
      const existing = controllers.get(requestId);
      if (existing && !existing.signal.aborted) existing.abort();
      const controller = new AbortController();
      controllers.set(requestId, controller);
      return controller;
    },
    abort(requestId) {
      const controller = controllers.get(requestId);
      if (!controller) return false;
      controller.abort();
      return true;
    },
    release(requestId) {
      controllers.delete(requestId);
    }
  };
}
